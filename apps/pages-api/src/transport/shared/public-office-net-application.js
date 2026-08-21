import { createPublicWorkerOfficeNetGuard } from '../../application/deployments/ensure-public-office-net.js';
import { finishDeploymentStage, startDeploymentStage } from '../../deployment-trace.js';
import { createPublicOfficeNetSettings } from '../../infrastructure/providers/public-office-net-settings.js';

export async function ensurePublicWorkerOfficeNetAbsent(provider, command) {
  const { store, trace, ...input } = command;
  const result = await createPublicWorkerOfficeNetGuardApplication(store, trace).ensure({
    ...input,
    provider,
  });
  if (result.ok) return result.result;
  throw publicOfficeNetOperationError(result.error);
}

export function publicOfficeNetOperationError(error) {
  if (error.reason === 'deployment_shape_unknown') {
    return officeNetError(error.code, {
      message: 'The public Worker deployment shape is not recognized.',
      action: 'Deploy a known Worker shape and retry the public activation.',
    });
  }
  if (error.reason === 'execution_provider_unsupported') {
    return officeNetError(error.code, {
      message: 'The public Worker execution provider cannot verify OfficeNet bindings.',
      action: 'Use a supported execution provider and retry the public activation.',
    });
  }
  return officeNetError(error.code, { cause: error.cause?.cause || error.cause });
}

export function isPublicOfficeNetFailure(error) {
  return error?.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' || error?.code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED';
}

export function createPublicWorkerOfficeNetGuardApplication(store, trace = null) {
  return createPublicWorkerOfficeNetGuard({
    settings: createPublicOfficeNetSettings({
      withRuntimeConfigLock:
        typeof store?.withRuntimeConfigLock === 'function' ? store.withRuntimeConfigLock.bind(store) : undefined,
    }),
    telemetry: {
      start: () =>
        trace
          ? startDeploymentStage(trace, {
              stage: 'office_net',
              operation: 'verify_public_office_net_absent',
            })
          : null,
      finish: (stage, outcome) => {
        if (!stage) return undefined;
        const error = outcome.error ? publicOfficeNetOperationError(outcome.error) : outcome.cause;
        return finishDeploymentStage(stage, {
          status: outcome.status,
          ...(outcome.status === 'failed'
            ? {
                error,
                errorCode: error?.code || 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
                errorMessage: error?.message || 'Public Worker OfficeNet verification failed.',
                diagnostics: { causeClass: 'public_office_net_error' },
              }
            : {}),
        });
      },
    },
  });
}

function officeNetError(code, { message, action, cause } = {}) {
  const defaults = {
    SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED: {
      message: 'The public Worker still has an OfficeNet binding that could not be removed.',
      action: 'Check the active Worker settings and retry the deployment.',
    },
    SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED: {
      message: 'The public Worker OfficeNet binding could not be verified absent.',
      action: 'Check the active Worker settings and retry the deployment.',
    },
  }[code] || {
    message: 'Deployment operation failed.',
    action: 'Retry the deployment with a new Idempotency-Key.',
  };
  const result = new Error(message || defaults.message, { cause });
  result.code = code;
  result.status = 503;
  result.action = action || defaults.action;
  return result;
}
