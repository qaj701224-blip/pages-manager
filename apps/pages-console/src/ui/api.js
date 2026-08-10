export async function fetchJson(path, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const method = String(options.method || 'GET').toUpperCase();
  const csrfToken = options.csrfToken ?? (method === 'GET' || method === 'HEAD' ? '' : readCsrfToken());
  const headers = {
    Accept: 'application/json',
    ...(method === 'GET' || method === 'HEAD' ? {} : { 'Content-Type': 'application/json' }),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...(options.headers || {}),
  };

  const response = await fetchImpl(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'XD Cell API request failed');
    error.code = payload?.error?.code || 'API_REQUEST_FAILED';
    error.status = response.status;
    error.action = payload?.error?.action || '';
    throw error;
  }
  return payload;
}

export function readCsrfToken() {
  if (typeof globalThis.document === 'undefined') return '';
  const cookie = globalThis.document.cookie || '';
  for (const part of cookie.split(';')) {
    const [name, ...rawValue] = part.trim().split('=');
    if (name === '__Host-xd_cell_csrf') return decodeURIComponent(rawValue.join('='));
  }
  return '';
}

export function listAdminWebhooks(options = {}) {
  return fetchJson('/api/console/admin/webhooks', options);
}

export function getAdminDashboard(options = {}) {
  return fetchJson('/api/console/admin/dashboard', options);
}

export function getAdminOps(options = {}) {
  return fetchJson('/api/console/admin/ops', options);
}

export function listAdminNormalWorkers(options = {}) {
  return fetchJson('/api/console/admin/normal-workers', options);
}

export function listAdminDeploymentCleanups({ status, ...options } = {}) {
  const search = new URLSearchParams();
  if (status) search.set('status', status);
  const query = search.toString();
  return fetchJson(`/api/console/admin/deployment-cleanups${query ? `?${query}` : ''}`, options);
}

export function scanAdminWorkerOrphans(options = {}) {
  return fetchJson('/api/console/admin/worker-orphan-scan', options);
}

export function backfillAdminWorkerOrphans(workerNames, body = {}, options = {}) {
  return fetchJson('/api/console/admin/worker-orphan-scan/backfill', {
    ...options,
    method: 'POST',
    body: {
      ...body,
      workerNames,
    },
  });
}

export function listAdminV1Sites(options = {}) {
  return fetchJson('/api/console/admin/v1-sites', options);
}

export function deleteAdminV1Site(name, body = {}, options = {}) {
  return fetchJson(`/api/console/admin/v1-sites/${encodeURIComponent(name)}`, {
    ...options,
    method: 'DELETE',
    body,
  });
}

export function bulkRetireAdminV1Sites(names, body = {}, options = {}) {
  return fetchJson('/api/console/admin/v1-sites/bulk-retire', {
    ...options,
    method: 'POST',
    body: {
      ...body,
      names,
    },
  });
}

export function runAdminDeploymentCleanup(id, body = {}, options = {}) {
  return fetchJson(`/api/console/admin/deployment-cleanups/${encodeURIComponent(id)}/run`, {
    ...options,
    method: 'POST',
    body,
  });
}

export function runAdminDeploymentCleanupsDue(limit = 50, body = {}, options = {}) {
  return fetchJson('/api/console/admin/deployment-cleanups/run-due', {
    ...options,
    method: 'POST',
    body: {
      ...body,
      limit,
    },
  });
}

export function deleteAdminNormalWorker(id, body = {}, options = {}) {
  return fetchJson(`/api/console/admin/normal-workers/${encodeURIComponent(id)}`, {
    ...options,
    method: 'DELETE',
    body,
  });
}

export function bulkDeleteAdminNormalWorkers(ids, body = {}, options = {}) {
  return fetchJson('/api/console/admin/normal-workers/bulk-delete', {
    ...options,
    method: 'POST',
    body: {
      ...body,
      ids,
    },
  });
}

export function listAdminUsers({ query, limit, offset, admin, status, ...options } = {}) {
  const search = new URLSearchParams();
  if (query) search.set('query', query);
  if (limit !== undefined) search.set('limit', String(limit));
  if (offset !== undefined) search.set('offset', String(offset));
  if (admin) search.set('admin', admin);
  if (status) search.set('status', status);
  const qs = search.toString();
  return fetchJson(`/api/console/admin/users${qs ? `?${qs}` : ''}`, options);
}

export function listConsoleUsers({ query, ...options } = {}) {
  const search = new URLSearchParams();
  if (query) search.set('query', query);
  const qs = search.toString();
  return fetchJson(`/api/console/users${qs ? `?${qs}` : ''}`, options);
}

export function listAdminSites({ exposure, ...options } = {}) {
  const search = new URLSearchParams();
  if (exposure) search.set('exposure', exposure);
  const query = search.toString();
  return fetchJson(`/api/console/admin/sites${query ? `?${query}` : ''}`, options);
}

export function getAdminSite(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}`, options);
}

export function getAdminSiteAccess(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/access`, options);
}

export function updateAdminSiteAccess(siteId, body, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/access`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function getAdminSiteExposure(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/exposure`, options);
}

export function updateAdminSiteExposure(siteId, body, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/exposure`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function getAdminSiteConfig(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/config`, options);
}

export function getAdminSiteDeployments(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/deployments`, options);
}

export function putAdminSiteRuntimeVar(siteId, name, value, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/config/vars/${encodeURIComponent(name)}`, {
    ...options,
    method: 'PUT',
    body: { value },
  });
}

export function deleteAdminSiteRuntimeVar(siteId, name, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/config/vars/${encodeURIComponent(name)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function putAdminSiteRuntimeSecret(siteId, name, value, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/config/secrets/${encodeURIComponent(name)}`, {
    ...options,
    method: 'PUT',
    body: { value },
  });
}

export function deleteAdminSiteRuntimeSecret(siteId, name, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/config/secrets/${encodeURIComponent(name)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function deleteAdminSite(siteId, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function listAdminTeams({ teamType, status, ...options } = {}) {
  const search = new URLSearchParams();
  if (teamType) search.set('teamType', teamType);
  if (status) search.set('status', status);
  const query = search.toString();
  return fetchJson(`/api/console/admin/teams${query ? `?${query}` : ''}`, options);
}

export function updateAdminTeamSettings(teamId, body, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(teamId)}/settings`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function listAdminTeamMembers(teamId, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(teamId)}/members`, options);
}

export function updateAdminTeamMember(teamId, userId, body, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function removeAdminTeamMember(teamId, userId, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function deleteAdminTeam(teamId, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(teamId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function listAdminAuditEvents(options = {}) {
  return fetchJson('/api/console/admin/audit', options);
}

export function mergeAdminDepartmentTeam(id, body, options = {}) {
  return fetchJson(`/api/console/admin/teams/${encodeURIComponent(id)}/merge`, {
    ...options,
    method: 'POST',
    body,
  });
}

export function grantPlatformAdmin(userId, body = {}, options = {}) {
  return fetchJson('/api/console/admin/platform-admins', {
    ...options,
    method: 'POST',
    body: {
      ...body,
      userId,
    },
  });
}

export function revokePlatformAdmin(userId, body = {}, options = {}) {
  return fetchJson(`/api/console/admin/platform-admins/${encodeURIComponent(userId)}`, {
    ...options,
    method: 'DELETE',
    body,
  });
}

export function listAccessKeys(options = {}) {
  return fetchJson('/api/console/access-keys', options);
}

export function listTeams(options = {}) {
  return fetchJson('/api/console/teams', options);
}

export function createTeam(body, options = {}) {
  return fetchJson('/api/console/teams', {
    ...options,
    method: 'POST',
    body,
  });
}

export function createAccessKey(body, options = {}) {
  return fetchJson('/api/console/access-keys', {
    ...options,
    method: 'POST',
    body,
  });
}

export function revokeAccessKey(id, options = {}) {
  return fetchJson(`/api/console/access-keys/${encodeURIComponent(id)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function createWorkspaceSite(body, options = {}) {
  return fetchJson('/api/console/workspace/sites', {
    ...options,
    method: 'POST',
    body,
  });
}

export function listTeamAccessKeys(teamId, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/access-keys`, options);
}

export function createTeamAccessKey(teamId, body, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/access-keys`, {
    ...options,
    method: 'POST',
    body,
  });
}

export function revokeTeamAccessKey(teamId, id, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/access-keys/${encodeURIComponent(id)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function updateTeamMember(teamId, userId, body, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function removeTeamMember(teamId, userId, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function updateTeamSettings(teamId, body, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/settings`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function deleteTeam(teamId, options = {}) {
  return fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function updateSiteAccess(siteId, body, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/access`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function updateSiteSettings(siteId, body, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/settings`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function updateAdminSiteSettings(siteId, body, options = {}) {
  return fetchJson(`/api/console/admin/sites/${encodeURIComponent(siteId)}/settings`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function deleteSite(siteId, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function putSiteRuntimeVar(siteId, name, value, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/config/vars/${encodeURIComponent(name)}`, {
    ...options,
    method: 'PUT',
    body: { value },
  });
}

export function deleteSiteRuntimeVar(siteId, name, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/config/vars/${encodeURIComponent(name)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function putSiteRuntimeSecret(siteId, name, value, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/config/secrets/${encodeURIComponent(name)}`, {
    ...options,
    method: 'PUT',
    body: { value },
  });
}

export function deleteSiteRuntimeSecret(siteId, name, options = {}) {
  return fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/config/secrets/${encodeURIComponent(name)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function createAdminWebhook(body, options = {}) {
  return fetchJson('/api/console/admin/webhooks', {
    ...options,
    method: 'POST',
    body,
  });
}

export function updateAdminWebhook(id, body, options = {}) {
  return fetchJson(`/api/console/admin/webhooks/${encodeURIComponent(id)}`, {
    ...options,
    method: 'PATCH',
    body,
  });
}

export function disableAdminWebhook(id, options = {}) {
  return fetchJson(`/api/console/admin/webhooks/${encodeURIComponent(id)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function listAdminWebhookDeliveries(id, options = {}) {
  return fetchJson(`/api/console/admin/webhooks/${encodeURIComponent(id)}/deliveries`, options);
}
