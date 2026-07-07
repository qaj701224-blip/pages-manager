const XDS_LIST_BY_EMAIL_URL = 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email';

export async function signXdsRequest({ ts, nonce, token }) {
  const normalizedTs = String(ts);
  const normalizedNonce = String(nonce || '');
  const normalizedToken = String(token || '');
  if (!normalizedTs || !normalizedNonce || !normalizedToken) throw stableError('XDS_SIGN_INPUT_INVALID');

  return {
    ts: normalizedTs,
    nonce: normalizedNonce,
    sign: await sha1Hex(`${normalizedTs}${normalizedNonce}${normalizedToken}`),
  };
}

export function normalizeXdsUserItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const email = normalizeEmail(firstString(item.email, item.mail, item.fs_email, item.workEmail));
  const departmentPath = normalizeDepartmentPath(
    firstString(
      item.departmentPath,
      item.department_path,
      item.deptPath,
      item.dept_path,
      item.departmentFullPath,
      item.department_full_path,
      item.deptFullPath,
      item.department,
      item.dept,
      item.department?.path,
      item.department?.fullPath,
      item.dept?.path,
      arrayPath(item.departmentPathList),
      arrayPath(item.department_path_list),
      arrayPath(item.departments)
    )
  );

  return {
    email,
    userId: normalizeOptionalString(firstString(item.userId, item.user_id, item.userid, item.oaUserId, item.id)) || null,
    name: normalizeOptionalString(firstString(item.name, item.realname, item.realName, item.displayName)) || null,
    employeeStatus: normalizeEmployeeStatus(firstString(item.employeeStatus, item.employee_status, item.status)),
    departmentPath,
  };
}

export async function fetchOrgUsersByEmail({
  emails,
  token,
  fetchImpl = fetch,
  nowSeconds = () => Math.floor(Date.now() / 1000),
  nonce = () => crypto.randomUUID(),
} = {}) {
  const normalizedEmails = normalizeEmails(emails);
  if (normalizedEmails.length === 0) return [];

  const signed = await signXdsRequest({
    ts: nowSeconds(),
    nonce: nonce(),
    token,
  });

  let response;
  try {
    response = await fetchImpl(XDS_LIST_BY_EMAIL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ts': signed.ts,
        'x-nonce': signed.nonce,
        'x-sign': signed.sign,
      },
      body: JSON.stringify({ emails: normalizedEmails }),
    });
  } catch {
    throw stableError('XDS_REQUEST_FAILED');
  }

  if (!response?.ok) throw stableError('XDS_REQUEST_FAILED');

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw stableError('XDS_RESPONSE_FAILED');
  }

  if (!payload || payload.code !== 0) throw stableError('XDS_RESPONSE_FAILED');

  return extractXdsItems(payload)
    .map((item) => normalizeXdsUserItem(item))
    .filter(Boolean);
}

function extractXdsItems(payload) {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.data?.list)) return payload.data.list;
  if (Array.isArray(payload.data?.items)) return payload.data.items;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.list)) return payload.list;
  return [];
}

function normalizeEmails(emails) {
  const seen = new Set();
  const normalized = [];
  for (const email of Array.isArray(emails) ? emails : []) {
    const value = normalizeEmail(email);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function arrayPath(value) {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return firstString(part.name, part.path, part.departmentPath);
      return '';
    })
    .filter(Boolean)
    .join('/');
}

function normalizeDepartmentPath(value) {
  return typeof value === 'string'
    ? value
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/')
    : '';
}

function normalizeEmployeeStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (['1', 'active', 'enabled', 'normal', '在职'].includes(normalized)) return 'active';
  if (['disabled', 'inactive', 'suspended', '停用'].includes(normalized)) return 'disabled';
  if (['0', 'left', 'leave', 'terminated', '离职'].includes(normalized)) return 'left';
  return 'unknown';
}

async function sha1Hex(value) {
  const digest = await crypto.subtle.digest('SHA-1', new globalThis.TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
