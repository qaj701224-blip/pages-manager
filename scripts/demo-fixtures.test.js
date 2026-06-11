import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENV_GUARD_SOURCE } from '../packages/ip-guard/src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('api-demo worker preset calls IP guard before handling routes', () => {
  const source = readFileSync(join(repoRoot, 'demos/api-demo/_worker.js'), 'utf8');
  const fetchIndex = source.indexOf('async fetch(request, env)');
  const guardCallIndex = source.indexOf('const blocked = checkIP(request, env);');
  const routeIndex = source.indexOf('const url = new URL(request.url);');

  assert.ok(source.includes(ENV_GUARD_SOURCE));
  assert.notEqual(fetchIndex, -1);
  assert.notEqual(guardCallIndex, -1);
  assert.notEqual(routeIndex, -1);
  assert.ok(guardCallIndex > fetchIndex);
  assert.ok(guardCallIndex < routeIndex);
  assert.match(source, /if \(blocked\) return blocked;/);
});

test('api-demo returns 403 before route handling when IP is not allowed', async () => {
  const workerUrl = pathToFileURL(join(repoRoot, 'demos/api-demo/_worker.js'));
  const worker = await import(`${workerUrl.href}?t=${Date.now()}`);
  let assetsCalled = false;

  const response = await worker.default.fetch(
    new Request('https://demo-api-staging.workers.xd.team/about.html', {
      headers: { 'CF-Connecting-IP': '198.51.100.10' },
    }),
    {
      IP_ALLOWLIST: '127.0.0.1',
      ASSETS: {
        fetch() {
          assetsCalled = true;
          return new Response(null, { status: 204 });
        },
      },
    },
  );

  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'IP not allowed');
  assert.equal(assetsCalled, false);
});
