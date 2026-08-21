import { hashAccessKey } from './crypto.js';
import { runtimeVarSnapshotsEqual } from './domain/runtime-config/snapshots.js';
import { readRuntimeConfigHashPepper } from './infrastructure/config/runtime-config.js';

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
