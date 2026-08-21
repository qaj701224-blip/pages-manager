import { createSiteCreationPort } from '../../application/ports/site-creation.js';
import { createSiteCreation } from '../../application/sites/create-site.js';
import { hostnameForSiteSlug } from '../../domain/sites/creation.js';
import { jsonError } from '../../http.js';
import { newHexId, nextId } from '../../id.js';
import { createSiteWithLegacyV1Takeover } from '../../legacy-v1/takeover.js';

export function createSiteCreationApplication({ store, env, config }) {
  return createSiteCreation({
    siteCreation: createSiteCreationPort(store),
    legacyV1Takeover: ({ actor, siteInput }) => createSiteWithLegacyV1Takeover({ env, config, store, actor, siteInput }),
    ids: { next: (prefix) => nextId(env, prefix) },
    siteUuids: { next: () => nextSiteUuid(env) },
    hostnameForSlug: (slug) => hostnameForSiteSlug(slug, config),
  });
}

export function siteCreateErrorResponse(error) {
  const message = error instanceof Error ? error.message : '';
  const code = error?.code || message;
  if (/SITE_SLUG_CONFLICT/.test(message)) {
    return jsonError('SITE_SLUG_CONFLICT', 'Site slug already exists.', 409, 'Choose a different site slug.');
  }
  if (code === 'V1_TAKEOVER_STATE_CHANGED') {
    return jsonError('HOSTNAME_CLAIM_CONFLICT', 'Site hostname is already claimed.', 409, '请检查站点状态后重试。');
  }
  if (/HOSTNAME_CLAIM_CONFLICT/.test(message)) {
    return jsonError(
      'HOSTNAME_CLAIM_CONFLICT',
      'Site hostname is already claimed.',
      409,
      '请换一个站点名，或使用原站点 owner 继续部署。'
    );
  }
  if (code === 'V1_TAKEOVER_CONFIG_UNAVAILABLE' || code === 'V1_TAKEOVER_CLEANUP_FAILED') {
    return jsonError(
      'SITE_CREATE_UNAVAILABLE',
      'Site could not be created right now.',
      503,
      'Retry later with the same site name.'
    );
  }
  return null;
}

function nextSiteUuid(env) {
  if (typeof env?.nextSiteUuid === 'function') {
    const id = env.nextSiteUuid();
    if (id) return id;
  }
  return newHexId();
}
