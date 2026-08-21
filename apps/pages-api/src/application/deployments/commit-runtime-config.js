import { runtimeVarsObject } from '../../domain/runtime-config/rules.js';

export function createDeploymentRuntimeConfigCommit({ runtimeConfig, snapshotValidation, telemetry, clock, ids }) {
  if (typeof snapshotValidation?.validate !== 'function') {
    throw new TypeError('snapshotValidation.validate is required');
  }
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { commit };

  function commit(command) {
    const stage = telemetry.start();
    return commitAfterStart(command, stage);
  }

  async function commitAfterStart(command, stage) {
    const enabled = command.enabled;
    if (!enabled) await telemetry.finish(stage, { status: 'skipped' });
    const result = await commitRuntimeConfig(command, enabled);
    if (enabled) {
      await telemetry.finish(stage, result.ok ? { status: 'succeeded' } : { status: 'failed', error: result.error });
    }
    return result;
  }

  async function commitRuntimeConfig(command, enabled) {
    if (!enabled) return { ok: true, kind: 'skipped' };
    if (typeof runtimeConfig?.replaceVars !== 'function') {
      return failed('RUNTIME_CONFIG_UNSUPPORTED', 'capability_unavailable');
    }
    const snapshot = await snapshotValidation.validate({
      environment: command.environment,
      siteId: command.siteId,
      expectedVars: command.expectedVars,
      expectedSecrets: command.expectedSecrets,
    });
    if (!snapshot.ok) return failed(snapshot.error.code, 'snapshot_validation_failed');

    try {
      const runtimeVarRecords = await runtimeConfig.replaceVars({
        environment: command.environment,
        siteId: command.siteId,
        vars: command.requestedVars,
        actorId: command.actorId,
        updatedAt: clock.now(),
        createId: () => ids.next('var'),
      });
      return {
        ok: true,
        kind: 'committed',
        runtimeVarRecords,
        runtimeVars: runtimeVarsObject(runtimeVarRecords),
      };
    } catch {
      return failed('RUNTIME_CONFIG_UNSUPPORTED', 'mutation_failed');
    }
  }
}

function failed(code, reason) {
  return { ok: false, error: { code, reason } };
}
