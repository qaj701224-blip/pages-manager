import { runtimeVarsObject } from '../../domain/runtime-config/rules.js';
import { runtimeVarSnapshotsEqual } from '../../domain/runtime-config/snapshots.js';

export function createDeploymentRuntimeConfigRestoration({ runtimeConfig, clock, ids }) {
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { restore };

  async function restore(command) {
    if (!command.enabled || typeof runtimeConfig?.replaceVars !== 'function') return { kind: 'skipped' };
    try {
      if (typeof runtimeConfig.listVars === 'function') {
        const currentVars = await runtimeConfig.listVars(command.environment, command.siteId);
        if (!runtimeVarSnapshotsEqual(currentVars, command.expectedVars)) return { kind: 'stale' };
      }
      const runtimeVarRecords = await runtimeConfig.replaceVars({
        environment: command.environment,
        siteId: command.siteId,
        vars: runtimeVarsObject(command.restoreVars),
        actorId: command.actorId,
        updatedAt: clock.now(),
        createId: () => ids.next('var'),
      });
      return { kind: 'restored', runtimeVarRecords };
    } catch {
      return { kind: 'failed' };
    }
  }
}
