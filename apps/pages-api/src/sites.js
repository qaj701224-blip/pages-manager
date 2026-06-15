import { authenticateApiRequest } from './auth.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { newId } from './id.js';

const VISIBILITIES = new Set(['public', 'org', 'acl', 'owner', 'disabled']);
const RESERVED_SLUGS = new Set(['api', 'auth', 'admin', 'www', 'mail', 'static', 'assets']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export async function handleSitesApi(request, env, config, store) {
  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) return authErrorResponse(auth.error);

  const url = new URL(request.url);
  if (url.pathname === '/.xd-pages/api/sites') {
    if (request.method === 'GET') return listSites(store, auth.actor);
    if (request.method === 'POST') return createSite(request, env, config, store, auth.actor);
    return methodNotAllowed();
  }

  const siteId = matchSiteId(url.pathname);
  if (siteId && request.method === 'GET') return getSite(store, auth.actor, siteId);
  if (siteId) return methodNotAllowed();

  return null;
}

async function listSites(store, actor) {
  const sites = await store.listSitesForUser(actor.userId, actor);
  return jsonOk({
    sites: sites.map(formatSite),
  });
}

async function getSite(store, actor, siteId) {
  const site = await store.getSiteForUser(siteId, actor.userId, actor);
  if (!site) return jsonError('SITE_NOT_FOUND', 'Site not found.', 404, 'Check the site id.');
  return jsonOk({ site: formatSite(site) });
}

async function createSite(request, env, config, store, actor) {
  if (actor.type !== 'user') {
    return jsonError('SITE_CREATE_FORBIDDEN', 'Access keys cannot create sites.', 403, 'Use a user CLI token.');
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 32 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const slug = normalizeSlug(body.slug);
  const visibility = body.visibility || 'org';
  const slugError = validateSlug(slug, config.environment);
  if (slugError) return slugError;
  if (!VISIBILITIES.has(visibility)) {
    return jsonError('SITE_VISIBILITY_INVALID', 'Site visibility is invalid.', 400, 'Use public, org, acl, owner, or disabled.');
  }

  const siteId = nextId(env, 'site');
  const routeId = nextId(env, 'route');
  const siteUuid = nextId(env, 'uuid');
  const hostname = hostnameForSlug(slug, config);

  let site;
  try {
    site = await store.createSite({
      id: siteId,
      slug,
      ownerUserId: actor.userId,
      siteUuid,
      defaultVisibility: visibility,
      environment: config.environment,
      routeId,
      hostname,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/SITE_SLUG_CONFLICT/.test(message)) {
      return jsonError('SITE_SLUG_CONFLICT', 'Site slug already exists.', 409, 'Choose a different site slug.');
    }
    throw error;
  }

  const route = await store.getRouteBySiteId(site.id);
  return jsonOk({ site: formatSite({ ...site, route }) }, 201);
}

function validateSlug(slug, environment) {
  if (!slug || !SLUG_RE.test(slug)) {
    return jsonError('SITE_SLUG_INVALID', 'Site slug is invalid.', 400, 'Use lowercase letters, numbers, and hyphens.');
  }
  if (RESERVED_SLUGS.has(slug) || (environment === 'production' && slug.endsWith('-staging'))) {
    return jsonError('SITE_SLUG_RESERVED', 'Site slug is reserved.', 400, 'Choose a different site slug.');
  }
  return null;
}

function formatSite(site) {
  const route = site.route || null;
  return {
    id: site.id,
    slug: site.slug,
    environment: site.environment,
    defaultVisibility: site.defaultVisibility,
    url: route ? `https://${route.hostname}` : null,
    route: route
      ? {
          id: route.id,
          hostname: route.hostname,
          status: route.routeStatus,
          runtime: route.runtime,
          activeVersionId: route.activeVersionId,
          routeGeneration: route.routeGeneration,
          policyVersion: route.policyVersion,
        }
      : null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function hostnameForSlug(slug, config) {
  if (config.environment === 'staging') return `${slug}-staging.${config.siteDomainSuffix}`;
  return `${slug}.${config.siteDomainSuffix}`;
}

function normalizeSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function matchSiteId(pathname) {
  const match = pathname.match(/^\/\.xd-pages\/api\/sites\/([^/]+)$/);
  return match ? match[1] : null;
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function authErrorResponse(error) {
  return jsonError(error.code, error.message, error.status, error.action);
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
