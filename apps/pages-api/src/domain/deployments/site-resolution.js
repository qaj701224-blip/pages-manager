import { validateSiteSlug } from '@xd/pages-runtime-protocol';

export function validateNewDeploymentSiteSlug(siteSlug, environment) {
  const validation = validateSiteSlug(siteSlug, { environment });
  if (validation.ok) return { ok: true };
  return {
    ok: false,
    error: {
      code: validation.error.code === 'RESERVED_SLUG' ? 'SITE_SLUG_RESERVED' : 'SITE_SLUG_INVALID',
    },
  };
}
