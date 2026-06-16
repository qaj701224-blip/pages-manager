import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ALLOWED_FIELDS = new Set(['environment', 'site', 'dir', 'visibility', 'artifactKind']);
const SECRET_FIELD_RE = /token|access.?key|cookie|secret|cloudflare|accountid|zoneid|namespaceid|capability/i;
const VALID_ENVIRONMENTS = new Set(['production', 'staging']);
const VALID_VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
const VALID_ARTIFACT_KINDS = new Set(['static', 'spa', 'worker']);

export async function readCommandConfig(filePath, { cwd = process.cwd() } = {}) {
  if (!filePath) return null;
  const absolutePath = path.resolve(cwd, filePath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateCommandConfig(parsed);
}

export function validateCommandConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_INVALID');
  assertNoSecretFields(value);
  assertNoLegacyDomain(value);

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
  if (key === 'artifactKind') {
    if (!VALID_ARTIFACT_KINDS.has(value)) throw new Error('COMMAND_CONFIG_ARTIFACT_KIND_INVALID');
    return value;
  }
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`COMMAND_CONFIG_${key.toUpperCase()}_INVALID`);
  return value.trim();
}

function assertNoSecretFields(value, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const fullPath = [...pathParts, key].join('.');
    if (SECRET_FIELD_RE.test(key.replaceAll('_', ''))) throw new Error(`COMMAND_CONFIG_SECRET_FIELD:${fullPath}`);
    assertNoSecretFields(nested, [...pathParts, key]);
  }
}

function assertNoLegacyDomain(value) {
  if (typeof value === 'string' && /(^|\.)workers\.xd\.team(?::|\/|$)/i.test(value)) {
    throw new Error('COMMAND_CONFIG_LEGACY_DOMAIN_UNSUPPORTED');
  }
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) assertNoLegacyDomain(nested);
}
