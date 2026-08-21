import { readLegacyCloudflareConfig } from '../infrastructure/config/legacy-config.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export function createLegacyV1CloudflareClient(env) {
  const config = readLegacyCloudflareConfig(env);
  if (!config) throw cloudflareRequestError();
  const { apiToken: token, fetchImpl } = config;

  return {
    async listRoutes({ zoneId: requestedZoneId }) {
      const routes = [];
      for (let page = 1; page <= 100; page += 1) {
        const payload = await cloudflareFetch(
          `/zones/${encodeURIComponent(requestedZoneId)}/workers/routes?page=${page}&per_page=100`,
          token,
          fetchImpl,
          { includeMetadata: true }
        );
        if (!Array.isArray(payload?.result)) throw cloudflareRequestError();
        routes.push(...payload.result);
        const totalPages = Number(payload.result_info?.total_pages || page);
        if (!Number.isInteger(totalPages) || totalPages < page || page >= totalPages) return routes;
      }
      throw cloudflareRequestError();
    },
    async deleteRoute({ zoneId: requestedZoneId, routeId }) {
      return cloudflareFetch(
        `/zones/${encodeURIComponent(requestedZoneId)}/workers/routes/${encodeURIComponent(routeId)}`,
        token,
        fetchImpl,
        { method: 'DELETE', acceptNotFound: true }
      );
    },
    async deleteScript({ accountId: requestedAccountId, scriptName }) {
      return cloudflareFetch(
        `/accounts/${encodeURIComponent(requestedAccountId)}/workers/scripts/${encodeURIComponent(scriptName)}`,
        token,
        fetchImpl,
        { method: 'DELETE', acceptNotFound: true }
      );
    },
  };
}

async function cloudflareFetch(
  path,
  token,
  fetchImpl,
  { method = 'GET', acceptNotFound = false, includeMetadata = false } = {}
) {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (acceptNotFound && response.status === 404) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) throw cloudflareRequestError();
  return includeMetadata ? payload : payload?.result ?? payload;
}

function cloudflareRequestError() {
  const error = new Error('V1_CLOUDFLARE_REQUEST_FAILED');
  error.code = 'V1_CLOUDFLARE_REQUEST_FAILED';
  return error;
}
