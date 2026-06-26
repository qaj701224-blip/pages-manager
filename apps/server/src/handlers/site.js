import { jsonResponse } from '@xd/worker-kit';

import { deleteScript, unbindExactRoute } from '../lib/cf-api.js';
import { isReservedSiteName, RESERVED_SITE_NAMES } from '../lib/site-names.js';

const DEFAULT_REUSE_HOLD_SECONDS = 300;

function getRequestToken(request) {
  const url = new URL(request.url);
  return (request.headers.get('X-Pages-Token') || url.searchParams.get('token') || '').trim();
}

function missingTokenResponse() {
  return jsonResponse(
    {
      error: '缺少 token',
      hint: '请通过 X-Pages-Token 请求头或 token 查询参数提供部署者 token',
    },
    400
  );
}

function forbiddenSiteResponse(name) {
  return jsonResponse(
    {
      error: '无权访问该站点',
      name,
      hint: '请使用该站点部署时的原 token，或通过 GET /list 查看当前 token 名下站点',
    },
    403
  );
}

function reservedSiteResponse(name) {
  return jsonResponse(
    {
      error: '站点名称为平台保留名称',
      field: 'name',
      name,
      reserved: RESERVED_SITE_NAMES,
      hint: '平台保留名称不能作为用户站点操作',
    },
    403
  );
}

function canAccessSite(site, token) {
  return Boolean(site?.token && site.token === token);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
}

function toSiteDetail(site) {
  return compactObject({
    name: site.name,
    preset: site.preset,
    scriptName: site.scriptName,
    url: site.url,
    devUrl: site.devUrl,
    fileCount: site.fileCount,
    ipRestrict: site.ipRestrict,
    kvEnabled: false,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  });
}

export async function handleGetSite(request, env, params) {
  const token = getRequestToken(request);
  if (!token) return missingTokenResponse();

  const data = await env.SITES.get(params.name, 'json');
  if (!data) {
    return jsonResponse({ error: '站点不存在', name: params.name, hint: '使用 GET /list 查看所有已部署站点' }, 404);
  }
  if (!canAccessSite(data, token)) return forbiddenSiteResponse(params.name);

  return jsonResponse(toSiteDetail(data));
}

export async function handleDeleteSite(request, env, params) {
  const token = getRequestToken(request);
  if (!token) return missingTokenResponse();

  const { name } = params;
  if (isReservedSiteName(name)) return reservedSiteResponse(name);

  const data = await env.SITES.get(name, 'json');
  if (!data) {
    return jsonResponse({ error: '站点不存在', name: params.name, hint: '使用 GET /list 查看所有已部署站点' }, 404);
  }
  if (!canAccessSite(data, token)) return forbiddenSiteResponse(name);

  const prefix = env.WORKER_PREFIX || 'pages-';
  if (!data.scriptName || !data.scriptName.startsWith(prefix)) {
    return jsonResponse(
      {
        error: '安全拦截：scriptName 不含合法前缀，拒绝删除',
        scriptName: data.scriptName,
        expectedPrefix: prefix,
      },
      403
    );
  }

  const hostname = hostnameFromSite(data, env, name);
  const routePattern = `${hostname}/*`;
  try {
    await unbindExactRoute(env.CF_API_TOKEN, env.CF_ZONE_ID_NEW, routePattern, data.scriptName);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : '安全拦截：route 解绑失败',
        routePattern,
      },
      403
    );
  }

  await deleteScript(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, data.scriptName);
  await env.SITES.delete(name);
  const release = await releaseDeletedHostnameClaim(env, {
    environment: readPublicEnvironment(env),
    hostname,
    normalizedSlug: name,
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: `v1:${readPublicEnvironment(env)}:${name}`,
    ownerRef: data.scriptName,
    source: 'v1_delete',
    status: 'active',
    releaseReason: 'site_deleted',
    reuseHoldUntil: addSecondsIso(readNowIso(env), readReuseHoldSeconds(env)),
  });
  if (!release.ok && env.HOSTNAME_CLAIMS_MODE === 'enforce') {
    return jsonResponse(
      {
        error: '站点已删除，但域名占用记录释放失败',
        code: release.code || 'HOSTNAME_CLAIM_RELEASE_FAILED',
        hint: '请重试删除或由平台管理员检查 hostname_claims。',
      },
      503
    );
  }

  return jsonResponse({ status: 'ok', name, message: `站点 ${name} 已删除` });
}

async function releaseDeletedHostnameClaim(env, claim) {
  const mode = env.HOSTNAME_CLAIMS_MODE || 'off';
  if (mode === 'off' || !env.HOSTNAME_CLAIMS) return { ok: true };

  try {
    const result = await releaseViaServiceBinding(env.HOSTNAME_CLAIMS, claim);
    if (result?.ok === false && mode === 'enforce') return result;
    return { ok: true, recorded: result || null };
  } catch (error) {
    if (mode === 'enforce') {
      return {
        ok: false,
        code: 'HOSTNAME_CLAIM_RELEASE_FAILED',
        message: error instanceof Error ? error.message : 'Hostname claim release failed',
      };
    }
    return { ok: true, recorded: { ok: false, code: 'HOSTNAME_CLAIM_RECORD_FAILED' } };
  }
}

async function releaseViaServiceBinding(binding, claim) {
  const response = await binding.fetch(
    new Request('https://pages-api.internal/.xd-pages/internal/hostname-claims/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim }),
    })
  );
  if (response.ok) return { ok: true, response: await response.json().catch(() => null) };
  const body = await response.json().catch(() => null);
  return {
    ok: false,
    code: body?.error?.code || 'HOSTNAME_CLAIM_RELEASE_FAILED',
    message: body?.error?.message || 'Hostname claim release failed',
  };
}

function hostnameFromSite(site, env, name) {
  try {
    const url = new URL(site.url);
    if (url.hostname.endsWith('.workers.xd.team')) return url.hostname;
  } catch {}
  return `${name}${env.DOMAIN_LABEL || ''}.${env.DOMAIN_BASE || 'workers.xd.team'}`;
}

function readPublicEnvironment(env) {
  return env.PUBLIC_ENVIRONMENT === 'staging' ? 'staging' : 'production';
}

function readNowIso(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function readReuseHoldSeconds(env) {
  const value = Number(env?.HOSTNAME_REUSE_HOLD_SECONDS || DEFAULT_REUSE_HOLD_SECONDS);
  if (!Number.isInteger(value) || value < 0 || value > 86_400) return DEFAULT_REUSE_HOLD_SECONDS;
  return value;
}

function addSecondsIso(iso, seconds) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
