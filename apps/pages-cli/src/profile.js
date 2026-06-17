import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir as defaultHomedir } from 'node:os';
import path from 'node:path';

const PROFILE_FILE = 'profile.json';
const SECRET_FIELD_RE = /token|access.?key|cookie|secret|cloudflare|accountid|zoneid|namespaceid|capability/i;

export function resolveProfileDir({ env = process.env, platform = process.platform, homedir = defaultHomedir } = {}) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), '.xd-pages');
  return path.join(homedir(), '.xd-pages');
}

export async function loadProfile(profileDir = resolveProfileDir()) {
  let raw;
  try {
    raw = await readFile(profilePath(profileDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultProfile();
    throw error;
  }
  const profile = JSON.parse(raw);
  assertNoSecretFields(profile);
  return {
    ...defaultProfile(),
    ...profile,
    environments: {
      ...defaultProfile().environments,
      ...(profile.environments || {}),
    },
  };
}

export async function saveProfile(profileDir = resolveProfileDir(), profile = defaultProfile()) {
  assertNoSecretFields(profile);
  const normalized = {
    activeEnvironment: profile.activeEnvironment || 'production',
    environments: profile.environments || {},
  };
  await mkdir(profileDir, { recursive: true });
  await writeFile(profilePath(profileDir), `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  return normalized;
}

export function profilePath(profileDir = resolveProfileDir()) {
  return path.join(profileDir, PROFILE_FILE);
}

function defaultProfile() {
  return {
    activeEnvironment: 'production',
    environments: {},
  };
}

function assertNoSecretFields(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const fullPath = [...pathParts, key].join('.');
    if (SECRET_FIELD_RE.test(key.replaceAll('_', ''))) throw new Error(`PROFILE_SECRET_FIELD:${fullPath}`);
    assertNoSecretFields(nested, [...pathParts, key]);
  }
}
