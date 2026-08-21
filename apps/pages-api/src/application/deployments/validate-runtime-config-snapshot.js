import { runtimeConfigSnapshotsEqual } from '../../domain/runtime-config/snapshots.js';

export function createDeploymentRuntimeConfigSnapshotValidation({ runtimeConfig }) {
  return { validate };

  async function validate(command) {
    if (typeof runtimeConfig?.listVars !== 'function' || typeof runtimeConfig?.listSecrets !== 'function') {
      return failed('RUNTIME_CONFIG_UNSUPPORTED');
    }
    let actualVars;
    let actualSecrets;
    try {
      actualVars = await runtimeConfig.listVars(command.environment, command.siteId);
      actualSecrets = await runtimeConfig.listSecrets(command.environment, command.siteId);
    } catch {
      return failed('RUNTIME_CONFIG_UNSUPPORTED');
    }
    if (runtimeConfigSnapshotsEqual(command.expectedVars, command.expectedSecrets, actualVars, actualSecrets)) {
      return { ok: true };
    }
    return failed('RUNTIME_CONFIG_CHANGED');
  }
}

function failed(code) {
  return { ok: false, error: { code } };
}
