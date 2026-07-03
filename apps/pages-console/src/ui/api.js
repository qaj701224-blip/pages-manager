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
    throw error;
  }
  return payload;
}

export function readCsrfToken() {
  if (typeof globalThis.document === 'undefined') return '';
  const cookie = globalThis.document.cookie || '';
  for (const part of cookie.split(';')) {
    const [name, ...rawValue] = part.trim().split('=');
    if (name === 'xd_cell_csrf') return decodeURIComponent(rawValue.join('='));
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

export function listAdminUsers(options = {}) {
  return fetchJson('/api/console/admin/users', options);
}

export function listConsoleUsers({ query, ...options } = {}) {
  const search = new URLSearchParams();
  if (query) search.set('query', query);
  const qs = search.toString();
  return fetchJson(`/api/console/users${qs ? `?${qs}` : ''}`, options);
}

export function listAdminSites(options = {}) {
  return fetchJson('/api/console/admin/sites', options);
}

export function listAdminTeams({ teamType, status, ...options } = {}) {
  const search = new URLSearchParams();
  if (teamType) search.set('teamType', teamType);
  if (status) search.set('status', status);
  const query = search.toString();
  return fetchJson(`/api/console/admin/teams${query ? `?${query}` : ''}`, options);
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
