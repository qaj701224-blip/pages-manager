import {
  VALID_VISIBILITIES,
  createClient,
  outputJsonResult,
  readConfigForCommand,
  readSingleSiteArg,
  readSiteBySlug,
  readSiteVisibility,
  resolveCredential,
  usageError,
} from './shared.js';

export async function runAccess(parsed, context) {
  const subcommand = parsed.positional[0] || 'get';
  const child = { ...parsed, positional: parsed.positional.slice(1) };
  const config = readConfigForCommand(parsed, context);
  const credential = await resolveCredential(config.environment, context, parsed);
  const client = createClient(config, credential, context);

  if (subcommand === 'get') {
    assertFlagsAbsent(parsed, ['visibility', 'email', 'department'], 'ACCESS_GET_USAGE_INVALID', 'access get 不接受访问范围设置参数。');
    const siteSlug = readSingleSiteArg(child, 'ACCESS_GET_USAGE_INVALID', '请使用 xd-cell access get <站点名>。');
    const { site } = await readSiteBySlug(client, siteSlug);
    const result = await client.requestApi('GET', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl`);
    const summary = summarizeAccessEntries(result.aclEntries || []);
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: site.slug,
      visibility: readSiteVisibility(site),
      ...summary,
    });
  }

  if (subcommand === 'set') {
    const siteSlug = readSingleSiteArg(child, 'ACCESS_SET_USAGE_INVALID', '请使用 xd-cell access set <站点名> --visibility <范围>。');
    const visibility = normalizeVisibility(parsed.flags.visibility);
    if (!visibility) {
      if (parsed.flags.visibility !== undefined) {
        throw usageError('ACCESS_VISIBILITY_INVALID', '访问范围无效。', '请使用 internal、org、acl、owner 或 disabled。');
      }
      throw usageError('ACCESS_VISIBILITY_REQUIRED', '缺少访问范围。', '请传入 --visibility internal|org|acl|owner|disabled。');
    }
    const requested = readAccessEntryFlags(parsed, { requireEntry: false });
    if (visibility !== 'acl' && requested.entries.length > 0) {
      throw usageError('ACCESS_ENTRIES_UNUSED', '当前访问范围不使用邮箱或部门名单。', '只有 --visibility acl 可以同时传 --email 或 --department。');
    }

    const { site } = await readSiteBySlug(client, siteSlug);
    let summary = { emails: [], departments: [], aclEntries: [] };
    if (visibility === 'acl') {
      const result = await client.requestApi('PUT', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl`, {
        entries: requested.entries,
      });
      summary = summarizeAccessEntries(result.aclEntries || []);
    }
    const updated = await client.requestApi('PATCH', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}`, { visibility });
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: updated.site?.slug || site.slug,
      visibility,
      emails: summary.emails,
      departments: summary.departments,
    });
  }

  if (subcommand === 'grant' || subcommand === 'revoke') {
    assertFlagsAbsent(
      parsed,
      ['visibility'],
      subcommand === 'grant' ? 'ACCESS_GRANT_USAGE_INVALID' : 'ACCESS_REVOKE_USAGE_INVALID',
      `access ${subcommand} 不接受 --visibility。`
    );
    const siteSlug = readSingleSiteArg(
      child,
      subcommand === 'grant' ? 'ACCESS_GRANT_USAGE_INVALID' : 'ACCESS_REVOKE_USAGE_INVALID',
      `请使用 xd-cell access ${subcommand} <站点名> --email <邮箱> 或 --department <部门路径>。`
    );
    const requested = readAccessEntryFlags(parsed, { requireEntry: true });
    const { site } = await readSiteBySlug(client, siteSlug);
    if (readSiteVisibility(site) !== 'acl') {
      throw usageError('ACCESS_VISIBILITY_NOT_ACL', '站点当前不是 acl 访问范围。', firstAclSetAction(siteSlug, requested));
    }
    const method = subcommand === 'grant' ? 'POST' : 'DELETE';
    const result = await client.requestApi(method, `/.xd-pages/api/sites/${encodeURIComponent(site.id)}/acl/entries`, {
      entries: requested.entries,
    });
    const summary = summarizeAccessEntries(result.aclEntries || []);
    return outputAccessResult(parsed, context, {
      environment: config.environment,
      site: site.slug,
      visibility: 'acl',
      emails: summary.emails,
      departments: summary.departments,
    });
  }

  throw usageError(
    'ACCESS_COMMAND_INVALID',
    'access 命令无效。',
    '请使用 xd-cell access get、set、grant 或 revoke。'
  );
}

function normalizeVisibility(value) {
  const visibility = typeof value === 'string' ? value.trim() : '';
  return VALID_VISIBILITIES.has(visibility) ? visibility : '';
}

function readAccessEntryFlags(parsed, { requireEntry }) {
  const emails = normalizeRepeatedFlag(parsed.flags.email).map(normalizeEmail);
  const departments = normalizeRepeatedFlag(parsed.flags.department).map(normalizeDepartmentPath);
  if (emails.some((email) => !isValidEmail(email))) {
    throw usageError('ACCESS_EMAIL_INVALID', '邮箱格式无效。', '请传入完整邮箱，例如 --email user@xd.com。');
  }
  if (departments.some((department) => !department)) {
    throw usageError('ACCESS_DEPARTMENT_INVALID', '部门路径无效。', '请传入完整部门路径，例如 --department "心动/技术平台部"。');
  }

  const entries = [];
  const seen = new Set();
  for (const email of emails) addAccessEntry(entries, seen, 'email', email);
  for (const department of departments) addAccessEntry(entries, seen, 'department', department);
  if (requireEntry && entries.length === 0) {
    throw usageError('ACCESS_ENTRIES_REQUIRED', '缺少授权对象。', '请传入 --email <邮箱> 或 --department <部门路径>。');
  }
  return {
    entries,
    emails: entries.filter((entry) => entry.subjectType === 'email').map((entry) => entry.subjectValue),
    departments: entries.filter((entry) => entry.subjectType === 'department').map((entry) => entry.subjectValue),
  };
}

function addAccessEntry(entries, seen, subjectType, subjectValue) {
  const key = `${subjectType}:${subjectValue}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push({ subjectType, subjectValue });
}

function normalizeRepeatedFlag(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+$/.test(value);
}

function normalizeDepartmentPath(value) {
  const raw = String(value || '').trim();
  if (!raw || hasControlCharacter(raw)) return '';
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const normalized = parts.join('/');
  if (normalized.length > 256 || parts.some((part) => part.length > 80)) return '';
  return normalized;
}

function hasControlCharacter(value) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function summarizeAccessEntries(aclEntries = []) {
  const emails = [];
  const departments = [];
  const seen = new Set();
  for (const entry of aclEntries) {
    if (!entry || entry.effect !== 'allow') continue;
    const key = `${entry.subjectType}:${entry.subjectValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.subjectType === 'email') emails.push(entry.subjectValue);
    if (entry.subjectType === 'department') departments.push(entry.subjectValue);
  }
  return { emails, departments };
}

function firstAclSetAction(siteSlug, requested) {
  const email = requested.emails[0];
  if (email) return `请先运行 xd-cell access set ${siteSlug} --visibility acl --email ${email}。`;
  const department = requested.departments[0];
  if (department) return `请先运行 xd-cell access set ${siteSlug} --visibility acl --department "${department}"。`;
  return `请先运行 xd-cell access set ${siteSlug} --visibility acl --email user@xd.com。`;
}

function outputAccessResult(parsed, context, payload) {
  if (outputJsonResult(parsed, context, payload)) return 0;
  context.output(`站点名：${payload.site}`);
  context.output(`访问范围：${payload.visibility}`);
  context.output(`邮箱：${payload.emails.length ? payload.emails.join(', ') : '-'}`);
  context.output(`部门：${payload.departments.length ? payload.departments.join(', ') : '-'}`);
  return 0;
}

function assertFlagsAbsent(parsed, flags, code, message) {
  for (const flag of flags) {
    if (parsed.flags[flag] !== undefined) {
      throw usageError(code, message, '请运行 xd-cell help access 查看用法。');
    }
  }
}
