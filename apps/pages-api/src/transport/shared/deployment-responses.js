import { jsonError } from '../../http.js';

export const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';

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

export function deploySiteResolutionErrorResponse(error) {
  if (error?.code === 'SITE_NOT_FOUND_BY_ID') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  }
  if (error?.code === 'SITE_NOT_FOUND_BY_SLUG') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug.');
  }
  if (error?.code === 'SITE_NOT_FOUND_BY_SLUG_SCOPE') {
    return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site slug and access key scope.');
  }
  if (error?.code === 'SITE_SLUG_RESERVED') {
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, RESERVED_SITE_SLUG_ACTION);
  }
  if (error?.code === 'SITE_SLUG_INVALID') {
    return jsonError(
      'SITE_SLUG_INVALID',
      'Site slug is invalid.',
      400,
      'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
    );
  }
  if (error?.code === 'DEPLOY_TRANSFER_FORBIDDEN_CURRENT') {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot transfer this site before deployment.',
      403,
      'Use a publisher/admin role or owner-scoped access key for the current site.'
    );
  }
  if (error?.code === 'DEPLOY_TRANSFER_FORBIDDEN_TARGET') {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot transfer this site to the requested team.',
      403,
      'Use an owner-scoped access key for the target team.'
    );
  }
  if (error?.code === 'TEAM_REQUIRED') {
    return jsonError('TEAM_REQUIRED', 'Team id is required.', 400, 'Choose a team.');
  }
  if (error?.code === 'TEAM_NOT_FOUND') {
    return jsonError('TEAM_NOT_FOUND', 'Team not found.', 404, 'Check the team id.');
  }
  if (error?.code === 'TEAM_PUBLISHER_REQUIRED') {
    return jsonError(
      'TEAM_PUBLISHER_REQUIRED',
      'Team publisher role required.',
      403,
      'Ask a team publisher to deploy this site.'
    );
  }
  if (error?.code === 'SITE_TRANSFER_UNSUPPORTED') {
    return jsonError('SITE_TRANSFER_UNSUPPORTED', 'Site transfer is unavailable.', 503, 'Retry later.');
  }
  if (error?.code === 'TEAM_OWNER_VISIBILITY_UNSUPPORTED') {
    return jsonError(
      'SITE_VISIBILITY_INVALID',
      'Team-owned sites cannot use owner visibility.',
      400,
      'Use internal, org, acl, or disabled for team-owned sites.'
    );
  }
  if (error?.code === 'DEPLOY_FORBIDDEN_SCOPE') {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use a token scoped to deploy sites.');
  }
  if (error?.code === 'DEPLOY_FORBIDDEN_TEAM_OWNER') {
    return jsonError(
      'DEPLOY_FORBIDDEN',
      'Actor cannot deploy this site.',
      403,
      'Use a user CLI token or an owner-scoped access key for this team.'
    );
  }
  if (error?.code === 'DEPLOY_FORBIDDEN_INACTIVE_OWNER') {
    return jsonError('DEPLOY_FORBIDDEN', 'Actor cannot deploy this site.', 403, 'Use an active owner-scoped access key.');
  }
  throw new TypeError(`Unknown deploy site resolution error: ${error?.code || 'UNKNOWN'}`);
}
