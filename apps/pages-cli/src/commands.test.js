import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeCommand } from './commands.js';
import { writeProjectConfig } from './project-config.js';

test('deploy creates a site when project has no binding, writes .pages.json, then deploys', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const calls = [];
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', '--slug', 'docs', '--visibility', 'org'], {
    cwd: dir,
    env: { PAGES_CLI_ENV: 'production', PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
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
  assert.deepEqual(deployBody, {
    siteId: 'site_1',
    artifactKind: 'spa',
    contentHash: deployBody.contentHash,
    source: 'cli',
  });

  const project = JSON.parse(await readFile(path.join(dir, '.pages.json'), 'utf8'));
  assert.equal(project.siteId, 'site_1');
  assert.equal(project.slug, 'docs');
  assert.equal(project.lastDeploymentId, 'dep_1');
  assert.equal(JSON.stringify(project).includes('xdpak_'), false);
  assert.match(output.join('\n'), /dep_1/);
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
