export function formatDirectorySite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || site.hostname || null,
    owner: formatOwner(site, { includeDisplayName: true }),
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
  };
}

export function formatWorkspaceSite(site) {
  return {
    id: site.id,
    slug: site.slug,
    hostname: site.route?.hostname || site.hostname || null,
    owner: formatOwner(site, { includeDisplayName: true }),
    visibility: site.route?.visibility || site.defaultVisibility,
    status: site.route?.routeStatus || 'active',
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

export function formatSiteDetail(site) {
  return {
    ...formatWorkspaceSite(site),
    owner: formatOwner(site, { includeDisplayName: true, includeId: true, includeEmail: true }),
    access: {
      visibility: site.route?.visibility || site.defaultVisibility,
    },
    permissions: {
      role: site.managementRole || (site.ownerUserId === site.currentUserId ? 'admin' : 'viewer'),
      canManage: canManageSite(site.managementRole) || site.ownerUserId === site.currentUserId,
      canManageAccess: canManageSite(site.managementRole) || site.ownerUserId === site.currentUserId,
    },
  };
}

export function formatDeployment(deployment) {
  return {
    id: deployment.id,
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
    completedAt: deployment.completedAt || null,
  };
}

export function formatAclEntry(entry) {
  return {
    id: entry.id,
    subjectType: entry.subjectType,
    subjectValue: entry.subjectValue,
    accessRole: entry.accessRole,
    effect: entry.effect,
    createdAt: entry.createdAt,
  };
}

export function formatSiteVar(record) {
  return {
    name: record.name,
    value: record.value,
    revision: Number(record.revision || 0),
    updatedAt: record.updatedAt,
  };
}

export function formatSiteVarMutation(record, appliesTo = 'next_deployment') {
  return {
    ...formatSiteVar(record),
    appliesTo,
  };
}

export function formatDeletedSiteVarMutation(name, appliesTo = 'next_deployment') {
  return {
    name,
    deleted: true,
    appliesTo,
  };
}

export function formatSiteSecret(record) {
  return {
    name: record.name,
    revision: Number(record.revision || 0),
    updatedAt: record.updatedAt,
  };
}

function formatOwner(site, { includeDisplayName, includeId = false, includeEmail = false }) {
  const type = site.ownerType || 'user';
  const owner = { type };
  if (includeId) owner.id = site.ownerId || site.ownerUserId || null;
  if (includeEmail && type === 'user' && site.ownerEmail) owner.email = site.ownerEmail;
  if (includeDisplayName && site.ownerDisplayName) owner.displayName = site.ownerDisplayName;
  if (type === 'team' && site.ownerTeamType) owner.teamType = site.ownerTeamType;
  return owner;
}

function canManageSite(role) {
  return role === 'admin' || role === 'publisher';
}
