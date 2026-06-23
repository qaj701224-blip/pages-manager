import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
        deployment: { id: 'dep_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
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
  assert.equal(metadata.publishPlan.requestedFallback, 'auto');
  assert.equal(metadata.publishPlan.resolvedFallback, 'index');
  assert.equal(metadata.publishPlan.routingMode, 'assets-only');
  assert.deepEqual(metadata.assetManifest.map((asset) => asset.path), ['/index.html']);
  assert.equal(deployForm.has('artifactKind'), false);
  assert.equal(deployForm.has('artifactBundle'), false);
  assert.equal(deployForm.has('assetManifest'), false);
  assert.equal(await deployForm.get(metadata.assetManifest[0].partName).text(), '<h1>Hello</h1>');
  assert.deepEqual(output, [
    '检查发布目录...',
    '检查发布目录完成：1 files / 14 B',
    '识别结果：静态资源目录',
    '找不到文件时：返回 /index.html',
    '准备凭证...',
    '准备站点...',
    '上传并发布...',
    '站点名：docs',
    '识别结果：静态资源目录',
    '找不到文件时：返回 /index.html',
    '部署：dep_1 succeeded',
    '发布完成：https://docs.pages.xd.team',
  ]);
});

test('deploy uses explicit token as a one-shot credential without local secret reads', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  await executeCommand(['deploy', '.', 'docs', '--token', 'xdp_prod_ak_1_secret', '--json'], {
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
      {
        deployment: { id: 'dep_1', siteId: 'site_1', status: 'succeeded' },
        version: { id: 'ver_1' },
        route: { hostname: 'docs.pages.xd.team' },
      },
    ]),
    idempotencyKey: () => 'idem_1',
    output: (line) => output.push(line),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer xdp_prod_ak_1_secret');
  const metadata = JSON.parse(await (await calls[0].formData()).get('metadata').text());
  assert.equal(metadata.siteSlug, 'docs');
  assert.equal(metadata.publishPlan.deploymentShape, 'assets-only');
  assert.deepEqual(JSON.parse(output.join('\n')), {
    ok: true,
    schemaVersion: 1,
    type: 'deploy',
    mode: 'deploy',
    environment: 'production',
    site: 'docs',
    target: {
      source: '.',
      kind: 'directory',
      requestedFallback: 'auto',
      workerEntry: null,
    },
    decision: {
      deploymentShape: 'assets-only',
      requestedFallback: 'auto',
      resolvedFallback: 'index',
      routingMode: 'assets-only',
      confidence: 'medium',
      source: 'auto',
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
    signals: [
      { code: 'ROOT_INDEX_HTML_FOUND', path: 'index.html' },
      { code: 'SINGLE_HTML_ENTRY' },
    ],
    diagnostics: {
      warnings: [],
      errors: [],
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
  assert.equal(body.decision.requestedFallback, 'auto');
  assert.equal(body.decision.resolvedFallback, 'index');
  assert.equal(body.checks.packageChecked, false);
  assert.equal(body.checks.canPackage, null);
  assert.equal(body.sideEffects.willDeploy, false);
  assert.equal('uploadPlanSummary' in body, false);
  assert.equal('artifactKind' in body, false);
});

test('detect auto-discovers pages.config.json without network side effects', async () => {
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
  assert.equal(body.decision.requestedFallback, 'not-found');
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

test('deploy auto-discovers pages.config.json for dry-run without network side effects', async () => {
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
  assert.equal(body.decision.requestedFallback, 'not-found');
  assert.equal(body.decision.resolvedFallback, 'not-found');
  assert.equal(body.uploadPlanSummary.fileCount, 1);
  assert.equal('artifactKind' in body, false);
});

test('deploy reads explicit one-shot command config and lets CLI args override it', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(
    path.join(dir, 'pages.config.json'),
    JSON.stringify({
      environment: 'staging',
      site: 'from-config',
      source: './dist',
      visibility: 'org',
      fallback: 'not-found',
    })
  );
  await mkdist(dir);
  const calls = [];

  await executeCommand(
    ['deploy', './dist', 'from-args', '--config', 'pages.config.json', '--env', 'production', '--visibility', 'owner'],
    {
      cwd: dir,
      env: {},
      secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
      fetch: fakeFetch(calls, [
        { site: { id: 'site_1', slug: 'from-args', environment: 'production' } },
        { deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} },
      ]),
      output: () => {},
    }
  );

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(await calls[0].json(), { slug: 'from-args', visibility: 'owner' });
  const deployForm = await calls[1].formData();
  const metadata = JSON.parse(await deployForm.get('metadata').text());
  assert.equal(metadata.siteSlug, 'from-args');
  assert.equal(metadata.publishPlan.resolvedFallback, 'not-found');
  assert.equal(deployForm.has('artifactKind'), false);
});

test('explicit --config does not merge with auto-discovered pages.config.json', async () => {
  const dir = await tempProject();
  await mkdist(dir);
  await writeFile(
    path.join(dir, 'pages.config.json'),
    JSON.stringify({
      site: 'auto-config',
      source: './missing',
      fallback: 'not-found',
    })
  );
  await writeFile(
    path.join(dir, 'deploy.config.json'),
    JSON.stringify({
      site: 'explicit-config',
      source: './dist',
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
  assert.equal(body.decision.requestedFallback, 'auto');
  assert.equal(body.decision.resolvedFallback, 'index');
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

test('status, sites, rollback, and open use explicit site names', async () => {
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
  await executeCommand(['rollback', 'docs', 'ver_1'], {
    cwd: dir,
    env: {},
    profile: productionProfile(),
    secretStore: fakeSecretStore({ type: 'access_key', value: 'xdp_prod_ak_1_secret' }),
    fetch: fakeFetch(calls, [{ deployment: { id: 'dep_2', status: 'succeeded' } }]),
    idempotencyKey: () => 'rb_1',
    output: () => {},
  });
  const openOutput = [];
  await executeCommand(['open', 'docs', '--env', 'staging', '--print'], {
    cwd: dir,
    output: (line) => openOutput.push(line),
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(JSON.parse(output[0]).site, { id: 'site_1', slug: 'docs', environment: 'production' });
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites');
  assert.match(siteInfoOutput.join('\n'), /站点名：docs/);
  assert.equal(calls[2].url, 'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback');
  assert.deepEqual(await calls[2].json(), { siteSlug: 'docs' });
  assert.equal(calls[2].headers.get('Idempotency-Key'), 'rb_1');
  assert.deepEqual(openOutput, ['https://docs-staging.pages.xd.team']);
});

test('sites list defaults to a summary and supports detailed JSON', async () => {
  const sites = [
    {
      id: 'site_1',
      slug: 'docs',
      environment: 'staging',
      defaultVisibility: 'org',
      url: 'https://docs-staging.pages.xd.team',
      route: {
        id: 'route_1',
        hostname: 'docs-staging.pages.xd.team',
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
  assert.match(summaryOutput.join('\n'), /docs\s+staging\s+org\s+active\s+https:\/\/docs-staging\.pages\.xd\.team/);
  assert.doesNotMatch(summaryOutput.join('\n'), /route_1/);

  assert.deepEqual(JSON.parse(summaryJsonOutput.join('\n')), {
    ok: true,
    schemaVersion: 1,
    environment: 'staging',
    sites: [
      {
        site: 'docs',
        environment: 'staging',
        visibility: 'org',
        status: 'active',
        url: 'https://docs-staging.pages.xd.team',
      },
    ],
  });
  assert.match(summaryJsonOutput.join('\n'), /\n {2}"sites": \[/);

  assert.equal(JSON.parse(detailsJsonOutput.join('\n')).sites[0].route.id, 'route_1');
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
      action: '未找到 xtq-html-test。你是不是想查看 xtq-hml-test？',
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

test('whoami uses API validation and env list stays user-facing only', async () => {
  const calls = [];
  const output = [];

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
  const envOutput = [];
  await executeCommand(['env', 'list'], { output: (line) => envOutput.push(line) });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/auth/whoami');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer xdp_prod_ak_1_secret');
  assert.equal(JSON.parse(output[0]).actor.accessKeyId, 'ak_1');
  assert.equal(JSON.parse(output[0]).actor.email, 'user@example.com');
  assert.equal(JSON.parse(output[0]).actor.name, 'User One');
  assert.deepEqual(envOutput, ['production', 'staging']);
});

test('auth subcommands remain as hidden compatibility aliases', async () => {
  const deleted = [];
  const output = [];

  await executeCommand(['auth', 'whoami', '--access-key', 'xdp_prod_ak_1_secret', '--json'], {
    env: {},
    profile: productionProfile(),
    fetch: fakeFetch([], [
      {
        environment: 'production',
        actor: { type: 'access_key', credentialType: 'access_key', accessKeyId: 'ak_1', scopes: ['deploy:site'] },
      },
    ]),
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

test('env current reports active environment details', async () => {
  const output = [];
  const profile = { activeEnvironment: 'staging', environments: {} };

  await executeCommand(['env'], {
    env: {},
    profile,
    output: (line) => output.push(line),
  });

  assert.deepEqual(output, [
    '当前环境：staging',
    'API：https://api-staging.pages.xd.team',
    '认证：https://auth-staging.pages.xd.team',
    '站点域名：*-staging.pages.xd.team',
    '来源：本地 profile',
  ]);

  const jsonOutput = [];
  await executeCommand(['env', 'current', '--json'], {
    env: {},
    profile,
    output: (line) => jsonOutput.push(line),
  });

  assert.deepEqual(JSON.parse(jsonOutput[0]), {
    ok: true,
    schemaVersion: 1,
    activeEnvironment: 'staging',
    source: 'profile',
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteUrlExample: 'https://<site>-staging.pages.xd.team',
  });
});

test('env can switch directly by environment name', async () => {
  const output = [];
  const dir = await tempProject();

  await executeCommand(['env', 'staging'], {
    env: {},
    profile: productionProfile(),
    profileDir: dir,
    output: (line) => output.push(line),
  });

  assert.deepEqual(output, ['当前环境：staging']);
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
    ['access', 'set', 'demo', '--visibility', 'acl', '--email', 'Alice@Example.COM', '--department', ' 心动/技术平台部 ', '--json'],
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
      action: '请先运行 pages access set demo --visibility acl --email user@example.com。',
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
  assert.match(help, /用法：pages/);
  assert.match(help, /pages help deploy/);
  assert.match(help, /^\s+logout\s/m);
  assert.match(help, /^\s+whoami\s/m);
  assert.match(help, /^\s+detect\s/m);
  assert.doesNotMatch(help, /--access-key|--env|pages env|^\s+env\s|^\s+auth\s/m);
  assert.doesNotMatch(
    help,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|${['--si', 'te'].join('')}|` +
        `${['--save', '-config'].join('')}|local|custom`
    )
  );

  const versionOutput = [];
  assert.equal(await executeCommand(['-v'], { output: (line) => versionOutput.push(line) }), 0);
  assert.match(versionOutput.join('\n'), /^0\.1\.0$/);
});

test('prints command-specific deploy help with parameters and agent-safe output hints', async () => {
  for (const argv of [
    ['help', 'deploy'],
    ['deploy', '--help'],
  ]) {
    const output = [];
    assert.equal(await executeCommand(argv, { output: (line) => output.push(line) }), 0);
    const text = output.join('\n');
    assert.match(text, /用法：pages deploy <目录> <站点名>/);
    assert.match(text, /--visibility <internal\|org\|acl\|owner\|disabled>/);
    assert.match(text, /--token <token>/);
    assert.match(text, /--config <file>/);
    assert.match(text, /--json/);
    assert.doesNotMatch(text, /--access-key|--env|environment/);
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

test('prints command-specific access help with Chinese visibility wording', async () => {
  const output = [];

  assert.equal(await executeCommand(['help', 'access'], { output: (line) => output.push(line) }), 0);

  const text = output.join('\n');
  assert.match(text, /用法：pages access get <站点名>/);
  assert.match(text, /pages access set <站点名> --visibility <范围>/);
  assert.match(text, /pages access grant <站点名>/);
  assert.match(text, /公司网络内，需命中邮箱或部门授权/);
  assert.match(text, /--department <部门路径>/);
  assert.doesNotMatch(text, /ACL 表|site_acl_entries|WFP|slot|v2/i);
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
      return Response.json(payload.body, { status: payload.status });
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

function productionProfile() {
  return {
    activeEnvironment: 'production',
    environments: {},
  };
}
