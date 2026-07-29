import { hashAccessKey } from './crypto.js';

export async function runtimeConfigHashInput(env, vars = {}, secrets = []) {
  return {
    vars: await Promise.all(
      Object.keys(vars)
        .sort()
        .map(async (name) => ({
          name,
          valueHash: await runtimeVarValueHash(env, name, vars[name]),
        }))
    ),
    secrets: secrets
      .map((secret) => ({
        name: secret.name,
        revision: secret.revision,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function runtimeSecretSnapshotRecords(env, secrets = []) {
  return Promise.all(
    secrets.map(async (secret) => ({
      ...secret,
      valueHash: await runtimeSecretValueHash(env, secret.name, secret.value),
    }))
  );
}

async function runtimeVarValueHash(env, name, value) {
  return hashAccessKey(`xd-pages-runtime-var-v1\0${name}\0${value}`, readRuntimeConfigHashPepper(env));
}

async function runtimeSecretValueHash(env, name, value) {
  return hashAccessKey(`xd-pages-runtime-secret-v1\0${name}\0${value}`, readRuntimeConfigHashPepper(env));
}

function readRuntimeConfigHashPepper(env) {
  const explicit = env.RUNTIME_CONFIG_HASH_PEPPER;
  if (typeof explicit === 'string' && explicit) return explicit;
  const activePepperId = String(env.ACCESS_KEY_ACTIVE_PEPPER_ID || '').trim();
  if (activePepperId) {
    const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
    for (const entry of registry.split(',')) {
      const [pepperId, secretEnvName] = entry.split(':').map((part) => part.trim());
      if (pepperId !== activePepperId || !secretEnvName) continue;
      const value = env[secretEnvName];
      if (typeof value === 'string' && value) return value;
    }
  }
  const requestHashPepper = env.REQUEST_HASH_PEPPER;
  if (typeof requestHashPepper === 'string' && requestHashPepper) return requestHashPepper;
  if (!activePepperId) {
    const registry = String(env.ACCESS_KEY_PEPPERS || '').trim();
    for (const entry of registry.split(',')) {
      const [, secretEnvName] = entry.split(':').map((part) => part.trim());
      if (!secretEnvName) continue;
      const value = env[secretEnvName];
      if (typeof value === 'string' && value) return value;
    }
  }
  throw new Error('RUNTIME_CONFIG_HASH_PEPPER_REQUIRED');
}

export async function assertRuntimeConfigSnapshotUnchanged(store, environment, siteId, expectedVars, expectedSecrets) {
  let actualSecrets;
  let actualVars;
  try {
    actualVars = await store.listEnabledSiteVars(environment, siteId);
    actualSecrets = await store.listEnabledSiteSecrets(environment, siteId);
  } catch {
    return {
      code: 'RUNTIME_CONFIG_UNSUPPORTED',
      message: 'Runtime configuration is unavailable.',
      status: 503,
      action: 'Check runtime configuration and retry with a new Idempotency-Key.',
    };
  }
  if (runtimeVarSnapshotsEqual(expectedVars, actualVars) && runtimeSecretSnapshotsEqual(expectedSecrets, actualSecrets)) {
    return null;
  }
  return {
    code: 'RUNTIME_CONFIG_CHANGED',
    message: 'Runtime configuration changed while deployment was starting.',
    status: 409,
    action: 'Retry the deployment with a new Idempotency-Key.',
  };
}

function runtimeVarSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeVarSnapshot(left);
  const normalizedRight = runtimeVarSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.value === other.value && entry.revision === other.revision;
  });
}

function runtimeVarSnapshot(vars = []) {
  const records = Array.isArray(vars) ? vars : Object.keys(vars || {}).map((name) => ({ name, value: vars[name], revision: 0 }));
  return records
    .map((record) => ({
      name: record.name,
      value: record.value,
      revision: Number(record.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function runtimeSecretSnapshotsEqual(left = [], right = []) {
  const normalizedLeft = runtimeSecretSnapshot(left);
  const normalizedRight = runtimeSecretSnapshot(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return entry.name === other.name && entry.revision === other.revision;
  });
}

export function siteVarRecordsFromObject(vars = {}) {
  return Object.keys(vars)
    .sort()
    .map((name) => ({ name, value: vars[name], revision: 0 }));
}

export function runtimeVarsFromRecords(records = []) {
  return Object.fromEntries(records.map((record) => [record.name, record.value]));
}

export async function restoreSiteVarsAfterFailedDeployment(
  store,
  { environment, siteId, restoreVars, expectedVars, actorId, updatedAt, createId, enabled } = {}
) {
  if (!enabled || typeof store.replaceSiteVars !== 'function') return;
  try {
    if (typeof store.listEnabledSiteVars === 'function') {
      const currentVars = await store.listEnabledSiteVars(environment, siteId);
      if (!runtimeVarSnapshotsEqual(currentVars, expectedVars)) return;
    }
    await store.replaceSiteVars({
      environment,
      siteId,
      vars: runtimeVarsFromRecords(restoreVars),
      actorId,
      updatedAt,
      createId,
    });
  } catch {
    // Best effort: the original deployment failure is still the user-facing error.
  }
}

function runtimeSecretSnapshot(secrets = []) {
  return secrets
    .map((secret) => ({
      name: secret.name,
      revision: Number(secret.revision || 0),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
