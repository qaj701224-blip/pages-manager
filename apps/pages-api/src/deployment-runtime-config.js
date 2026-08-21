import { hashAccessKey } from './crypto.js';
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
