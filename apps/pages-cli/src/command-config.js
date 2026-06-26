import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_FILE = 'pages.config.json';
const ALLOWED_FIELDS = new Set(['environment', 'site', 'source', 'dir', 'visibility', 'fallback', 'worker']);
const SECRET_FIELD_RE = /token|access.?key|cookie|secret|cloudflare|accountid|zoneid|namespaceid|capability/i;
const VALID_ENVIRONMENTS = new Set(['production', 'staging']);
const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const VALID_FALLBACKS = new Set(['auto', 'index', 'not-found']);

export async function readCommandConfig(filePath, { cwd = process.cwd(), discover = false } = {}) {
  const configPath = filePath || (discover ? DEFAULT_CONFIG_FILE : null);
  if (!configPath) return null;
  const absolutePath = path.resolve(cwd, configPath);
  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    if (!filePath && discover && error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(content);
  return validateCommandConfig(parsed);
}

export function validateCommandConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_INVALID');
  assertNoSecretFields(value);
  assertNoLegacyApiOrigin(value);

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:${key}`);
    output[key] = normalizeField(key, entry);
  }
  return output;
}

function normalizeField(key, value) {
  if (key === 'environment') {
    if (!VALID_ENVIRONMENTS.has(value)) throw new Error('COMMAND_CONFIG_ENVIRONMENT_INVALID');
    return value;
  }
  if (key === 'visibility') {
    if (!VALID_VISIBILITIES.has(value)) throw new Error('COMMAND_CONFIG_VISIBILITY_INVALID');
    return value;
  }
  if (key === 'fallback') {
    if (!VALID_FALLBACKS.has(value)) throw new Error('COMMAND_CONFIG_FALLBACK_INVALID');
    return value;
  }
  if (key === 'worker') return normalizeWorkerConfig(value);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`COMMAND_CONFIG_${key.toUpperCase()}_INVALID`);
  const normalized = value.trim();
  if (key === 'site' && /:\/\//.test(normalized)) throw new Error('COMMAND_CONFIG_SITE_INVALID');
  return normalized;
}

function normalizeWorkerConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_WORKER_INVALID');
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'entry') throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:worker.${key}`);
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error('COMMAND_CONFIG_WORKER_ENTRY_INVALID');
    const normalized = entry.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
    if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error('COMMAND_CONFIG_WORKER_ENTRY_INVALID');
    }
    output.entry = normalized;
  }
  if (!output.entry) throw new Error('COMMAND_CONFIG_WORKER_ENTRY_INVALID');
  return output;
}

function assertNoSecretFields(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const fullPath = [...pathParts, key].join('.');
    if (SECRET_FIELD_RE.test(key.replaceAll('_', ''))) throw new Error(`COMMAND_CONFIG_SECRET_FIELD:${fullPath}`);
    assertNoSecretFields(nested, [...pathParts, key]);
  }
}

function assertNoLegacyApiOrigin(value) {
  if (typeof value === 'string' && /(^|:\/\/)api(?:-staging)?\.workers\.xd\.team(?::|\/|$)/i.test(value)) {
    throw new Error('COMMAND_CONFIG_LEGACY_API_UNSUPPORTED');
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) assertNoLegacyApiOrigin(nested);
}
