import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertFallbackFileSafe, createSecretStore, isWindowsAclSafeFromIcacls, parseSecretName } from './secret-store.js';

test('fallback secret store writes POSIX files with 0600 permissions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-secret-'));
  test.after(() => rm(dir, { recursive: true, force: true }));

  const store = createSecretStore({ profileDir: dir, platform: 'linux', prefer: 'fallback' });
  await store.set('production', { type: 'cli_token', value: 'cli_secret' });

  const filePath = path.join(dir, 'credentials.json');
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.deepEqual(await store.get('production'), { type: 'cli_token', value: 'cli_secret' });

  await store.delete('production');
  assert.equal(await store.get('production'), null);
});

test('fallback secret file rejects broad POSIX permissions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-secret-mode-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'credentials.json');
  await writeFile(filePath, '{}', { mode: 0o600 });

  await assertFallbackFileSafe(filePath, { platform: 'linux' });
  await chmod(filePath, 0o644);
  await assert.rejects(() => assertFallbackFileSafe(filePath, { platform: 'linux' }), /SECRET_FILE_PERMISSIONS_UNSAFE/);
});

test('Windows ACL parser rejects broad write principals', () => {
  assert.equal(
    isWindowsAclSafeFromIcacls(`
C:\\Users\\alice\\AppData\\Roaming\\xd-pages\\credentials.json NT AUTHORITY\\SYSTEM:(I)(F)
                                                        BUILTIN\\Administrators:(I)(F)
                                                        DESKTOP\\alice:(I)(F)
`),
    true
  );
  assert.equal(
    isWindowsAclSafeFromIcacls(`
C:\\Users\\alice\\AppData\\Roaming\\xd-pages\\credentials.json Everyone:(F)
                                                        BUILTIN\\Users:(M)
`),
    false
  );
  assert.equal(
    isWindowsAclSafeFromIcacls(`
C:\\Users\\alice\\AppData\\Roaming\\xd-pages\\credentials.json NT AUTHORITY\\Authenticated Users:(W)
`),
    false
  );
});

test('secret names are environment scoped and reject unsafe values', () => {
  assert.equal(parseSecretName('production'), 'xd-pages:production');
  assert.throws(() => parseSecretName('prod/../../x'), /SECRET_NAME_INVALID/);
});
