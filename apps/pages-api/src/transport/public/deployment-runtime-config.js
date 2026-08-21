import { createDeploymentRuntimeConfigCommit } from '../../application/deployments/commit-runtime-config.js';
import { createDeploymentRuntimeConfigResolution } from '../../application/deployments/resolve-runtime-config.js';
import { createDeploymentRuntimeConfigRestoration } from '../../application/deployments/restore-runtime-config.js';
import {
  createDeploymentRuntimeConfigSnapshotValidation,
} from '../../application/deployments/validate-runtime-config-snapshot.js';
import {
  createDeploymentRuntimeConfigMutationPort,
  createDeploymentRuntimeConfigResolutionPort,
  createDeploymentRuntimeConfigSnapshotPort,
} from '../../application/ports/runtime-config.js';
import { runtimeConfigHashInput } from '../../deployment-runtime-config.js';
import { finishDeploymentStage, startDeploymentStage } from '../../deployment-trace.js';
import { nextId } from '../../id.js';
import {
  runtimeConfigCommitTraceFailure,
  runtimeConfigResolutionErrorMessage,
  runtimeConfigSnapshotFailure,
} from './deployment-errors.js';

export function createDeploymentRuntimeConfigResolutionApplication(store, env, trace = null) {
  return createDeploymentRuntimeConfigResolution({
    runtimeConfig: createDeploymentRuntimeConfigResolutionPort(store, {
      hashInput: (vars, secrets) => runtimeConfigHashInput(env, vars, secrets),
    }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'runtime_config',
              operation: 'resolve_runtime_config',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed'
                ? {
                    errorCode: outcome.error.code,
                    errorMessage: runtimeConfigResolutionErrorMessage(outcome.error.code),
                    diagnostics: { causeClass: 'runtime_config_error' },
                  }
                : {}),
            })
          : undefined,
    },
  });
}

export function createDeploymentRuntimeConfigCommitApplication(store, env, trace = null) {
  const runtimeConfig = createDeploymentRuntimeConfigMutationPort(store);
  return createDeploymentRuntimeConfigCommit({
    runtimeConfig,
    snapshotValidation: createDeploymentRuntimeConfigSnapshotValidation({ runtimeConfig }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'runtime_config_commit',
              operation: 'commit_runtime_config',
            })
          : null,
      finish: (stage, outcome) =>
        stage
          ? finishDeploymentStage(stage, {
              status: outcome.status,
              ...(outcome.status === 'failed' ? runtimeConfigCommitTraceFailure(outcome.error) : {}),
            })
          : undefined,
    },
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

export function createDeploymentRuntimeConfigRestorationApplication(store, env) {
  return createDeploymentRuntimeConfigRestoration({
    runtimeConfig: createDeploymentRuntimeConfigMutationPort(store),
    clock: { now: () => readNow(env) },
    ids: { next: (prefix) => nextId(env, prefix) },
  });
}

export async function validateDeploymentRuntimeConfigSnapshot(store, command) {
  const application = createDeploymentRuntimeConfigSnapshotValidation({
    runtimeConfig: createDeploymentRuntimeConfigSnapshotPort(store),
  });
  const result = await application.validate(command);
  return result.ok ? null : runtimeConfigSnapshotFailure(result.error);
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
