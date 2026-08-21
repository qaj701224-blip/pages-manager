export function mapUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    realname: row.realname,
    account: row.account,
    accountId: row.account_id,
    employeenum: row.employeenum,
    employeeStatus: row.employee_status,
    feishuOpenId: row.feishu_open_id || null,
    cindyMembershipId: row.cindy_membership_id || null,
    createdSource: row.created_source || 'xd_sso',
    departmentPath: row.department_path || null,
    departmentCheckedAt: row.department_checked_at || null,
    sessionVersion: row.session_version,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
