import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadProfile, resolveProfileDir, saveProfile } from './profile.js';

test('resolves profile directories by platform', () => {
  assert.equal(
    resolveProfileDir({ env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'linux', homedir: () => '/home/alice' }),
    path.join('/home/alice', '.xd-pages')
  );
  assert.equal(
    resolveProfileDir({ env: {}, platform: 'darwin', homedir: () => '/Users/alice' }),
    path.join('/Users/alice', '.xd-pages')
  );
  assert.equal(
    resolveProfileDir({
      env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\alice',
    }),
    path.join('C:\\Users\\alice\\AppData\\Roaming', '.xd-pages')
  );
});

test('profile metadata persists without credential fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-profile-'));
  test.after(() => rm(dir, { recursive: true, force: true }));

  await saveProfile(dir, {
    activeEnvironment: 'staging',
    environments: {
      staging: { lastLoginAt: '2026-06-15T00:00:00.000Z' },
    },
  });

  assert.deepEqual(await loadProfile(dir), {
    activeEnvironment: 'staging',
    environments: {
      staging: { lastLoginAt: '2026-06-15T00:00:00.000Z' },
    },
  });

  await assert.rejects(
    () =>
      saveProfile(dir, {
        activeEnvironment: 'production',
        token: 'secret',
      }),
    /PROFILE_SECRET_FIELD/
  );
});
