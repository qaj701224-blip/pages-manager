import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeCommand } from './commands.js';
import { writeProjectConfig } from './project-config.js';

test('deploy creates a site with a CLI token but does not write .pages.json by default', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', '--slug', 'docs', '--visibility', 'org'], {
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
  assert.deepEqual(await calls[0].json(), { slug: 'docs', visibility: 'org' });
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(calls[1].headers.get('Idempotency-Key'), 'idem_1');
  const deployBody = await calls[1].json();
  assert.match(deployBody.contentHash, /^sha256:/);
  assert.equal(deployBody.artifactBundle.kind, 'spa');
  assert.equal(deployBody.artifactBundle.mainModule, 'worker.mjs');
  assert.equal(deployBody.artifactBundle.modules[0].content.includes(dir), false);
  assert.deepEqual(deployBody, {
    siteId: 'site_1',
    artifactKind: 'spa',
    contentHash: deployBody.contentHash,
    artifactBundle: deployBody.artifactBundle,
    source: 'cli',
  });

  assert.match(output.join('\n'), /dep_1/);
  assert.match(output.join('\n'), /site_1/);
  assert.match(output.join('\n'), /Project config not saved/);
  await assert.rejects(() => readFile(path.join(dir, '.pages.json'), 'utf8'), { code: 'ENOENT' });
});

test('deploy writes .pages.json only when --save-config is explicit', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];

  const exitCode = await executeCommand(['deploy', '.', '--slug', 'docs', '--visibility', 'org', '--save-config'], {
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
    nowIso: () => '2026-06-16T00:00:00.000Z',
    output: () => {},
  });

  assert.equal(exitCode, 0);
  const project = JSON.parse(await readFile(path.join(dir, '.pages.json'), 'utf8'));
  assert.equal(project.siteId, 'site_1');
  assert.equal(project.slug, 'docs');
  assert.equal(project.lastDeploymentId, 'dep_1');
  assert.equal(project.lastVersionId, 'ver_1');
  assert.equal(project.createdAt, '2026-06-16T00:00:00.000Z');
  assert.equal(project.updatedAt, '2026-06-16T00:00:00.000Z');
  assert.equal(JSON.stringify(project).includes('xdpak_'), false);
});

test('deploy with an access key requires an existing site id instead of creating a site', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];

  await assert.rejects(
    () =>
      executeCommand(['deploy', '.', '--slug', 'docs'], {
        cwd: dir,
        env: { PAGES_CLI_ENV: 'production', PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
        fetch: fakeFetch(calls, [{ site: { id: 'site_1' } }]),
        output: () => {},
      }),
    (error) => {
      assert.equal(error.code, 'SITE_ID_REQUIRED_FOR_ACCESS_KEY');
      assert.match(error.action, /--site <site_id>/);
      return true;
    }
  );

  assert.equal(calls.length, 0);
});

test('deploy with an access key accepts an explicit site id and returns agent-friendly JSON without writing config', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', '--site', 'site_1', '--slug', 'docs', '--json'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'production', PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
    fetch: fakeFetch(calls, [{ deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} }]),
    idempotencyKey: () => 'idem_1',
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal((await calls[0].json()).siteId, 'site_1');
  assert.deepEqual(JSON.parse(output.join('\n')), {
    ok: true,
    environment: 'production',
    siteId: 'site_1',
    slug: 'docs',
    artifactKind: 'spa',
    savedProjectConfig: false,
    deployment: { id: 'dep_1', status: 'succeeded' },
    version: { id: 'ver_1' },
    route: {},
    url: null,
  });
  await assert.rejects(() => readFile(path.join(dir, '.pages.json'), 'utf8'), { code: 'ENOENT' });
});

test('deploy reuses existing project binding without creating a site', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeProjectConfig(dir, { version: 1, environment: 'production', siteId: 'site_1', slug: 'docs' });
  const calls = [];

  await executeCommand(['deploy', '.'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'production', PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
    fetch: fakeFetch(calls, [{ deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} }]),
    idempotencyKey: () => 'idem_1',
    output: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
});

test('deploy does not reuse a project binding from a different environment', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeProjectConfig(dir, { version: 1, environment: 'production', siteId: 'site_prod', slug: 'docs' });
  const calls = [];

  await executeCommand(['deploy', '.', '--env', 'staging'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'staging' },
    secretStore: fakeSecretStore({ type: 'cli_token', value: 'cli_token_secret' }),
    fetch: fakeFetch(calls, [
      { site: { id: 'site_staging', slug: 'docs', environment: 'staging', url: 'https://docs-staging.pages.xd.team' } },
      { deployment: { id: 'dep_1', status: 'succeeded' }, version: { id: 'ver_1' }, route: {} },
    ]),
    idempotencyKey: () => 'idem_1',
    output: () => {},
  });

  assert.equal(calls[0].url, 'https://api-staging.pages.xd.team/.xd-pages/api/sites');
  assert.deepEqual(await calls[0].json(), { slug: 'docs', visibility: 'org' });
  const deployBody = await calls[1].json();
  assert.match(deployBody.contentHash, /^sha256:/);
  assert.equal(deployBody.artifactBundle.kind, 'spa');
  assert.deepEqual(deployBody, {
    siteId: 'site_staging',
    artifactKind: 'spa',
    contentHash: deployBody.contentHash,
    artifactBundle: deployBody.artifactBundle,
    source: 'cli',
  });
});

test('status and rollback call v2 API with the stored credential', async () => {
  const dir = await tempProject();
  await writeProjectConfig(dir, { version: 1, environment: 'production', siteId: 'site_1', slug: 'docs' });
  const calls = [];

  await executeCommand(['status', '--deployment', 'dep_1'], {
    cwd: dir,
    env: { PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
    fetch: fakeFetch(calls, [{ deployment: { id: 'dep_1', status: 'succeeded' } }]),
    output: () => {},
  });
  await executeCommand(['rollback', 'ver_1'], {
    cwd: dir,
    env: { PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
    fetch: fakeFetch(calls, [{ deployment: { id: 'dep_2', status: 'succeeded' } }]),
    idempotencyKey: () => 'rb_1',
    output: () => {},
  });

  assert.equal(calls[0].url, 'https://api.pages.xd.team/.xd-pages/api/deployments/dep_1');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer xdpak_production_ak_1_secret');
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback');
  assert.equal(calls[1].headers.get('Idempotency-Key'), 'rb_1');
});

test('status does not reuse a project binding from a different environment', async () => {
  const dir = await tempProject();
  await writeProjectConfig(dir, { version: 1, environment: 'production', siteId: 'site_prod', slug: 'docs' });

  await assert.rejects(
    () =>
      executeCommand(['status', '--env', 'staging'], {
        cwd: dir,
        env: { PAGES_ACCESS_KEY: 'xdpak_staging_ak_1_secret' },
        fetch: fakeFetch([], [{ site: { id: 'site_prod' } }]),
        output: () => {},
      }),
    /SITE_REQUIRED/
  );
});

test('open prints project URL without network when requested', async () => {
  const dir = await tempProject();
  await writeProjectConfig(dir, { version: 1, environment: 'staging', siteId: 'site_1', slug: 'docs' });
  const output = [];
  const opened = [];

  const exitCode = await executeCommand(['open', '--print'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'staging' },
    openUrl: async (url) => opened.push(url),
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(output, ['https://docs-staging.pages.xd.team']);
  assert.deepEqual(opened, []);
});

test('open does not reuse a project binding from a different environment', async () => {
  const dir = await tempProject();
  await writeProjectConfig(dir, { version: 1, environment: 'production', siteId: 'site_prod', slug: 'docs' });

  await assert.rejects(
    () =>
      executeCommand(['open', '--env', 'staging', '--print'], {
        cwd: dir,
        output: () => {},
      }),
    /SITE_BINDING_REQUIRED/
  );
});

test('env commands list, switch, and reject unsafe custom endpoints', async () => {
  const dir = await tempProject();
  const output = [];
  await executeCommand(['env', 'list'], { profileDir: dir, output: (line) => output.push(line) });
  assert.match(output.join('\n'), /production/);
  assert.match(output.join('\n'), /staging/);

  await executeCommand(['env', 'use', 'staging'], { profileDir: dir, output: () => {} });

  await assert.rejects(
    () =>
      executeCommand(['env', 'set', 'custom', '--api', 'https://api.workers.xd.team', '--auth', 'https://auth.workers.xd.team'], {
        profileDir: dir,
        output: () => {},
      }),
    /workers\.xd\.team/
  );
});

test('prints help and version for top-level CLI aliases', async () => {
  const helpOutput = [];
  assert.equal(await executeCommand(['--help'], { output: (line) => helpOutput.push(line) }), 0);
  assert.match(helpOutput.join('\n'), /Usage: pages/);
  assert.match(helpOutput.join('\n'), /pages help deploy/);

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
    assert.match(text, /Usage: pages deploy/);
    assert.match(text, /--site <site_id>/);
    assert.match(text, /--slug <site-slug>/);
    assert.match(text, /--visibility <public\|org\|acl\|owner\|disabled>/);
    assert.match(text, /--save-config/);
    assert.match(text, /--json/);
    assert.match(text, /PAGES_ACCESS_KEY/);
    assert.doesNotMatch(text, /WFP|slot|dispatch namespace|service binding/i);
  }
});

async function tempProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-command-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeFetch(calls, payloads) {
  return async (request) => {
    calls.push(request.clone());
    return Response.json(payloads.shift() || {});
  };
}

function fakeSecretStore(credential) {
  return {
    get: async () => credential,
    set: async () => {},
  };
}
