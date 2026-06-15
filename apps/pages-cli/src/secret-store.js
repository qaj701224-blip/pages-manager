import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { resolveProfileDir } from './profile.js';

const execFileDefault = promisify(execFileCallback);
const CREDENTIALS_FILE = 'credentials.json';
const SECRET_ENV_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const BROAD_WINDOWS_PRINCIPALS = ['everyone', 'builtin\\users', 'nt authority\\authenticated users', 'authenticated users'];

export function createSecretStore({
  profileDir = resolveProfileDir(),
  platform = process.platform,
  env = process.env,
  execFile = execFileDefault,
  prefer = 'auto',
} = {}) {
  const fallback = createFallbackSecretStore({ profileDir, platform, execFile });
  if (prefer === 'fallback') return fallback;

  const osStore = createOsSecretStore({ platform, execFile, env });
  if (!osStore) return fallback;

  return {
    kind: 'composite',
    async get(environment) {
      try {
        const value = await osStore.get(environment);
        if (value) return value;
      } catch {
        return fallback.get(environment);
      }
      return fallback.get(environment);
    },
    async set(environment, credential) {
      try {
        await osStore.set(environment, credential);
        await fallback.delete(environment);
      } catch {
        await fallback.set(environment, credential);
      }
    },
    async delete(environment) {
      await Promise.allSettled([osStore.delete(environment), fallback.delete(environment)]);
    },
  };
}

export function createFallbackSecretStore({
  profileDir = resolveProfileDir(),
  platform = process.platform,
  execFile = execFileDefault,
} = {}) {
  const filePath = path.join(profileDir, CREDENTIALS_FILE);
  return {
    kind: 'fallback',
    filePath,
    async get(environment) {
      const secrets = await readSecretsFile(filePath, { platform, execFile });
      return secrets[parseSecretName(environment)] || null;
    },
    async set(environment, credential) {
      const secrets = await readSecretsFile(filePath, { platform, execFile });
      secrets[parseSecretName(environment)] = normalizeCredential(credential);
      await mkdir(profileDir, { recursive: true });
      await writeFile(filePath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
      if (platform !== 'win32') await chmod(filePath, 0o600);
    },
    async delete(environment) {
      const secrets = await readSecretsFile(filePath, { platform, execFile });
      delete secrets[parseSecretName(environment)];
      await mkdir(profileDir, { recursive: true });
      await writeFile(filePath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
      if (platform !== 'win32') await chmod(filePath, 0o600);
    },
  };
}

export async function assertFallbackFileSafe(filePath, { platform = process.platform, execFile = execFileDefault } = {}) {
  let stats;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }

  if (platform === 'win32') {
    const { stdout } = await execFile('icacls', [filePath]);
    if (!isWindowsAclSafeFromIcacls(stdout)) throw new Error('SECRET_FILE_PERMISSIONS_UNSAFE');
    return true;
  }

  if ((stats.mode & 0o077) !== 0) throw new Error('SECRET_FILE_PERMISSIONS_UNSAFE');
  return true;
}

export function isWindowsAclSafeFromIcacls(output) {
  const lines = String(output || '')
    .toLowerCase()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return !lines.some((line) => {
    const broadPrincipal = BROAD_WINDOWS_PRINCIPALS.some((principal) => line.includes(principal));
    const broadPermission = /\((?:[^)]*,)?[fmw](?:,[^)]*)?\)/i.test(line);
    return broadPrincipal && broadPermission;
  });
}

export function parseSecretName(environment) {
  if (!SECRET_ENV_RE.test(String(environment || ''))) throw new Error('SECRET_NAME_INVALID');
  return `xd-pages:${environment}`;
}

async function readSecretsFile(filePath, options) {
  await assertFallbackFileSafe(filePath, options);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function normalizeCredential(credential) {
  if (!credential || typeof credential !== 'object') throw new Error('SECRET_CREDENTIAL_INVALID');
  if (credential.type !== 'cli_token' && credential.type !== 'access_key') throw new Error('SECRET_CREDENTIAL_INVALID');
  if (typeof credential.value !== 'string' || credential.value === '') throw new Error('SECRET_CREDENTIAL_INVALID');
  return {
    type: credential.type,
    value: credential.value,
    savedAt: credential.savedAt,
    expiresAt: credential.expiresAt,
  };
}

function createOsSecretStore({ platform, execFile, env }) {
  if (platform === 'darwin') return createMacKeychainStore(execFile);
  if (platform === 'linux' && env.PAGES_CLI_USE_SECRET_TOOL === '1') return createSecretToolStore(execFile);
  return null;
}

function createMacKeychainStore(execFile) {
  return {
    async get(environment) {
      const { stdout } = await execFile('security', [
        'find-generic-password',
        '-s',
        parseSecretName(environment),
        '-a',
        'xd-pages',
        '-w',
      ]);
      return stdout ? JSON.parse(stdout) : null;
    },
    async set(environment, credential) {
      await execFile('security', [
        'add-generic-password',
        '-U',
        '-s',
        parseSecretName(environment),
        '-a',
        'xd-pages',
        '-w',
        JSON.stringify(normalizeCredential(credential)),
      ]);
    },
    async delete(environment) {
      await execFile('security', ['delete-generic-password', '-s', parseSecretName(environment), '-a', 'xd-pages']);
    },
  };
}

function createSecretToolStore(execFile) {
  return {
    async get(environment) {
      const { stdout } = await execFile('secret-tool', ['lookup', 'service', parseSecretName(environment)]);
      return stdout ? JSON.parse(stdout) : null;
    },
    async set(environment, credential) {
      await execFile('secret-tool', ['store', '--label', parseSecretName(environment), 'service', parseSecretName(environment)], {
        input: JSON.stringify(normalizeCredential(credential)),
      });
    },
    async delete(environment) {
      await execFile('secret-tool', ['clear', 'service', parseSecretName(environment)]);
    },
  };
}
