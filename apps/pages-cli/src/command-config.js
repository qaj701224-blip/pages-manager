import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'xd-cell.config.json';

const ALLOWED_FIELDS = new Set(['name', 'main', 'assets', 'vars', 'visibility']);
const LEGACY_FIELDS = new Set(['environment', 'site', 'source', 'dir', 'fallback', 'worker', 'env', 'secrets']);
const SECRET_FIELD_RE = new RegExp(
  'token|access.?key|cookie|secret|password|credential|private.?key|cloudflare|accountid|zoneid|namespaceid|capability',
  'i'
);
const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const VALID_NOT_FOUND_HANDLING = new Set(['none', 'single-page-application', '404-page']);
const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_BINDING_NAMES = new Set(['ASSETS', 'XD_PAGES_KV_GATEWAY']);
const RESERVED_BINDING_PREFIXES = ['XD_', 'XD_CELL_', 'XD_PAGES_', 'CF_'];
const SENSITIVE_VAR_RE = /token|secret|password|credential|cookie|private.?key|api.?key|access.?key/i;

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
  const config = validateCommandConfig(parsed);
  return {
    ...config,
    configPath: normalizeRelativePath(path.relative(cwd, absolutePath) || path.basename(absolutePath)),
    configDir: path.dirname(absolutePath),
  };
}

export function validateCommandConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_INVALID');

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (LEGACY_FIELDS.has(key)) throw new Error(`COMMAND_CONFIG_LEGACY_FIELD:${key}`);
    if (SECRET_FIELD_RE.test(key.replaceAll('_', ''))) throw new Error(`COMMAND_CONFIG_SECRET_FIELD:${key}`);
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:${key}`);
    output[key] = normalizeField(key, entry);
  }
  assertNoSecretFields(value);
  assertNoLegacyApiOrigin(value);
  return output;
}

export function normalizeRuntimeVars(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_VARS_INVALID');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    validateBindingName(key);
    if (SENSITIVE_VAR_RE.test(key)) throw new Error(`COMMAND_CONFIG_VAR_SECRET_LIKE:${key}`);
    if (typeof value[key] !== 'string') throw new Error(`COMMAND_CONFIG_VAR_VALUE_INVALID:${key}`);
    output[key] = value[key];
  }
  return output;
}

export function validateBindingName(name) {
  if (!BINDING_NAME_RE.test(name)) throw new Error(`COMMAND_CONFIG_BINDING_NAME_INVALID:${name}`);
  if (RESERVED_BINDING_NAMES.has(name) || RESERVED_BINDING_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error(`COMMAND_CONFIG_BINDING_RESERVED:${name}`);
  }
  return name;
}

function normalizeField(key, value) {
  if (key === 'visibility') {
    if (!VALID_VISIBILITIES.has(value)) throw new Error('COMMAND_CONFIG_VISIBILITY_INVALID');
    return value;
  }
  if (key === 'assets') return normalizeAssetsConfig(value);
  if (key === 'vars') return normalizeRuntimeVars(value);
  if (key === 'name') return normalizeName(value);
  if (key === 'main') return normalizeRelativePathField(value, 'COMMAND_CONFIG_MAIN_INVALID');
  throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:${key}`);
}

function normalizeAssetsConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_ASSETS_INVALID');
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'fallback') throw new Error('COMMAND_CONFIG_LEGACY_FIELD:assets.fallback');
    if (key !== 'directory' && key !== 'not_found_handling') throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:assets.${key}`);
    if (key === 'directory') output.directory = normalizeRelativePathField(entry, 'COMMAND_CONFIG_ASSETS_DIRECTORY_INVALID');
    if (key === 'not_found_handling') {
      if (!VALID_NOT_FOUND_HANDLING.has(entry)) throw new Error('COMMAND_CONFIG_NOT_FOUND_HANDLING_INVALID');
      output.not_found_handling = entry;
    }
  }
  if (!output.directory) throw new Error('COMMAND_CONFIG_ASSETS_DIRECTORY_INVALID');
  output.not_found_handling ||= 'none';
  return output;
}

function normalizeName(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('COMMAND_CONFIG_NAME_INVALID');
  const normalized = value.trim().toLowerCase();
  if (/\/|\\|:\/\//.test(normalized)) throw new Error('COMMAND_CONFIG_NAME_INVALID');
  return normalized;
}

function normalizeRelativePathField(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(code);
  const normalized = normalizeRelativePath(value.trim());
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(code);
  return normalized;
}

function normalizeRelativePath(value) {
  return String(value || '').replaceAll('\\', '/');
}

function assertNoSecretFields(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (pathParts.length === 0 && key === 'vars') continue;
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
