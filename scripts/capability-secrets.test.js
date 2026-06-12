import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/put-capability-secrets.sh');

function runScript(env = {}) {
  return spawnSync(scriptPath, ['apps/server'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DRY_RUN: '1',
      ...env,
    },
    encoding: 'utf8',
  });
}

test('capability secret injection follows every unique secret named by the registry', () => {
  const result = runScript({
    PAGES_CAP_JWT_ACTIVE_KID: 'active',
    PAGES_CAP_JWT_KEYS:
      'old:HS256:PAGES_CAP_JWT_SECRET_OLD, active:HS256:PAGES_CAP_JWT_SECRET_202606, duplicate:HS256:PAGES_CAP_JWT_SECRET_OLD',
    PAGES_CAP_JWT_SECRET_OLD: 'old-secret',
    PAGES_CAP_JWT_SECRET_202606: 'active-secret',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_OLD/);
  assert.match(result.stdout, /PAGES_CAP_JWT_SECRET_202606/);
  assert.equal((result.stdout.match(/PAGES_CAP_JWT_SECRET_OLD/g) || []).length, 1);
  assert.doesNotMatch(result.stdout, /old-secret|active-secret/);
});

test('capability secret injection fails before deploy when a registry secret is missing', () => {
  const result = runScript({
    PAGES_CAP_JWT_ACTIVE_KID: 'active',
    PAGES_CAP_JWT_KEYS: 'active:HS256:PAGES_CAP_JWT_SECRET_MISSING',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAGES_CAP_JWT_SECRET_MISSING/);
});

test('capability secret injection requires an active kid before deploy', () => {
  const result = runScript({
    PAGES_CAP_JWT_KEYS: 'active:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'active-secret',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PAGES_CAP_JWT_ACTIVE_KID/);
});

test('capability secret injection fails before deploy when active kid is not in the registry', () => {
  const result = runScript({
    PAGES_CAP_JWT_ACTIVE_KID: 'missing',
    PAGES_CAP_JWT_KEYS: 'active:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'active-secret',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active kid|PAGES_CAP_JWT_ACTIVE_KID/i);
  assert.doesNotMatch(result.stdout, /PAGES_CAP_JWT_SECRET_202606/);
});
