import { validateSiteSlug } from '@xd/pages-runtime-protocol';

import { normalizeSiteAclEntries } from '../../domain/sites/access-policy.js';
import { jsonError } from '../../http.js';
import { nextId } from '../../id.js';
import { siteAclErrorResponse } from './site-policy-application.js';

const RESERVED_SITE_SLUG_ACTION = '该站点名是 XD Cell 平台保留项，请换一个业务站点名。';

export function normalizeSiteSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateSiteSlugInput(slug, environment) {
  const validation = validateSiteSlug(slug, { environment });
  if (validation.ok) return null;
  if (validation.error.code === 'RESERVED_SLUG') {
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, RESERVED_SITE_SLUG_ACTION);
  }
  return jsonError(
    'SITE_SLUG_INVALID',
    'Site slug is invalid.',
    400,
    'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.'
  );
}

export function normalizeSiteAclInput(value, env) {
  try {
    return normalizeSiteAclEntries(value, { createId: () => nextId(env, 'acl') });
  } catch (error) {
    const response = siteAclErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export function rejectUserExposureMutation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'exposure')) return null;
  return jsonError(
    'SITE_EXPOSURE_ADMIN_REQUIRED',
    'Site exposure can only be changed by a platform admin.',
    403,
    'Use the Admin Console exposure control.'
  );
}
