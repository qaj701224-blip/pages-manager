export function createPlatformAdminManagement({ admins, users }) {
  if (typeof admins?.list !== 'function') throw new TypeError('admins.list is required');
  if (typeof admins?.grant !== 'function') throw new TypeError('admins.grant is required');
  if (typeof admins?.revoke !== 'function') throw new TypeError('admins.revoke is required');
  if (typeof users?.get !== 'function') throw new TypeError('users.get is required');

  return { list, grant, revoke };

  async function list(query) {
    return (await admins.list({ environment: query.environment })).map(projectPlatformAdmin);
  }

  async function grant(command) {
    const user = await users.get(command.userId);
    if (!user) return denied('user_not_found');
    const admin = await admins.grant({
      environment: command.environment,
      userId: command.userId,
      grantedByUserId: command.actorUserId,
      grantReason: command.reason,
    });
    return { ok: true, admin: projectPlatformAdmin(admin) };
  }

  async function revoke(command) {
    let admin;
    try {
      admin = await admins.revoke({
        environment: command.environment,
        userId: command.userId,
        revokedByUserId: command.actorUserId,
        revokeReason: command.reason,
      });
    } catch (error) {
      if (String(error?.message || error).includes('PLATFORM_ADMIN_LAST_ACTIVE')) {
        return denied('last_active');
      }
      throw error;
    }
    return admin ? { ok: true, admin: projectPlatformAdmin(admin) } : denied('admin_not_found');
  }
}

export function projectPlatformAdmin(admin) {
  return {
    environment: admin.environment,
    userId: admin.userId,
    grantedByUserId: admin.grantedByUserId,
    grantReason: admin.grantReason || null,
    revokedAt: admin.revokedAt || null,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    ...(admin.revokedByUserId ? { revokedByUserId: admin.revokedByUserId } : {}),
    ...(admin.revokeReason ? { revokeReason: admin.revokeReason } : {}),
  };
}

function denied(reason) {
  return { ok: false, reason };
}
