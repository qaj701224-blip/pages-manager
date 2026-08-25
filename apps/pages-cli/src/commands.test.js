import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeCommand } from './commands.js';

test('deploy requires positional dir and site, then creates and deploys with a CLI token', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', 'docs', '--visibility', 'internal'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'production' },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      { site: { id: 'site_1', slug: 'docs', environment: 'production', url: 'https://docs.pages.xd.team' } },
      {
        status: 200,
        headers: { 'X-Deployment-Trace-Id': 'dtr_cli_success' },
        body: {
          deployment: { id: 'dep_1', status: 'succeeded' },
          version: { id: 'ver_1' },
          route: { hostname: 'docs.pages.xd.team' },
        },
      },
    ]),
    idempotencyKey: () => 'idem_1',
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(await calls[0].json(), { slug: 'docs', visibility: 'internal' });
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(calls[1].headers.get('Authorization'), 'Bearer cli_token_secret');
  assert.equal(calls[1].headers.get('Idempotency-Key'), 'idem_1');
  assert.match(calls[1].headers.get('Content-Type'), /^multipart\/form-data; boundary=/);
  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.siteSlug, 'docs');
  assert.equal(metadata.source, 'cli');
  assert.equal(metadata.publishPlan.deploymentShape, 'assets-only');
  assert.equal(metadata.publishPlan.requestedFallback, 'none');
  assert.equal(metadata.publishPlan.resolvedFallback, 'none');
  assert.equal(metadata.publishPlan.routingMode, 'assets-only');
  assert.deepEqual(
    metadata.assetManifest.map((asset) => asset.path),
    ['/index.html']
  );
  assert.equal(deployForm.has('artifactKind'), false);
  assert.equal(deployForm.has('artifactBundle'), false);
  assert.equal(deployForm.has('assetManifest'), false);
  assert.equal(await deployForm.get(metadata.assetManifest[0].partName).text(), '<h1>Hello</h1>');
  assert.deepEqual(output, [
    '检查发布目录...',
    '检查发布目录完成：1 files / 14 B',
    '识别结果：静态资源目录',
    '找不到文件时：平台默认未命中处理',
    '准备凭证...',
    '准备站点...',
    '上传并发布...',
    '站点名：docs',
    '识别结果：静态资源目录',
    '找不到文件时：平台默认未命中处理',
    '部署：dep_1 succeeded',
    '追踪：dtr_cli_success',
    '发布完成：https://docs.pages.xd.team',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'vars'), false);
});

test('deploy supports publishing a site as a team owner', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  await executeCommand(['deploy', '.', 'docs', '--team', 'team_1', '--visibility', 'internal', '--json'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'production' },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      { site: { id: 'site_1', slug: 'docs', environment: 'production', url: 'https://docs.pages.xd.team' } },
      {
        deployment: { id: 'dep_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
        ownerTransfer: {
          siteSlug: 'docs',
          fromOwner: { type: 'user', id: 'usr_1' },
          toOwner: { type: 'team', id: 'team_1' },
          source: 'deploy',
        },
      },
    ]),
    idempotencyKey: () => 'idem_1',
    output: (line) => output.push(line),
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(await calls[0].json(), {
    slug: 'docs',
    visibility: 'internal',
    ownerType: 'team',
    teamId: 'team_1',
  });
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  const metadata = JSON.parse(await (await calls[1].formData()).get('metadata').text());
  assert.equal(metadata.siteSlug, 'docs');
  assert.equal(metadata.teamId, 'team_1');
  assert.deepEqual(JSON.parse(output[0]).ownerTransfer, {
    siteSlug: 'docs',
    fromOwner: { type: 'user', id: 'usr_1' },
    toOwner: { type: 'team', id: 'team_1' },
    source: 'deploy',
  });
});

test('teams lists current user teams so deploy can use the team id', async () => {
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['teams'], {
    env: { PAGES_CLI_ENV: 'production' },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      {
        teams: [
          {
            id: 'team_department_web',
            name: '心动/平台支撑部/Web',
            teamType: 'department',
            departmentPath: '心动/平台支撑部/Web',
            status: 'active',
            currentUserRole: 'admin',
            currentUserMembershipSource: 'department_auto',
          },
          {
            id: 'team_docs',
            name: 'Docs Team',
            teamType: 'custom',
            departmentPath: null,
            status: 'active',
            currentUserRole: 'publisher',
            currentUserMembershipSource: 'manual',
          },
        ],
      },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/teams');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer cli_token_secret');
  assert.deepEqual(output, [
    '团队 ID\t名称\t类型\t角色\t来源',
    'team_department_web\t心动/平台支撑部/Web\tdepartment\tadmin\tdepartment_auto',
    'team_docs\tDocs Team\tcustom\tpublisher\tmanual',
  ]);
});

test('teams supports JSON output for agents and scripts', async () => {
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['teams', '--json'], {
    env: { PAGES_CLI_ENV: 'production' },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      {
        teams: [
          {
            id: 'team_docs',
            name: 'Docs Team',
            teamType: 'custom',
            status: 'active',
            currentUserRole: 'publisher',
          },
        ],
      },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/teams');
  assert.deepEqual(JSON.parse(output.join('\n')), {
    ok: true,
    schemaVersion: 1,
    environment: 'production',
    teams: [
      {
        id: 'team_docs',
        name: 'Docs Team',
        teamType: 'custom',
        status: 'active',
        currentUserRole: 'publisher',
      },
    ],
  });
});

test('deploy rejects an explicitly empty team flag instead of falling back to config', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, 'xd-cell.config.json'), JSON.stringify({ name: 'docs', team: 'team_config' }));

  await assert.rejects(
    () =>
      executeCommand(['deploy', '.', 'docs', '--team=', '--dry-run'], {
        cwd: dir,
        output: () => {},
      }),
    { code: 'TEAM_INVALID' }
  );
});

test('deploy omits vars metadata when xd-cell.config.json does not declare vars', async () => {
  const dir = await tempProject();
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'dist', 'index.html'), '<h1>Hello</h1>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'docs',
      assets: { directory: './dist' },
    })
  );
  const calls = [];

  await executeCommand(['deploy', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' },
      },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
      },
    ]),
    output: () => {},
  });

  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'vars'), false);
});

test('deploy auto-discovers xd-cell.config.json and uploads vars metadata without leaking values in output', async () => {
  const dir = await tempProject();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export default { fetch() { return new Response("ok"); } };');
  await writeFile(path.join(dir, 'dist', 'index.html'), '<div id="app"></div>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'demo',
      main: './src/index.js',
      assets: {
        directory: './dist',
        not_found_handling: 'single-page-application',
      },
      vars: {
        API_BASE: 'https://api.example.com/private',
      },
      visibility: 'owner',
    })
  );
  const calls = [];
  const output = [];

  await executeCommand(['deploy', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    secretStore: {
      get: async () => {
        throw new Error('env token should avoid local secret reads');
      },
    },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' },
      },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'demo.pages.xd.team' },
      },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/auth/whoami');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer env_cli_token_secret');
  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.siteSlug, 'demo');
  assert.deepEqual(metadata.vars, { API_BASE: 'https://api.example.com/private' });
  assert.equal(metadata.publishPlan.deploymentShape, 'worker-with-assets');
  assert.equal(metadata.publishPlan.requestedFallback, 'single-page-application');
  assert.equal(metadata.publishPlan.resolvedFallback, 'index');
  assert.equal(metadata.workerMainModuleName, 'src/index.js');

  const body = JSON.parse(output.join('\n'));
  assert.equal(body.configPath, 'xd-cell.config.json');
  assert.equal(body.site, 'demo');
  assert.equal(body.target.source, './src/index.js');
  assert.equal(body.target.assets, './dist');
  assert.deepEqual(body.runtime, { vars: ['API_BASE'] });
  assertJsonLeafValueAbsent(body, 'https://api.example.com/private');
  assertJsonLeafValueAbsent(body, 'env_cli_token_secret');
});

test('deploy positional entry preserves configured assets and vars', async () => {
  const dir = await tempProject();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export default { fetch() { return new Response("old"); } };');
  await writeFile(path.join(dir, 'src', 'alt.js'), 'export default { fetch() { return new Response("new"); } };');
  await writeFile(path.join(dir, 'dist', 'index.html'), '<div id="app"></div>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'demo',
      main: './src/index.js',
      assets: {
        directory: './dist',
        not_found_handling: 'single-page-application',
      },
      vars: {
        API_BASE: 'https://api.example.com',
      },
    })
  );
  const calls = [];
  const output = [];

  await executeCommand(['deploy', './src/alt.js', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' },
      },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'demo.pages.xd.team' },
      },
    ]),
    output: (line) => output.push(line),
  });

  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.siteSlug, 'demo');
  assert.equal(metadata.publishPlan.deploymentShape, 'worker-with-assets');
  assert.equal(metadata.publishPlan.requestedFallback, 'single-page-application');
  assert.equal(metadata.publishPlan.resolvedFallback, 'index');
  assert.equal(metadata.workerMainModuleName, 'alt.js');
  assert.deepEqual(
    metadata.assetManifest.map((asset) => asset.path),
    ['/index.html']
  );
  assert.deepEqual(metadata.vars, { API_BASE: 'https://api.example.com' });

  const body = JSON.parse(output.join('\n'));
  assert.equal(body.target.source, './src/alt.js');
  assert.equal(body.target.assets, './dist');
  assert.deepEqual(body.runtime, { vars: ['API_BASE'] });
});

test('deploy positional worker entry preserves configured assets even when config has no main', async () => {
  const dir = await tempProject();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'src', 'worker.js'), 'export default { fetch() { return new Response("ok"); } };');
  await writeFile(path.join(dir, 'dist', 'index.html'), '<div id="app"></div>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'demo',
      assets: {
        directory: './dist',
        not_found_handling: 'single-page-application',
      },
      vars: {
        API_BASE: 'https://api.example.com',
      },
    })
  );
  const calls = [];

  await executeCommand(['deploy', './src/worker.js', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' },
      },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'demo.pages.xd.team' },
      },
    ]),
    output: () => {},
  });

  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.publishPlan.deploymentShape, 'worker-with-assets');
  assert.equal(metadata.workerMainModuleName, 'worker.js');
  assert.deepEqual(
    metadata.assetManifest.map((asset) => asset.path),
    ['/index.html']
  );
  assert.deepEqual(metadata.vars, { API_BASE: 'https://api.example.com' });
});

test('deploy treats a single positional argument as entry and requires site from config', async () => {
  const missingSite = await tempProject();
  await writeFile(path.join(missingSite, 'index.html'), '<h1>Hello</h1>');
  await assert.rejects(() => executeCommand(['deploy', 'demo', '--dry-run'], { cwd: missingSite, output: () => {} }), {
    code: 'SITE_REQUIRED',
  });

  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Root</h1>');
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'dist', 'index.html'), '<h1>Dist</h1>');
  await writeFile(path.join(dir, 'xd-cell.config.json'), JSON.stringify({ name: 'docs', assets: { directory: './missing' } }));
  const output = [];

  await executeCommand(['deploy', '.', '--dry-run', '--json'], {
    cwd: dir,
    output: (line) => output.push(line),
  });

  const body = JSON.parse(output.join('\n'));
  assert.equal(body.site, 'docs');
  assert.equal(body.target.source, '.');
  assert.equal(body.configPath, 'xd-cell.config.json');
});

test('deploy positional directory overrides configured worker with assets intent', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Root</h1>');
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'dist', 'index.html'), '<h1>Dist</h1>');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'index.js'), 'export default { fetch() { return new Response("ok"); } };');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'docs',
      main: './src/index.js',
      assets: { directory: './dist', not_found_handling: 'single-page-application' },
    })
  );
  const output = [];

  await executeCommand(['deploy', '.', '--dry-run', '--json'], {
    cwd: dir,
    output: (line) => output.push(line),
  });

  const body = JSON.parse(output.join('\n'));
  assert.equal(body.site, 'docs');
  assert.equal(body.target.source, '.');
  assert.equal(body.target.workerEntry, null);
  assert.equal(body.target.assets, undefined);
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.uploadPlanSummary.fileCount, 3);
});

test('deploy ignores legacy pages.config.json and explicit config does not merge with auto config', async () => {
  const dir = await tempProject();
  await mkdist(dir);
  await writeFile(path.join(dir, 'pages.config.json'), JSON.stringify({ site: 'legacy', source: './dist' }));
  const legacyOutput = [];
  await assert.rejects(
    () => executeCommand(['deploy', '--dry-run', '--json'], { cwd: dir, output: (line) => legacyOutput.push(line) }),
    {
      code: 'DIR_REQUIRED',
    }
  );

  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'auto-config',
      assets: { directory: './missing' },
    })
  );
  await writeFile(
    path.join(dir, 'deploy.config.json'),
    JSON.stringify({
      name: 'explicit-config',
      assets: { directory: './dist', not_found_handling: '404-page' },
    })
  );
  const explicitOutput = [];

  await executeCommand(['deploy', '--config', 'deploy.config.json', '--dry-run', '--json'], {
    cwd: dir,
    output: (line) => explicitOutput.push(line),
  });

  const body = JSON.parse(explicitOutput.join('\n'));
  assert.equal(body.site, 'explicit-config');
  assert.equal(body.target.source, './dist');
  assert.equal(body.decision.requestedFallback, '404-page');
  assert.equal(body.decision.resolvedFallback, 'not-found');
});

test('deploy rejects public fallback flag but allows unused assets-only vars', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  await assert.rejects(() => executeCommand(['deploy', '.', 'docs', '--fallback', 'spa'], { cwd: dir, output: () => {} }), {
    code: 'OPTION_UNSUPPORTED',
  });

  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({ name: 'docs', assets: { directory: '.' }, vars: { API_BASE: 'x' } })
  );
  const output = [];
  await executeCommand(['deploy', '--dry-run', '--json'], {
    cwd: dir,
    output: (line) => output.push(line),
  });
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.sideEffects.willDeploy, false);
  assert.deepEqual(body.runtime, { vars: [], ignoredVars: ['API_BASE'] });
  assert.equal(JSON.stringify(body).includes('"x"'), false);
});

test('assets-only deploy does not upload configured vars metadata and reports them as ignored', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({ name: 'docs', assets: { directory: '.' }, vars: { API_BASE: 'https://api.example.com' } })
  );
  const calls = [];
  const output = [];

  await executeCommand(['deploy', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' },
      },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
      },
    ]),
    output: (line) => output.push(line),
  });

  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.publishPlan.deploymentShape, 'assets-only');
  assert.equal(Object.prototype.hasOwnProperty.call(metadata, 'vars'), false);
  const body = JSON.parse(output.join('\n'));
  assert.deepEqual(body.runtime, { vars: [], ignoredVars: ['API_BASE'] });
  assertJsonLeafValueAbsent(body, 'https://api.example.com');
});

test('deploy token priority is --token then XD_CELL_API_TOKEN then local secret store', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const explicitCalls = [];
  const envCalls = [];

  await executeCommand(['deploy', '.', 'docs', '--token', 'explicit_token', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_token' },
    secretStore: {
      get: async () => {
        throw new Error('explicit token should avoid secret store');
      },
    },
    fetch: fakeFetch(explicitCalls, [
      { environment: 'production', actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' } },
      { deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} },
    ]),
    output: () => {},
  });
  await executeCommand(['deploy', '.', 'docs', '--json'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_token' },
    secretStore: {
      get: async () => {
        throw new Error('env token should avoid secret store');
      },
    },
    fetch: fakeFetch(envCalls, [
      { environment: 'production', actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' } },
      { deployment: { id: 'dep_2', status: 'succeeded' }, version: { id: 'ver_2' }, route: {} },
    ]),
    output: () => {},
  });

  assert.equal(explicitCalls[0].headers.get('Authorization'), 'Bearer explicit_token');
  assert.equal(explicitCalls[1].headers.get('Authorization'), 'Bearer explicit_token');
  assert.equal(envCalls[0].headers.get('Authorization'), 'Bearer env_token');
  assert.equal(envCalls[1].headers.get('Authorization'), 'Bearer env_token');
});

test('deploy supports hidden staging environment selection without exposing it in help', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const explicitCalls = [];
  const envCalls = [];
  const credentialLookups = [];

  await executeCommand(['deploy', '.', 'docs', '--env', 'staging', '--json'], {
    cwd: dir,
    env: {},
    secretStore: {
      get: async (environment) => {
        credentialLookups.push(environment);
        return { type: 'cli_token', value: 'staging_cli_token' };
      },
    },
    fetch: fakeFetch(explicitCalls, [
      { site: { id: 'site_1', slug: 'docs', environment: 'staging' } },
      { deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} },
    ]),
    output: () => {},
  });
  await executeCommand(['deploy', '.', 'docs', '--json'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'staging' },
    secretStore: {
      get: async (environment) => {
        credentialLookups.push(environment);
        return { type: 'cli_token', value: 'env_staging_cli_token' };
      },
    },
    fetch: fakeFetch(envCalls, [
      { site: { id: 'site_1', slug: 'docs', environment: 'staging' } },
      { deployment: { id: 'dep_2', status: 'succeeded' }, version: { id: 'ver_2' }, route: {} },
    ]),
    output: () => {},
  });

  assert.deepEqual(credentialLookups, ['staging', 'staging']);
  assert.equal(explicitCalls[0].url, 'https://api-staging.pages.xd.team/.xd-pages/api/sites');
  assert.equal(explicitCalls[1].url, 'https://api-staging.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(envCalls[0].url, 'https://api-staging.pages.xd.team/.xd-pages/api/sites');
  assert.equal(envCalls[1].url, 'https://api-staging.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(explicitCalls[1].headers.get('Authorization'), 'Bearer staging_cli_token');
  assert.equal(envCalls[1].headers.get('Authorization'), 'Bearer env_staging_cli_token');

  await assert.rejects(() => executeCommand(['deploy', '.', 'docs', '--env', 'custom'], { output: () => {} }), {
    code: 'ENVIRONMENT_INVALID',
  });
});

test('API commands default to production without reading profile or environment env vars', async () => {
  const calls = [];
  const output = [];

  await executeCommand(['sites', '--json'], {
    env: { PAGES_CLI_ENV: 'staging', PAGES_ENV: 'staging' },
    profile: { activeEnvironment: 'staging', environments: {} },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [{ sites: [] }]),
    output: (line) => output.push(line),
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.equal(JSON.parse(output.join('\n')).environment, 'production');
});

test('whoami uses XD_CELL_API_TOKEN while auth status ignores it', async () => {
  const calls = [];
  const whoamiOutput = [];
  const statusOutput = [];

  await executeCommand(['whoami', '--json'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    profile: productionProfile(),
    secretStore: {
      get: async () => {
        throw new Error('whoami should use env token');
      },
    },
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: { type: 'user', credentialType: 'cli_token', userId: 'usr_1' },
      },
    ]),
    output: (line) => whoamiOutput.push(line),
  });

  await executeCommand(['auth', 'status', '--json'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    profile: productionProfile(),
    secretStore: { get: async () => null },
    output: (line) => statusOutput.push(line),
  });

  assert.equal(calls[0].headers.get('Authorization'), 'Bearer env_cli_token_secret');
  assert.equal(JSON.parse(whoamiOutput[0]).actor.userId, 'usr_1');
  assert.deepEqual(JSON.parse(statusOutput[0]), {
    ok: true,
    schemaVersion: 1,
    environment: 'production',
    authenticated: false,
    credentialType: null,
  });
});

test('secrets put and delete use site-level secret APIs without accepting value positionals or list', async () => {
  const putCalls = [];
  const deleteCalls = [];
  const putOutput = [];
  const deleteOutput = [];

  await executeCommand(['secrets', 'put', 'demo', 'API_TOKEN', '--stdin', '--json'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    stdin: { text: async () => 'super-secret-value\n' },
    fetch: fakeFetch(putCalls, [{ secret: { site: 'demo', name: 'API_TOKEN', updated: true } }]),
    output: (line) => putOutput.push(line),
  });
  await executeCommand(['secrets', 'delete', 'demo', 'API_TOKEN', '--json'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(deleteCalls, [{ secret: { site: 'demo', name: 'API_TOKEN', deleted: true } }]),
    output: (line) => deleteOutput.push(line),
  });

  assert.equal(putCalls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites/demo/secrets');
  assert.equal(putCalls[0].method, 'PUT');
  assert.equal(putCalls[0].headers.get('Authorization'), 'Bearer env_cli_token_secret');
  assert.deepEqual(await putCalls[0].json(), { name: 'API_TOKEN', value: 'super-secret-value' });
  assert.equal(putOutput.join('\n').includes('super-secret-value'), false);
  assert.deepEqual(JSON.parse(putOutput[0]), {
    ok: true,
    schemaVersion: 1,
    type: 'secret',
    environment: 'production',
    site: 'demo',
    name: 'API_TOKEN',
    operation: 'put',
  });

  assert.equal(deleteCalls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites/demo/secrets');
  assert.equal(deleteCalls[0].method, 'DELETE');
  assert.deepEqual(await deleteCalls[0].json(), { name: 'API_TOKEN' });
  assert.equal(JSON.parse(deleteOutput[0]).operation, 'delete');

  const deleteTextOutput = [];
  await executeCommand(['secrets', 'delete', 'demo', 'API_TOKEN'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch([], [{ secret: { site: 'demo', name: 'API_TOKEN', deleted: true } }]),
    output: (line) => deleteTextOutput.push(line),
  });
  assert.deepEqual(deleteTextOutput, ['已删除 secret：demo/API_TOKEN']);

  await assert.rejects(
    () =>
      executeCommand(['secrets', 'put', 'demo', 'API_TOKEN', 'secret-value'], {
        env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
        output: () => {},
      }),
    { code: 'SECRETS_PUT_USAGE_INVALID' }
  );
  await assert.rejects(() => executeCommand(['secrets', 'list', 'demo'], { output: () => {} }), {
    code: 'SECRETS_COMMAND_INVALID',
  });
});

test('secrets commands reject empty site names before reading values', async () => {
  await assert.rejects(
    () =>
      executeCommand(['secrets', 'put', '', 'API_TOKEN', '--stdin'], {
        stdin: {
          text: async () => {
            throw new Error('stdin should not be read for invalid site');
          },
        },
        fetch: fakeFetch([], [{ ok: true }]),
        output: () => {},
      }),
    { code: 'SITE_REQUIRED' }
  );
  await assert.rejects(
    () =>
      executeCommand(['secrets', 'delete', '', 'API_TOKEN'], {
        fetch: fakeFetch([], [{ ok: true }]),
        output: () => {},
      }),
    { code: 'SITE_REQUIRED' }
  );
});

test('deploy uses explicit token as a one-shot credential without local secret reads', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  await executeCommand(['deploy', '.', 'docs', '--token', 'xdp_prod_ak_1_secret', '--visibility', 'internal', '--json'], {
    cwd: dir,
    env: {},
    profile: productionProfile(),
    secretStore: {
      get: async () => {
        throw new Error('secret store should not be read');
      },
      set: async () => {
        throw new Error('secret store should not be written');
      },
    },
    fetch: fakeFetch(calls, [
      { environment: 'production', actor: { type: 'access_key', credentialType: 'access_key', siteId: 'site_1' } },
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
      },
    ]),
    idempotencyKey: () => 'idem_1',
    output: (line) => output.push(line),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/auth/whoami');
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(calls[1].headers.get('Authorization'), 'Bearer xdp_prod_ak_1_secret');
  const metadata = JSON.parse(await (await calls[1].formData()).get('metadata').text());
  assert.equal(metadata.siteSlug, 'docs');
  assert.equal(metadata.visibility, 'internal');
  assert.equal(metadata.publishPlan.deploymentShape, 'assets-only');
  assert.deepEqual(JSON.parse(output.join('\n')), {
    ok: true,
    schemaVersion: 1,
    type: 'deploy',
    mode: 'deploy',
    environment: 'production',
    site: 'docs',
    configPath: null,
    target: {
      source: '.',
      kind: 'entry',
      requestedFallback: 'none',
      workerEntry: null,
    },
    decision: {
      deploymentShape: 'assets-only',
      requestedFallback: 'none',
      resolvedFallback: 'none',
      routingMode: 'assets-only',
      confidence: 'high',
      source: 'explicit',
    },
    uploadPlanSummary: {
      contentHash: metadata.contentHash,
      fileCount: 1,
      sizeBytes: 14,
      assetControlFilesExcluded: [],
    },
    checks: {
      localDetectionPassed: true,
      packageChecked: true,
      canPackage: true,
      remoteChecked: true,
      canDeploy: true,
      canDeployScope: 'remote-deploy',
    },
    sideEffects: {
      willDeploy: true,
      siteCreated: false,
      deploymentCreated: true,
      filesUploaded: true,
      routeChanged: true,
    },
    signals: [{ code: 'ROOT_INDEX_HTML_FOUND', path: 'index.html' }, { code: 'SINGLE_HTML_ENTRY' }],
    diagnostics: {
      warnings: [],
      errors: [],
    },
    runtime: {
      vars: [],
    },
    deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
    version: { id: 'ver_1' },
    route: { hostname: 'docs.pages.xd.team' },
    url: 'https://docs.pages.xd.team',
  });
});

test('deploy keeps --access-key as a hidden compatibility alias', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];

  await executeCommand(['deploy', '.', 'docs', '--access-key', 'xdp_legacy_ak_1_secret', '--json'], {
    cwd: dir,
    env: {},
    profile: productionProfile(),
    fetch: fakeFetch(calls, [
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
      },
    ]),
    output: () => {},
  });

  assert.equal(calls[0].headers.get('Authorization'), 'Bearer xdp_legacy_ak_1_secret');
});

test('detect --json is local-only and emits resolved decision without upload plan', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const output = [];

  const exitCode = await executeCommand(['detect', '.', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('detect should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('detect should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'detect');
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.decision.requestedFallback, 'none');
  assert.equal(body.decision.resolvedFallback, 'none');
  assert.equal(body.checks.packageChecked, false);
  assert.equal(body.checks.canPackage, null);
  assert.equal(body.sideEffects.willDeploy, false);
  assert.equal('uploadPlanSummary' in body, false);
  assert.equal('artifactKind' in body, false);
});

test('detect ignores legacy pages.config.json and can use xd-cell.config.json without network side effects', async () => {
  const dir = await tempProject();
  await mkdist(dir);
  await writeFile(
    path.join(dir, 'pages.config.json'),
    JSON.stringify({
      site: 'from-config',
      source: './dist',
      fallback: 'not-found',
    })
  );
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'from-config',
      assets: { directory: './dist', not_found_handling: '404-page' },
    })
  );
  const output = [];

  const exitCode = await executeCommand(['detect', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('detect should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('detect should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.target.source, './dist');
  assert.equal(body.configPath, 'xd-cell.config.json');
  assert.equal(body.decision.requestedFallback, '404-page');
  assert.equal(body.decision.resolvedFallback, 'not-found');
  assert.equal('uploadPlanSummary' in body, false);
});

test('deploy --dry-run --json packages locally without network side effects', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', 'docs', '--dry-run', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('dry-run should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('dry-run should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.mode, 'dry-run');
  assert.equal(body.site, 'docs');
  assert.equal(body.checks.packageChecked, true);
  assert.equal(body.checks.canPackage, true);
  assert.equal(body.checks.remoteChecked, false);
  assert.equal(body.checks.canDeploy, null);
  assert.equal(body.sideEffects.willDeploy, false);
  assert.equal(body.uploadPlanSummary.fileCount, 1);
  assert.equal('artifactKind' in body, false);
});

test('deploy --dry-run --json includes selected team id in preflight output', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', 'docs', '--team', 'team_docs', '--dry-run', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('dry-run should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('dry-run should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.mode, 'dry-run');
  assert.equal(body.site, 'docs');
  assert.equal(body.teamId, 'team_docs');
});

test('deploy dry-run validates visibility and team constraints before reporting success', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const context = {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('dry-run should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('dry-run should not access network');
    },
    output: () => {},
  };

  await assert.rejects(() => executeCommand(['deploy', '.', 'docs', '--visibility', 'public', '--dry-run'], context), {
    code: 'SITE_VISIBILITY_INVALID',
  });
  await assert.rejects(
    () => executeCommand(['deploy', '.', 'docs', '--team', 'team_docs', '--visibility', 'owner', '--dry-run'], context),
    { code: 'SITE_VISIBILITY_INVALID' }
  );
});

test('deploy auto-discovers xd-cell.config.json for dry-run without network side effects', async () => {
  const dir = await tempProject();
  await mkdist(dir);
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'from-config',
      assets: { directory: './dist', not_found_handling: '404-page' },
    })
  );
  const output = [];

  const exitCode = await executeCommand(['deploy', '--dry-run', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('dry-run should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('dry-run should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.site, 'from-config');
  assert.equal(body.target.source, './dist');
  assert.equal(body.decision.requestedFallback, '404-page');
  assert.equal(body.decision.resolvedFallback, 'not-found');
  assert.equal(body.uploadPlanSummary.fileCount, 1);
  assert.equal('artifactKind' in body, false);
});

test('deploy reads explicit one-shot command config and lets CLI args override it', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'from-config',
      assets: { directory: './dist', not_found_handling: '404-page' },
      visibility: 'org',
    })
  );
  await mkdist(dir);
  const calls = [];

  await executeCommand(['deploy', './dist', 'from-args', '--config', 'xd-cell.config.json', '--visibility', 'owner'], {
    cwd: dir,
    env: {},
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      { site: { id: 'site_1', slug: 'from-args', environment: 'production' } },
      { deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} },
    ]),
    output: () => {},
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(await calls[0].json(), { slug: 'from-args', visibility: 'owner' });
  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.siteSlug, 'from-args');
  assert.equal(metadata.publishPlan.resolvedFallback, 'not-found');
  assert.equal(deployForm.has('artifactKind'), false);
});

test('explicit --config does not merge with auto-discovered xd-cell.config.json', async () => {
  const dir = await tempProject();
  await mkdist(dir);
  await writeFile(
    path.join(dir, 'xd-cell.config.json'),
    JSON.stringify({
      name: 'auto-config',
      assets: { directory: './missing', not_found_handling: '404-page' },
    })
  );
  await writeFile(
    path.join(dir, 'deploy.config.json'),
    JSON.stringify({
      name: 'explicit-config',
      assets: { directory: './dist' },
    })
  );
  const output = [];

  await executeCommand(['deploy', '--config', 'deploy.config.json', '--dry-run', '--json'], {
    cwd: dir,
    output: (line) => output.push(line),
  });

  const body = JSON.parse(output.join('\n'));
  assert.equal(body.site, 'explicit-config');
  assert.equal(body.target.source, './dist');
  assert.equal(body.decision.requestedFallback, 'none');
  assert.equal(body.decision.resolvedFallback, 'none');
});

test('rejects removed project binding flags and invalid visibility', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  await assert.rejects(
    () => executeCommand(['deploy', '.', 'docs', ['--slu', 'g'].join(''), 'old'], { cwd: dir, output: () => {} }),
    { code: 'OPTION_UNSUPPORTED' }
  );
  await assert.rejects(
    () =>
      executeCommand(['deploy', '.', 'docs', '--visibility', 'public'], {
        cwd: dir,
        secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
        output: () => {},
      }),
    { code: 'SITE_VISIBILITY_INVALID' }
  );
});

test('status, sites, and open use explicit site names', async () => {
  const dir = await tempProject();
  const calls = [];
  const output = [];

  await executeCommand(['status', 'docs', '--json'], {
    cwd: dir,
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'access_key', value: 'xdp_prod_ak_1_secret' }),
    fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'docs', environment: 'production' }] }]),
    output: (line) => output.push(line),
  });
  const siteInfoOutput = [];
  await executeCommand(['sites', 'info', 'docs'], {
    cwd: dir,
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'access_key', value: 'xdp_prod_ak_1_secret' }),
    fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'docs', environment: 'production' }] }]),
    output: (line) => siteInfoOutput.push(line),
  });
  const openOutput = [];
  await executeCommand(['open', 'docs', '--env', 'staging', '--print'], {
    cwd: dir,
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        sites: [
          {
            id: 'site_2',
            slug: 'docs',
            environment: 'staging',
            url: 'https://docs-staging.pages.xd.team',
            route: { hostname: 'docs-staging.pages.xd.team' },
          },
        ],
      },
    ]),
    output: (line) => openOutput.push(line),
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(JSON.parse(output[0]).site, { id: 'site_1', slug: 'docs', environment: 'production' });
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.match(siteInfoOutput.join('\n'), /站点名：docs/);
  assert.equal(calls[2].url, 'https://api-staging.pages.xd.team/.xd-pages/api/sites');
  assert.equal(calls[2].headers.get('Authorization'), 'Bearer env_cli_token_secret');
  assert.deepEqual(openOutput, ['https://docs-staging.pages.xd.team']);
});

test('open preserves the API route hostname instead of fabricating a default site suffix', async () => {
  const calls = [];
  const output = [];

  await executeCommand(['open', 'docs', '--print'], {
    env: { XD_CELL_API_TOKEN: 'env_cli_token_secret' },
    fetch: fakeFetch(calls, [
      {
        sites: [
          {
            id: 'site_1',
            slug: 'docs',
            environment: 'production',
            route: { hostname: 'docs.pages.xd.team' },
          },
        ],
      },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer env_cli_token_secret');
  assert.deepEqual(output, ['https://docs.pages.xd.team']);
});

test('rollback is not supported by the public CLI', async () => {
  const dir = await tempProject();
  const calls = [];

  await assert.rejects(
    () =>
      executeCommand(['rollback', 'docs', 'ver_1'], {
        cwd: dir,
        env: {},
        profile: productionProfile(),
        secretStore: fakeSecretStore({ type: 'access_key', value: 'xdp_prod_ak_1_secret' }),
        fetch: fakeFetch(calls, [{ deployment: { id: 'dep_2', status: 'succeeded' } }]),
        output: () => {},
      }),
    { code: 'COMMAND_UNSUPPORTED' }
  );
  await assert.rejects(() => executeCommand(['help', 'rollback'], { cwd: dir, output: () => {} }), {
    code: 'COMMAND_UNSUPPORTED',
  });
  assert.equal(calls.length, 0);
});

test('sites list defaults to a summary and supports detailed JSON', async () => {
  const sites = [
    {
      id: 'site_1',
      slug: 'docs',
      environment: 'production',
      defaultVisibility: 'org',
      url: 'https://docs.pages.xd.team',
      route: {
        id: 'route_1',
        hostname: 'docs.pages.xd.team',
        status: 'active',
        runtime: 'worker',
        activeVersionId: 'ver_1',
        visibility: 'org',
      },
      createdAt: '2026-06-17T00:00:00.000Z',
    },
  ];
  const summaryOutput = [];
  const summaryJsonOutput = [];
  const detailsJsonOutput = [];

  await executeCommand(['sites'], {
    env: {},
    profile: { activeEnvironment: 'staging', environments: {} },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch([], [{ sites }]),
    output: (line) => summaryOutput.push(line),
  });
  await executeCommand(['sites', '--json'], {
    env: {},
    profile: { activeEnvironment: 'staging', environments: {} },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch([], [{ sites }]),
    output: (line) => summaryJsonOutput.push(line),
  });
  await executeCommand(['sites', '--details', '--json'], {
    env: {},
    profile: { activeEnvironment: 'staging', environments: {} },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch([], [{ sites }]),
    output: (line) => detailsJsonOutput.push(line),
  });

  assert.match(summaryOutput.join('\n'), /站点名\s+环境\s+访问范围\s+状态\s+URL/);
  assert.match(summaryOutput.join('\n'), /docs\s+production\s+org\s+active\s+https:\/\/docs\.pages\.xd\.team/);
  assert.doesNotMatch(summaryOutput.join('\n'), /route_1/);

  assert.deepEqual(JSON.parse(summaryJsonOutput.join('\n')), {
    ok: true,
    schemaVersion: 1,
    environment: 'production',
    sites: [
      {
        site: 'docs',
        environment: 'production',
        visibility: 'org',
        status: 'active',
        url: 'https://docs.pages.xd.team',
      },
    ],
  });
  assert.match(summaryJsonOutput.join('\n'), /\n {2}"sites": \[/);

  assert.equal(JSON.parse(detailsJsonOutput.join('\n')).sites[0].route.id, 'route_1');
});

test('sites delete resolves the slug and deletes the returned site id with --yes', async () => {
  const calls = [];
  const output = [];

  await executeCommand(['sites', 'delete', 'demo', '--yes', '--json'], {
    env: { XD_CELL_API_TOKEN: 'token' },
    fetch: fakeFetch(calls, [
      { sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] },
      { site: { id: 'site_1', slug: 'demo', deletedAt: '2026-07-14T00:00:00.000Z' } },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1');
  assert.deepEqual(JSON.parse(output[0]), {
    ok: true,
    schemaVersion: 1,
    type: 'site',
    environment: 'production',
    site: 'demo',
    operation: 'delete',
    deleted: true,
  });
});

test('sites delete accepts y or yes and cancels other interactive answers', async () => {
  for (const answer of ['y', 'YES']) {
    const calls = [];
    const prompts = [];
    const output = [];

    await executeCommand(['sites', 'delete', 'demo'], {
      env: { XD_CELL_API_TOKEN: 'token' },
      stdin: { isTTY: true },
      readConfirmation: async (prompt) => {
        prompts.push(prompt);
        return answer;
      },
      fetch: fakeFetch(calls, [
        { sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] },
        { site: { id: 'site_1', slug: 'demo', deletedAt: '2026-07-14T00:00:00.000Z' } },
      ]),
      output: (line) => output.push(line),
    });

    assert.deepEqual(prompts, ['确认删除站点 "demo"? (y/N) ']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, 'DELETE');
    assert.deepEqual(output, ['已删除站点：demo']);
  }

  const calls = [];
  const prompts = [];
  const output = [];
  await executeCommand(['sites', 'delete', 'demo'], {
    env: { XD_CELL_API_TOKEN: 'token' },
    stdin: { isTTY: true },
    readConfirmation: async (prompt) => {
      prompts.push(prompt);
      return 'n';
    },
    fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] }]),
    output: (line) => output.push(line),
  });

  assert.deepEqual(prompts, ['确认删除站点 "demo"? (y/N) ']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.deepEqual(output, ['已取消删除站点：demo']);
});

test('sites delete requires --yes for JSON and non-interactive use', async () => {
  const cases = [
    {
      argv: ['sites', 'delete', 'demo', '--json'],
      stdin: { isTTY: true },
      readConfirmation: async () => 'y',
    },
    {
      argv: ['sites', 'delete', 'demo'],
      stdin: { isTTY: false },
      readConfirmation: async () => 'y',
    },
    {
      argv: ['sites', 'delete', 'demo'],
      stdin: { isTTY: true },
    },
  ];

  for (const current of cases) {
    const calls = [];
    await assert.rejects(
      () =>
        executeCommand(current.argv, {
          env: { XD_CELL_API_TOKEN: 'token' },
          stdin: current.stdin,
          readConfirmation: current.readConfirmation,
          fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] }]),
          output: () => {},
        }),
      { code: 'SITE_DELETE_CONFIRMATION_REQUIRED' }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
  }
});

test('sites subcommands validate their flags before resolving credentials', async () => {
  const cases = [
    { argv: ['sites', 'list', '--yes'], code: 'SITES_LIST_USAGE_INVALID' },
    { argv: ['sites', 'info', 'demo', '--yes'], code: 'SITES_INFO_USAGE_INVALID' },
    { argv: ['sites', 'delete', 'demo', '--details'], code: 'SITES_DELETE_USAGE_INVALID' },
  ];

  for (const current of cases) {
    await assert.rejects(() => executeCommand(current.argv, { env: {}, profile: { environments: {} }, output: () => {} }), {
      code: current.code,
    });
  }

  await assert.rejects(
    () => executeCommand(['sites', 'remove', 'demo'], { env: {}, profile: { environments: {} }, output: () => {} }),
    {
      code: 'SITES_COMMAND_INVALID',
      action: '请使用 xd-cell sites list、xd-cell sites info <站点名> 或 xd-cell sites delete <站点名>。',
    }
  );
});

test('sites delete does not send DELETE when the slug is missing or deletion is forbidden', async () => {
  const missingCalls = [];
  await assert.rejects(
    () =>
      executeCommand(['sites', 'delete', 'missing', '--yes'], {
        env: { XD_CELL_API_TOKEN: 'token' },
        fetch: fakeFetch(missingCalls, [{ sites: [] }]),
        output: () => {},
      }),
    { code: 'SITE_NOT_FOUND' }
  );
  assert.equal(missingCalls.length, 1);
  assert.equal(missingCalls[0].method, 'GET');

  const forbiddenCalls = [];
  const output = [];
  await assert.rejects(
    () =>
      executeCommand(['sites', 'delete', 'demo', '--yes'], {
        env: { XD_CELL_API_TOKEN: 'token' },
        fetch: fakeFetch(forbiddenCalls, [
          { sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] },
          { status: 403, body: { error: { code: 'SITE_POLICY_FORBIDDEN', message: 'forbidden' } } },
        ]),
        output: (line) => output.push(line),
      }),
    { code: 'SITE_POLICY_FORBIDDEN' }
  );
  assert.equal(forbiddenCalls.length, 2);
  assert.equal(forbiddenCalls[1].method, 'DELETE');
  assert.deepEqual(output, []);
});

test('site lookup suggests the closest slug when a name is mistyped', async () => {
  await assert.rejects(
    () =>
      executeCommand(['sites', 'info', 'xtq-html-test'], {
        env: {},
        profile: { activeEnvironment: 'staging', environments: {} },
        secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
        fetch: fakeFetch([], [{ sites: [{ id: 'site_1', slug: 'xtq-hml-test', environment: 'staging' }] }]),
        output: () => {},
      }),
    {
      code: 'SITE_NOT_FOUND',
      action: '未找到 xtq-html-test。你是不是想查看 xtq-hml-test？站点也可能已改名，请运行 xd-cell sites list 查看当前站点名。',
    }
  );
});

test('status and logout can target an environment without switching profile', async () => {
  const deleted = [];
  const statusOutput = [];

  await executeCommand(['status', '--env', 'staging', '--json'], {
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'staging_cli_token' }),
    output: (line) => statusOutput.push(line),
  });
  await executeCommand(['logout', '--env', 'staging'], {
    env: {},
    profile: productionProfile(),
    profileDir: await tempProject(),
    secretStore: {
      get: async () => null,
      set: async () => {},
      delete: async (environment) => deleted.push(environment),
    },
    output: () => {},
  });

  assert.deepEqual(JSON.parse(statusOutput.join('\n')), {
    ok: true,
    schemaVersion: 1,
    environment: 'staging',
    authenticated: true,
    credentialType: 'cli_token',
  });
  assert.deepEqual(deleted, ['staging']);
});

test('whoami uses API validation and env command is not user-facing', async () => {
  const calls = [];
  const output = [];
  const envOutput = [];
  const listOutput = [];
  const profileDir = await tempProject();

  await executeCommand(['whoami', '--token', 'xdp_prod_ak_1_secret', '--json'], {
    env: {},
    profile: productionProfile(),
    fetch: fakeFetch(calls, [
      {
        environment: 'production',
        actor: {
          type: 'access_key',
          credentialType: 'access_key',
          accessKeyId: 'ak_1',
          userId: 'usr_1',
          email: 'user@example.com',
          name: 'User One',
          scopes: ['deploy:site'],
        },
      },
    ]),
    output: (line) => output.push(line),
  });
  await executeCommand(['env', 'current', '--json'], {
    env: { PAGES_CLI_ENV: 'staging' },
    output: (line) => envOutput.push(line),
  });
  await executeCommand(['env', 'list', '--json'], {
    output: (line) => listOutput.push(line),
  });
  await executeCommand(['env', 'use', 'staging', '--json'], {
    env: {},
    profile: productionProfile(),
    profileDir,
    output: (line) => envOutput.push(line),
  });
  await assert.rejects(() => executeCommand(['help', 'env'], { output: () => {} }), {
    code: 'COMMAND_UNSUPPORTED',
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/auth/whoami');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer xdp_prod_ak_1_secret');
  assert.equal(JSON.parse(output[0]).actor.accessKeyId, 'ak_1');
  assert.equal(JSON.parse(output[0]).actor.email, 'user@example.com');
  assert.equal(JSON.parse(output[0]).actor.name, 'User One');
  assert.equal(JSON.parse(envOutput[0]).activeEnvironment, 'staging');
  assert.equal(JSON.parse(envOutput[0]).source, 'env:PAGES_CLI_ENV');
  assert.deepEqual(JSON.parse(listOutput[0]).environments, ['production', 'staging']);
  assert.equal(JSON.parse(envOutput[1]).activeEnvironment, 'staging');
  await assert.rejects(() => executeCommand(['env', 'use', 'custom'], { output: () => {} }), {
    code: 'ENVIRONMENT_INVALID',
  });
});

test('auth subcommands remain as hidden compatibility aliases', async () => {
  const deleted = [];
  const output = [];

  await executeCommand(['auth', 'whoami', '--access-key', 'xdp_prod_ak_1_secret', '--json'], {
    env: {},
    profile: productionProfile(),
    fetch: fakeFetch(
      [],
      [
        {
          environment: 'production',
          actor: { type: 'access_key', credentialType: 'access_key', accessKeyId: 'ak_1', scopes: ['deploy:site'] },
        },
      ]
    ),
    output: (line) => output.push(line),
  });
  await executeCommand(['auth', 'logout'], {
    env: {},
    profile: productionProfile(),
    profileDir: await tempProject(),
    secretStore: {
      get: async () => null,
      set: async () => {},
      delete: async (environment) => deleted.push(environment),
    },
    output: () => {},
  });

  assert.equal(JSON.parse(output[0]).actor.accessKeyId, 'ak_1');
  assert.deepEqual(deleted, ['production']);
});

test('login --json emits browser challenge before polling', async () => {
  const calls = [];
  const output = [];
  const writes = [];

  await executeCommand(['login', '--json', '--no-open'], {
    env: {},
    profile: productionProfile(),
    secretStore: {
      set: async (environment, credential) => writes.push({ environment, credential }),
    },
    fetch: fakeFetch(calls, [
      {
        loginId: 'cli_1',
        loginSecret: 'sec_1',
        deviceCode: '12345678',
        browserUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_1',
        expiresAt: 2_000,
      },
      { status: 'confirmed', cliToken: 'cli_token_secret', expiresAt: 3_000 },
    ]),
    sleep: async () => {},
    nowSeconds: () => 1_000,
    nowIso: () => '2026-06-15T00:00:00.000Z',
    output: (line) => output.push(line),
  });

  const lines = output.map((line) => JSON.parse(line));
  assert.equal(calls[0].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/start');
  assert.equal(calls[1].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/poll');
  assert.deepEqual(lines[0], {
    ok: true,
    schemaVersion: 1,
    type: 'login_challenge',
    environment: 'production',
    credentialType: 'cli_token',
    deviceCode: '12345678',
    browserUrl: 'https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id=cli_1',
    expiresAt: 2_000,
  });
  assert.deepEqual(lines[1], {
    ok: true,
    schemaVersion: 1,
    environment: 'production',
    credentialType: 'cli_token',
  });
  assert.equal(output.join('\n').includes('sec_1'), false);
  assert.equal(output.join('\n').includes('cli_token_secret'), false);
  assert.equal(writes[0].credential.value, 'cli_token_secret');
});

test('access set updates visibility and replaces allow list entries', async () => {
  const calls = [];
  const output = [];

  await executeCommand(
    [
      'access',
      'set',
      'demo',
      '--visibility',
      'acl',
      '--email',
      'Alice@Example.COM',
      '--department',
      ' 心动/技术平台部 ',
      '--json',
    ],
    {
      env: {},
      profile: productionProfile(),
      secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
      fetch: fakeFetch(calls, [
        { sites: [{ id: 'site_1', slug: 'demo', environment: 'production', route: { visibility: 'org' } }] },
        {
          aclEntries: [
            { subjectType: 'email', subjectValue: 'alice@example.com', effect: 'allow', accessRole: 'viewer' },
            { subjectType: 'department', subjectValue: '心动/技术平台部', effect: 'allow', accessRole: 'viewer' },
          ],
        },
        { site: { id: 'site_1', slug: 'demo', defaultVisibility: 'acl', route: { visibility: 'acl' } } },
      ]),
      output: (line) => output.push(line),
    }
  );

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(await calls[1].json(), {
    entries: [
      { subjectType: 'email', subjectValue: 'alice@example.com' },
      { subjectType: 'department', subjectValue: '心动/技术平台部' },
    ],
  });
  assert.equal(calls[2].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1');
  assert.equal(calls[2].method, 'PATCH');
  assert.deepEqual(await calls[2].json(), { visibility: 'acl' });
  assert.deepEqual(JSON.parse(output[0]), {
    ok: true,
    schemaVersion: 1,
    environment: 'production',
    site: 'demo',
    visibility: 'acl',
    emails: ['alice@example.com'],
    departments: ['心动/技术平台部'],
  });
});

test('access set does not enable acl visibility when acl replacement fails', async () => {
  const calls = [];

  await assert.rejects(
    () =>
      executeCommand(['access', 'set', 'demo', '--visibility', 'acl', '--email', 'alice@example.com'], {
        env: {},
        profile: productionProfile(),
        secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
        fetch: fakeFetch(calls, [
          { sites: [{ id: 'site_1', slug: 'demo', environment: 'production', route: { visibility: 'org' } }] },
          { status: 503, body: { error: { code: 'ROUTE_SNAPSHOT_WRITE_FAILED', message: 'snapshot failed' } } },
        ]),
        output: () => {},
      }),
    { code: 'ROUTE_SNAPSHOT_WRITE_FAILED' }
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl');
  assert.equal(calls[1].method, 'PUT');
});

test('access grant and revoke change allow list entries incrementally', async () => {
  const grantCalls = [];
  const revokeCalls = [];

  await executeCommand(['access', 'grant', 'demo', '--email', 'Bob@Example.COM', '--department', '心动/技术平台部'], {
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(grantCalls, [
      { sites: [{ id: 'site_1', slug: 'demo', environment: 'production', route: { visibility: 'acl' } }] },
      {
        aclEntries: [
          { subjectType: 'email', subjectValue: 'bob@example.com', effect: 'allow', accessRole: 'viewer' },
          { subjectType: 'department', subjectValue: '心动/技术平台部', effect: 'allow', accessRole: 'viewer' },
        ],
      },
    ]),
    output: () => {},
  });

  await executeCommand(['access', 'revoke', 'demo', '--department', '心动/技术平台部'], {
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(revokeCalls, [
      { sites: [{ id: 'site_1', slug: 'demo', environment: 'production', route: { visibility: 'acl' } }] },
      { aclEntries: [{ subjectType: 'email', subjectValue: 'bob@example.com', effect: 'allow', accessRole: 'viewer' }] },
    ]),
    output: () => {},
  });

  assert.equal(grantCalls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl/entries');
  assert.equal(grantCalls[1].method, 'POST');
  assert.deepEqual(await grantCalls[1].json(), {
    entries: [
      { subjectType: 'email', subjectValue: 'bob@example.com' },
      { subjectType: 'department', subjectValue: '心动/技术平台部' },
    ],
  });
  assert.equal(revokeCalls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1/acl/entries');
  assert.equal(revokeCalls[1].method, 'DELETE');
  assert.deepEqual(await revokeCalls[1].json(), {
    entries: [{ subjectType: 'department', subjectValue: '心动/技术平台部' }],
  });
});

test('access grant explains that the site must use acl visibility first', async () => {
  await assert.rejects(
    () =>
      executeCommand(['access', 'grant', 'demo', '--email', 'user@example.com'], {
        env: {},
        secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
        fetch: fakeFetch([], [{ sites: [{ id: 'site_1', slug: 'demo', route: { visibility: 'org' } }] }]),
        output: () => {},
      }),
    {
      code: 'ACCESS_VISIBILITY_NOT_ACL',
      action: '请先运行 xd-cell access set demo --visibility acl --email user@example.com。',
    }
  );
});

test('local commands reject unused tokens', async () => {
  await assert.rejects(() => executeCommand(['version', '--token', 'x'], { output: () => {} }), {
    code: 'ACCESS_KEY_NOT_USED',
  });
  await assert.rejects(() => executeCommand(['env', 'list', '--token', 'x'], { output: () => {} }), {
    code: 'ACCESS_KEY_NOT_USED',
  });
});

test('commands reject unknown flags and extra positional arguments', async () => {
  await assert.rejects(() => executeCommand(['deploy', '.', 'docs', '--print', '1'], { output: () => {} }), {
    code: 'OPTION_UNKNOWN',
  });
  await assert.rejects(() => executeCommand(['sites', 'list', '--visibility', 'org'], { output: () => {} }), {
    code: 'OPTION_UNKNOWN',
  });
  await assert.rejects(() => executeCommand(['version', 'extra'], { output: () => {} }), {
    code: 'VERSION_USAGE_INVALID',
  });
  await assert.rejects(() => executeCommand(['env', 'use', 'staging', 'extra'], { output: () => {} }), {
    code: 'ENV_USAGE_INVALID',
  });
  await assert.rejects(() => executeCommand(['help', 'deploy', 'extra'], { output: () => {} }), {
    code: 'HELP_USAGE_INVALID',
  });
});

test('prints help and version for top-level CLI aliases', async () => {
  const helpOutput = [];
  assert.equal(await executeCommand(['--help'], { output: (line) => helpOutput.push(line) }), 0);
  const help = helpOutput.join('\n');
  assert.match(help, /用法：xd-cell/);
  assert.match(help, /xd-cell help deploy/);
  assert.match(help, /^\s+logout\s/m);
  assert.match(help, /^\s+whoami\s/m);
  assert.match(help, /^\s+detect\s/m);
  assert.match(help, /^\s+sites\s+查看站点列表、详情或删除站点。$/m);
  assert.doesNotMatch(help, /--access-key|--env|xd-cell env|^\s+env\s|^\s+auth\s/m);
  assert.doesNotMatch(
    help,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|${['--si', 'te'].join('')}|` +
        `${['--save', '-config'].join('')}|local|custom`
    )
  );

  const versionOutput = [];
  assert.equal(await executeCommand(['-v'], { output: (line) => versionOutput.push(line) }), 0);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(versionOutput.join('\n'), packageJson.version);
});

test('prints command-specific deploy help with parameters and agent-safe output hints', async () => {
  for (const argv of [
    ['help', 'deploy'],
    ['deploy', '--help'],
  ]) {
    const output = [];
    assert.equal(await executeCommand(argv, { output: (line) => output.push(line) }), 0);
    const text = output.join('\n');
    assert.match(text, /xd-cell deploy <entry> <site>/);
    assert.match(text, /--visibility <internal\|org\|acl\|owner\|disabled>/);
    assert.match(text, /--team <teamId>/);
    assert.match(text, /--token <token>/);
    assert.match(text, /--config <file>/);
    assert.match(text, /--json/);
    assert.match(text, /assets\.not_found_handling/);
    assert.match(text, /已有团队站点随发布转移归属时，要求源团队 admin/);
    assert.match(text, /Team Access Token（TAT）只能继续发布其自身团队站点，不能改变 Owner/);
    assert.doesNotMatch(text, /--fallback <|--access-key|--env|environment/);
    assert.doesNotMatch(
      text,
      new RegExp(
        `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|${['--si', 'te'].join('')}|` +
          `${['--save', '-config'].join('')}|PAGES_ACCESS_KEY|local|custom`
      )
    );
    assert.doesNotMatch(text, /WFP|slot|dispatch namespace|service binding/i);
  }
});

test('prints command-specific detect help without hidden worker-entry flag', async () => {
  const output = [];

  assert.equal(await executeCommand(['help', 'detect'], { output: (line) => output.push(line) }), 0);

  const text = output.join('\n');
  assert.match(text, /用法：xd-cell detect <entry>/);
  assert.match(text, /--config <file>/);
  assert.match(text, /--json/);
  assert.doesNotMatch(text, /--worker-entry|--fallback|--env|environment/);
});

test('prints command-specific access help with Chinese visibility wording', async () => {
  const output = [];

  assert.equal(await executeCommand(['help', 'access'], { output: (line) => output.push(line) }), 0);

  const text = output.join('\n');
  assert.match(text, /用法：xd-cell access get <站点名>/);
  assert.match(text, /xd-cell access set <站点名> --visibility <范围>/);
  assert.match(text, /xd-cell access grant <站点名>/);
  assert.match(text, /公司网络内，需命中邮箱或部门授权/);
  assert.match(text, /--department <部门路径>/);
  assert.doesNotMatch(text, /ACL 表|site_acl_entries|WFP|slot|v2/i);
});

test('prints command-specific open help with API token guidance', async () => {
  const output = [];

  assert.equal(await executeCommand(['help', 'open'], { output: (line) => output.push(line) }), 0);

  const text = output.join('\n');
  assert.match(text, /用法：xd-cell open <站点名>/);
  assert.match(text, /--token <token>/);
  assert.match(text, /XD_CELL_API_TOKEN/);
  assert.doesNotMatch(text, /--access-key|--env|environment/);
});

test('sites help documents interactive and non-interactive deletion', async () => {
  const output = [];

  assert.equal(await executeCommand(['help', 'sites'], { output: (line) => output.push(line) }), 0);

  const text = output.join('\n');
  assert.match(text, /xd-cell sites delete <站点名>/);
  assert.match(text, /--yes/);
  assert.match(text, /默认要求交互确认/);
  assert.match(text, /JSON 和非交互环境必须显式传入/);
});

async function tempProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function mkdist(dir) {
  const dist = path.join(dir, 'dist');
  await mkdir(dist);
  await writeFile(path.join(dist, 'index.html'), '<h1>Dist</h1>');
}

function fakeFetch(calls, payloads) {
  return async (request) => {
    calls.push(request.clone());
    const payload = payloads.shift() || {};
    if (payload && typeof payload === 'object' && 'status' in payload && 'body' in payload) {
      return Response.json(payload.body, { status: payload.status, headers: payload.headers });
    }
    return Response.json(payload);
  };
}

function fakeSecretStore(credential) {
  return {
    get: async () => credential,
    set: async () => {},
    delete: async () => {},
  };
}

function assertJsonLeafValueAbsent(value, forbidden) {
  assert.equal(
    collectJsonLeafStrings(value).some((leaf) => leaf === forbidden),
    false
  );
}

function collectJsonLeafStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLeafStrings(item, output);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectJsonLeafStrings(item, output);
    }
  }
  return output;
}

function productionProfile() {
  return {
    activeEnvironment: 'production',
    environments: {},
  };
}
