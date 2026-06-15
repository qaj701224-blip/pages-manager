import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT_CONFIG_FILE = '.pages.json';
const VALID_ENVIRONMENTS = new Set(['production', 'staging', 'local', 'custom']);
const VALID_ARTIFACT_KINDS = new Set(['static', 'spa', 'worker']);
const SECRET_FIELD_RE = /token|access.?key|cookie|secret|cloudflare|accountid|zoneid|namespaceid|capability/i;

export async function readProjectConfig(cwd = process.cwd()) {
  let raw;
  try {
    raw = await readFile(projectConfigPath(cwd), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PROJECT_CONFIG_INVALID_JSON');
  }
  return validateProjectConfig(parsed);
}

export async function writeProjectConfig(cwd = process.cwd(), config) {
  const safeConfig = validateProjectConfig(config);
  await mkdir(cwd, { recursive: true });
  await writeFile(projectConfigPath(cwd), `${JSON.stringify(safeConfig, null, 2)}\n`, { mode: 0o644 });
  return safeConfig;
}

export function validateProjectConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('PROJECT_CONFIG_INVALID');
  assertNoSecretFields(config);
  assertNoV1Domains(config);

  if (config.version !== 1) throw new Error('PROJECT_CONFIG_VERSION_INVALID');
  if (config.environment !== undefined && !VALID_ENVIRONMENTS.has(config.environment))
    throw new Error('PROJECT_CONFIG_ENV_INVALID');
  if (config.defaultArtifactKind !== undefined && !VALID_ARTIFACT_KINDS.has(config.defaultArtifactKind)) {
    throw new Error('PROJECT_CONFIG_ARTIFACT_INVALID');
  }

  return normalizeProjectConfig(config);
}

export function projectConfigPath(cwd = process.cwd()) {
  return path.join(cwd, PROJECT_CONFIG_FILE);
}

function normalizeProjectConfig(config) {
  const result = {
    version: 1,
  };
  for (const key of [
    'environment',
    'siteId',
    'slug',
    'defaultArtifactKind',
    'lastDeploymentId',
    'lastVersionId',
    'updatedAt',
    'createdAt',
  ]) {
    if (config[key] !== undefined) result[key] = config[key];
  }
  return result;
}

function assertNoSecretFields(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const fullPath = [...pathParts, key].join('.');
    if (SECRET_FIELD_RE.test(key.replaceAll('_', ''))) throw new Error(`PROJECT_CONFIG_SECRET_FIELD:${fullPath}`);
    assertNoSecretFields(nested, [...pathParts, key]);
  }
}

function assertNoV1Domains(value) {
  if (typeof value === 'string') {
    if (value.includes('workers.xd.team')) throw new Error('PROJECT_CONFIG_V1_DOMAIN');
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) assertNoV1Domains(nested);
}
