export function createRuntimeConfigMutations({ repository, sync, clock, ids }) {
  if (!repository || typeof repository !== 'object') throw new TypeError('runtime config repository is required');
  if (!sync || typeof sync !== 'object') throw new TypeError('runtime config sync port is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return {
    mutateVar: (command) => mutateVar(repository, sync, clock, command),
    putSecret: (command) => putSecret(repository, sync, clock, ids, command),
    deleteSecret: (command) => deleteSecret(repository, sync, clock, ids, command),
  };
}

async function mutateVar(repository, sync, clock, command) {
  requireMethod(repository, 'mutateSiteVar', 'RUNTIME_CONFIG_UNSUPPORTED');
  requireMethod(sync, 'syncPlainText', 'RUNTIME_CONFIG_SYNC_UNAVAILABLE');
  const mutation = await repository.mutateSiteVar({
    environment: command.environment,
    siteId: command.site.id,
    operation: command.operation,
    name: command.name,
    ...(command.operation === 'put' ? { value: command.value } : {}),
    actorId: command.actor.userId,
    updatedAt: clock.now(),
  });
  const syncResult = await sync.syncPlainText({ site: command.site, snapshot: mutation });
  return { mutation, syncResult };
}

async function putSecret(repository, sync, clock, ids, command) {
  requireMethod(repository, 'putSiteSecretWithAudit', 'RUNTIME_CONFIG_UNSUPPORTED');
  requireMethod(sync, 'syncSecret', 'RUNTIME_CONFIG_SYNC_UNAVAILABLE');
  const secret = await repository.putSiteSecretWithAudit({
    id: ids.next('sec'),
    environment: command.environment,
    siteId: command.site.id,
    siteSlug: command.site.slug,
    name: command.name,
    value: command.value,
    actorId: command.actor.userId,
    actorType: command.actor.type,
    routeId: command.site.route?.id || null,
    auditId: ids.next('aud'),
    updatedAt: clock.now(),
  });
  await sync.syncSecret({
    site: command.site,
    mutation: { operation: 'put', name: command.name, value: command.value },
  });
  return { secret };
}

async function deleteSecret(repository, sync, clock, ids, command) {
  requireMethod(repository, 'deleteSiteSecretWithAudit', 'RUNTIME_CONFIG_UNSUPPORTED');
  requireMethod(sync, 'syncSecret', 'RUNTIME_CONFIG_SYNC_UNAVAILABLE');
  const secret = await repository.deleteSiteSecretWithAudit({
    environment: command.environment,
    siteId: command.site.id,
    siteSlug: command.site.slug,
    name: command.name,
    actorId: command.actor.userId,
    actorType: command.actor.type,
    routeId: command.site.route?.id || null,
    auditId: ids.next('aud'),
    deletedAt: clock.now(),
  });
  await sync.syncSecret({
    site: command.site,
    mutation: { operation: 'delete', name: command.name },
  });
  return { secret };
}

function requireMethod(target, name, code) {
  if (typeof target[name] === 'function') return;
  const error = new Error(code);
  error.code = code;
  throw error;
}
