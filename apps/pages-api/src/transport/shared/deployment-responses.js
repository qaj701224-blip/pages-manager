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
