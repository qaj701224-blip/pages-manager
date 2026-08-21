import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { createDeploySiteResolution } from '../../application/deployments/resolve-deploy-site.js';
import { createRollbackSiteResolution } from '../../application/deployments/resolve-rollback-site.js';
import { createRollbackVersionValidation } from '../../application/deployments/validate-rollback-version.js';
import { createDeploySiteResolutionPort } from '../../application/ports/deploy-site-resolution.js';
import { createRollbackSiteResolutionPort } from '../../application/ports/rollback-site-resolution.js';
import { jsonError } from '../../http.js';
import { RESERVED_SITE_SLUG_ACTION } from '../shared/deployment-responses.js';
import { createSiteCreationApplication } from '../shared/site-creation-application.js';

export function createDeploySiteResolutionApplication({ store, env, config }) {
  const resolve = createDeploySiteResolution({
    sites: createDeploySiteResolutionPort(store),
    prepareSite: (command) => createSiteCreationApplication({ store, env, config }).prepare(command),
  });
  return { resolve };
}

export function createRollbackSiteResolutionApplication(store) {
  const resolve = createRollbackSiteResolution({
    sites: createRollbackSiteResolutionPort(store),
  });
  return { resolve };
}

export function createRollbackVersionValidationApplication(store) {
  return createRollbackVersionValidation({
    deployments: {
      get: (deploymentId, environment) => store.getDeployment(deploymentId, environment),
    },
  });
}

export function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeOptionalSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateDeploySiteSlug(siteSlug, environment, { allowReserved = false } = {}) {
  const validation = validateSiteSlug(siteSlug, { environment });
  if (validation.ok) return null;
  if (validation.error.code === 'RESERVED_SLUG') {
    if (allowReserved) return null;
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, RESERVED_SITE_SLUG_ACTION);
  }
  return jsonError(
    'SITE_SLUG_INVALID',
    'Site slug is invalid.',
    400,
    'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
  );
}

export function validateDeployableSiteSlug(siteSlug, environment) {
  return validateDeploySiteSlug(siteSlug, environment);
}
