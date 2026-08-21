const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_BINDING_NAMES = new Set(['ASSETS', 'XD_PAGES_KV_GATEWAY']);
const RESERVED_BINDING_PREFIXES = ['XD_', 'XD_CELL_', 'XD_PAGES_', 'CF_'];
const SENSITIVE_VAR_RE = /token|secret|password|credential|cookie|private.?key|api.?key|access.?key/i;

export const MAX_RUNTIME_VARS = 64;
export const MAX_SITE_SECRETS = 64;
export const MAX_RUNTIME_BINDINGS = 64;
export const MAX_RUNTIME_VAR_VALUE_BYTES = 8 * 1024;
export const MAX_SITE_SECRET_VALUE_BYTES = 8 * 1024;

export function normalizeRuntimeVars(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RUNTIME_VARS_INVALID');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    validateRuntimeBindingName(key);
    if (SENSITIVE_VAR_RE.test(key)) throw new Error('RUNTIME_VARS_INVALID');
    if (typeof value[key] !== 'string') throw new Error('RUNTIME_VARS_INVALID');
    if (byteLength(value[key]) > MAX_RUNTIME_VAR_VALUE_BYTES) throw new Error('RUNTIME_VARS_LIMIT_EXCEEDED');
    output[key] = value[key];
  }
  if (Object.keys(output).length > MAX_RUNTIME_VARS) throw new Error('RUNTIME_VARS_LIMIT_EXCEEDED');
  return output;
}

export function runtimeVarsObject(records = []) {
  return Object.fromEntries(records.map((record) => [record.name, record.value]));
}

export function runtimeVarObjectsEqual(left = {}, right = {}) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name])
  );
}

export function normalizeRuntimeSecretName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  validateRuntimeBindingName(name);
  return name;
}

export function validateRuntimeBindingName(name) {
  if (!BINDING_NAME_RE.test(name)) throw new Error('RUNTIME_BINDING_NAME_INVALID');
  if (RESERVED_BINDING_NAMES.has(name) || RESERVED_BINDING_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new Error('RUNTIME_BINDING_NAME_RESERVED');
  }
  return name;
}

export function runtimeBindingsForProvider(runtimeBindings = {}) {
  const vars = runtimeBindings.vars || {};
  const secrets = runtimeBindings.secrets || [];
  const names = new Set();
  const bindings = [];
  for (const name of Object.keys(vars).sort()) {
    assertRuntimeNameAvailable(name, names);
    bindings.push({ type: 'plain_text', name, text: vars[name] });
  }
  for (const secret of secrets) {
    assertRuntimeNameAvailable(secret.name, names);
    bindings.push({ type: 'secret_text', name: secret.name, text: secret.value });
  }
  return bindings;
}

export function validateRuntimeBindingQuotas(vars = {}, secrets = []) {
  const varNames = Object.keys(vars);
  if (varNames.length > MAX_RUNTIME_VARS) throw new Error('RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  if (secrets.length > MAX_SITE_SECRETS) throw new Error('RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  if (varNames.length + secrets.length > MAX_RUNTIME_BINDINGS) throw new Error('RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  const names = new Set();
  for (const name of varNames) {
    assertRuntimeNameAvailable(name, names);
    if (byteLength(vars[name]) > MAX_RUNTIME_VAR_VALUE_BYTES) throw new Error('RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  }
  for (const secret of secrets) {
    assertRuntimeNameAvailable(secret.name, names);
    if (byteLength(secret.value || '') > MAX_SITE_SECRET_VALUE_BYTES) throw new Error('RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  }
  return true;
}

export function runtimeConfigSnapshot(vars = [], secrets = []) {
  return {
    vars: siteVarSnapshot(vars),
    secrets: secrets
      .map((secret) => ({
        name: secret.name,
        revision: Number(secret.revision || 0),
        ...(secret.valueHash ? { valueHash: secret.valueHash } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function siteVarSnapshot(vars) {
  const records = Array.isArray(vars)
    ? vars
    : Object.keys(vars || {}).map((name) => ({ name, value: vars[name], revision: 0 }));
  return records
    .map((record) => ({
      name: record.name,
      value: record.value,
      revision: Number(record.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertRuntimeNameAvailable(name, names) {
  validateRuntimeBindingName(name);
  if (names.has(name)) throw new Error('RUNTIME_BINDING_NAME_CONFLICT');
  names.add(name);
}

function byteLength(value) {
  return new globalThis.TextEncoder().encode(String(value)).byteLength;
}
