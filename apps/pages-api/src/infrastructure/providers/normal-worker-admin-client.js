export function createNormalWorkerAdminClient({ client, accountId, apiToken, fetch: fetchImpl } = {}) {
  if (client) return client;

  const normalizedAccountId = normalizeRequiredString(accountId);
  const normalizedApiToken = normalizeRequiredString(apiToken);
  if (!normalizedAccountId || !normalizedApiToken || typeof fetchImpl !== 'function') {
    throw new Error('NORMAL_WORKER_ADMIN_CLIENT_UNAVAILABLE');
  }

  return {
    async deleteWorker({ workerName }) {
      const url = new URL(
        `accounts/${encodeURIComponent(normalizedAccountId)}/workers/scripts/${encodeURIComponent(workerName)}`,
        'https://api.cloudflare.com/client/v4/'
      );
      const response = await fetchImpl(url.toString(), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${normalizedApiToken}` },
      });
      if (response.status === 404) return null;
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.success === false) throw deleteError(response, payload);
      return payload?.result || payload;
    },
  };
}

function deleteError(response, payload) {
  const error = new Error('NORMAL_WORKER_DELETE_FAILED');
  error.status = response.status;
  error.code = response.status === 409 ? 'NORMAL_WORKER_DELETE_BLOCKED' : 'NORMAL_WORKER_DELETE_FAILED';
  error.cloudflareErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  return error;
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
