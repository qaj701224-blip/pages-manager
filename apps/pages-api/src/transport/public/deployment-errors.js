import { jsonError } from '../../http.js';
import { buildDeploymentFailureDiagnostics } from './deployment-diagnostics.js';

export function rollbackVersionAvailabilityErrorResponse(error) {
  if (error.reason === 'artifact_unavailable') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Deploy a new version because this version artifact is no longer active.'
    );
  }

  if (error.reason === 'source_deployment_unavailable') {
    return jsonError(
      'ROLLBACK_VERSION_UNAVAILABLE',
      'Version is not available for rollback.',
      409,
      'Rollback to a version from a succeeded deployment.'
    );
  }

  return jsonError(
    'ROLLBACK_VERSION_UNAVAILABLE',
    'Version is not available for rollback.',
    409,
    'Normal Worker slot versions are legacy-only. Deploy a new WFP version instead.'
  );
}

export function rollbackActivationFailurePatch(
  version,
  previousRoute,
  { errorCode, errorMessage, failureStage, errorClass, executionProviderFallback = 'unknown' }
) {
  return {
    versionId: version.id,
    previousVersionId: previousRoute?.activeVersionId || null,
    errorCode,
    errorMessage,
    failureStage,
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: failureStage,
      executionProvider: version.executionProvider || executionProviderFallback,
      deploymentShape: version.deploymentShape,
      plannedVersionId: version.id,
      plannedWorkerName: version.workerName,
      routeActivatedInD1: false,
      routePointerCommitted: false,
      cause: { code: errorCode, class: errorClass },
    }),
  };
}

export function runtimeConfigFailurePatch({
  errorCode = 'RUNTIME_CONFIG_UNSUPPORTED',
  errorMessage = 'Runtime configuration is unavailable.',
} = {}) {
  return {
    errorCode,
    errorMessage,
    failureStage: 'runtime_config',
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: 'runtime_config',
      executionProvider: 'unknown',
      cause: { code: errorCode, class: 'runtime_config_error' },
    }),
  };
}

export function runtimeConfigResolutionErrorMessage(errorCode) {
  return errorCode === 'RUNTIME_CONFIG_UNSUPPORTED'
    ? 'Runtime configuration is unavailable.'
    : 'Runtime bindings are invalid.';
}

export function deploymentOperationFailurePatch({ errorCode, errorMessage, operatorAction = 'retry_deploy' }) {
  return {
    errorCode,
    errorMessage,
    failureStage: 'deployment_operation',
    failureDiagnostics: buildDeploymentFailureDiagnostics({
      stage: 'deployment_operation',
      executionProvider: 'unknown',
      operatorAction,
      cause: { code: errorCode, class: 'deployment_operation_error' },
    }),
  };
}

export function runtimeConfigUnavailable() {
  return jsonError(
    'RUNTIME_CONFIG_UNSUPPORTED',
    'Runtime configuration is unavailable.',
    503,
    'Check runtime configuration and retry with a new Idempotency-Key.'
  );
}

export function initialRuntimeConfigResolutionFailure(error) {
  if (error.code === 'RUNTIME_BINDING_NAME_CONFLICT') {
    return jsonError(
      'RUNTIME_BINDING_NAME_CONFLICT',
      'Runtime binding names conflict.',
      400,
      'Use unique names for vars and site secrets.'
    );
  }
  if (error.code === 'RUNTIME_BINDINGS_LIMIT_EXCEEDED') {
    return jsonError(
      'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
      'Runtime bindings exceed platform limits.',
      400,
      'Reduce vars or site secrets and retry.'
    );
  }
  return jsonError(
    'RUNTIME_CONFIG_UNSUPPORTED',
    'Runtime configuration is unavailable.',
    503,
    error.reason === 'capability_unavailable'
      ? 'Retry later.'
      : 'Check runtime configuration and retry with a new Idempotency-Key.'
  );
}

export function runtimeConfigSnapshotFailure(error) {
  if (error.code === 'RUNTIME_CONFIG_CHANGED') {
    return {
      code: 'RUNTIME_CONFIG_CHANGED',
      message: 'Runtime configuration changed while deployment was starting.',
      status: 409,
      action: 'Retry the deployment with a new Idempotency-Key.',
    };
  }
  return {
    code: 'RUNTIME_CONFIG_UNSUPPORTED',
    message: 'Runtime configuration is unavailable.',
    status: 503,
    action: 'Check runtime configuration and retry with a new Idempotency-Key.',
  };
}

export function runtimeConfigCommitTraceFailure(error) {
  if (error?.reason === 'snapshot_validation_failed') {
    const failure = runtimeConfigSnapshotFailure(error);
    return {
      errorCode: failure.code,
      errorMessage: failure.message,
      diagnostics: { causeClass: 'runtime_config_changed' },
    };
  }
  return {
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
    errorMessage: 'Runtime configuration is unavailable.',
    diagnostics: { causeClass: 'runtime_config_error' },
  };
}

export function rollbackOfficeNetOperationError(error) {
  return deploymentOperationError(error.code, {
    message: 'The current public Worker version could not be verified before rollback.',
  });
}

export function deploymentOperationError(code, { message, action, cause } = {}) {
  const defaults = {
    SITE_POLICY_LOCKED: {
      message: 'Site policy is being changed. Retry the deployment.',
      action: 'Retry the deployment with a new Idempotency-Key.',
      status: 409,
    },
    ROUTE_ACTIVATION_CONFLICT: {
      message: 'Route changed while deployment was activating.',
      action: 'Check the latest site status and retry the deployment with a new Idempotency-Key.',
      status: 409,
    },
    SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED: {
      message: 'The public Worker still has an OfficeNet binding that could not be removed.',
      action: 'Check the active Worker settings and retry the deployment.',
      status: 503,
    },
    SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED: {
      message: 'The public Worker OfficeNet binding could not be verified absent.',
      action: 'Check the active Worker settings and retry the deployment.',
      status: 503,
    },
    ROUTE_SNAPSHOT_WRITE_FAILED: {
      message: 'Route snapshot could not be written.',
      action: 'Repair the route snapshot before retrying the deployment.',
      status: 503,
    },
  }[code] || {
    message: 'Deployment operation failed.',
    action: 'Retry the deployment with a new Idempotency-Key.',
    status: 409,
  };
  const error = new Error(message || defaults.message, { cause });
  error.code = code;
  error.status = defaults.status;
  error.action = action || defaults.action;
  return error;
}

export function rollbackRouteSnapshotRecoveryError(failure) {
  if (!failure) return null;
  if (failure.kind === 'route_restore') {
    return deploymentOperationError('ROUTE_SNAPSHOT_WRITE_FAILED', {
      message: 'The rollback route could not be restored after the snapshot write failed.',
      action: 'Repair the route snapshot before retrying the rollback.',
      cause: failure.error,
    });
  }
  if (failure.kind === 'safe_route_update') {
    return deploymentOperationError('SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', {
      message: 'The public rollback could not be compensated to a safe internal route.',
      action: 'Keep the site unavailable and repair the route before retrying the rollback.',
      cause: failure.error,
    });
  }
  return failure.error;
}

export function siteNotFound(action) {
  return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, action);
}

export function idempotencyConflict() {
  return jsonError(
    'IDEMPOTENCY_CONFLICT',
    'Idempotency-Key was already used with a different request.',
    409,
    'Retry with the original request or use a new Idempotency-Key.'
  );
}
