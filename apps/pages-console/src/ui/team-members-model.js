export function buildTeamMemberView(member = {}) {
  const user = member.user || {};
  const email = user.email || '';
  const displayName = user.realname || email || user.account || member.userId || '用户';
  const secondary = email && email !== displayName ? email : user.account || member.userId || '';
  return {
    id: member.userId || user.id || '',
    displayName,
    email: secondary,
    avatarText: avatarText(displayName),
    userTitle: [displayName, secondary].filter(Boolean).join(' '),
    role: member.role || 'viewer',
    membershipSource: member.membershipSource || '',
    departmentPath: member.departmentPath || user.departmentPath || '',
    createdAt: member.createdAt || '',
    updatedAt: member.updatedAt || '',
  };
}

export function buildUserPickerRows({ users = [], members = [] } = {}) {
  const memberIds = new Set(members.map((member) => member.userId).filter(Boolean));
  return users.map((user) => {
    const displayName = user.realname || user.email || user.account || user.id || '用户';
    const email = user.email && user.email !== displayName ? user.email : user.account || user.id || '';
    return {
      id: user.id,
      displayName,
      email,
      avatarText: avatarText(displayName),
      departmentPath: user.departmentPath || '',
      employeeStatus: user.employeeStatus || '',
      alreadyMember: memberIds.has(user.id),
    };
  });
}

function avatarText(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 1).toUpperCase() : 'U';
}
