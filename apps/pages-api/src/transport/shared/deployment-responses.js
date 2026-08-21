import { jsonError } from '../../http.js';

export function deploymentStateWriteFailed() {
  return jsonError(
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'Deployment state could not be persisted.',
    503,
    'Retry the deployment with a new Idempotency-Key.'
  );
}

export function deploymentRequestFailed() {
  return jsonError(
    'DEPLOYMENT_REQUEST_FAILED',
    'Deployment request could not be processed.',
    500,
    'Check deployment status using the trace id. Retry with a new Idempotency-Key only when no terminal deployment exists.'
  );
}

export function deploymentAuthErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

export function deploymentMethodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

export function rollbackSiteResolutionErrorResponse(error) {
  if (error?.code === 'VERSION_NOT_FOUND') {
    return jsonError('VERSION_NOT_FOUND', 'Version not found.', 404, 'Check the version id.');
  }
  if (error?.code === 'SITE_NOT_FOUND') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  }
  if (error?.code === 'ROLLBACK_SITE_MISMATCH') {
    return jsonError(
      'ROLLBACK_SITE_MISMATCH',
      'Rollback version does not belong to the requested site.',
      409,
      'Check the site name and version id.'
    );
  }
  if (error?.code === 'ROLLBACK_FORBIDDEN') {
    return jsonError('ROLLBACK_FORBIDDEN', 'Actor cannot rollback this site.', 403, 'Use a token scoped to this site.');
  }
  throw new TypeError(`Unknown rollback site resolution error: ${error?.code || 'UNKNOWN'}`);
}
