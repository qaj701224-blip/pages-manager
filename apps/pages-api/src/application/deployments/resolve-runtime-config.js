import { runtimeVarsObject, validateRuntimeBindingQuotas } from '../../domain/runtime-config/rules.js';

export function createDeploymentRuntimeConfigResolution({ runtimeConfig, telemetry }) {
  if (typeof runtimeConfig?.hashInput !== 'function') throw new TypeError('runtimeConfig.hashInput is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');

  return { resolve };

  function resolve(command) {
    const stage = telemetry.start();
    return resolveAfterStart(command, stage);
  }

  async function resolveAfterStart(command, stage) {
    const workerRequired = command.workerRequired === true;
    if (!workerRequired) await telemetry.finish(stage, { status: 'skipped' });
    const result = await resolveRuntimeConfig(command);
    if (workerRequired) {
      await telemetry.finish(stage, result.ok ? { status: 'succeeded' } : { status: 'failed', error: result.error });
    }
    return result;
  }

  async function resolveRuntimeConfig(command) {
    const workerRequired = command.workerRequired === true;
    let runtimeVars = {};
    let runtimeVarRecords = [];
    let originalRuntimeVarRecords = [];
    let runtimeSecrets = [];

    if (workerRequired) {
      if (typeof runtimeConfig.listVars !== 'function' || typeof runtimeConfig.listSecrets !== 'function') {
        return failed('RUNTIME_CONFIG_UNSUPPORTED', 'capability_unavailable');
      }
      try {
        originalRuntimeVarRecords = await runtimeConfig.listVars(command.environment, command.siteId);
        runtimeVarRecords = command.varsProvided ? runtimeVarRecordsFromObject(command.requestedVars) : originalRuntimeVarRecords;
        runtimeVars = runtimeVarsObject(runtimeVarRecords);
        runtimeSecrets = await runtimeConfig.listSecrets(command.environment, command.siteId);
      } catch {
        return failed('RUNTIME_CONFIG_UNSUPPORTED', 'resolution_failed');
      }
    }

    const firstValidation = validateBindings(runtimeVars, runtimeSecrets);
    if (firstValidation) return firstValidation;
    try {
      await runtimeConfig.hashInput(runtimeVars, runtimeSecrets);
    } catch {
      return failed('RUNTIME_CONFIG_UNSUPPORTED', 'resolution_failed');
    }
    const secondValidation = validateBindings(runtimeVars, runtimeSecrets);
    if (secondValidation) return secondValidation;

    return {
      ok: true,
      kind: workerRequired ? 'resolved' : 'skipped',
      runtimeVars,
      runtimeVarRecords,
      originalRuntimeVarRecords,
      runtimeSecrets,
      runtimeBindings: {
        vars: runtimeVars,
        secrets: runtimeSecrets.map((secret) => ({
          name: secret.name,
          value: secret.value,
          revision: secret.revision,
        })),
      },
    };
  }
}

function validateBindings(vars, secrets) {
  try {
    validateRuntimeBindingQuotas(vars, secrets);
    return null;
  } catch (error) {
    return failed(
      error?.message === 'RUNTIME_BINDING_NAME_CONFLICT' ? 'RUNTIME_BINDING_NAME_CONFLICT' : 'RUNTIME_BINDINGS_LIMIT_EXCEEDED'
    );
  }
}

function runtimeVarRecordsFromObject(vars = {}) {
  return Object.keys(vars)
    .sort()
    .map((name) => ({ name, value: vars[name], revision: 0 }));
}

function failed(code, reason) {
  return { ok: false, error: { code, ...(reason ? { reason } : {}) } };
}
