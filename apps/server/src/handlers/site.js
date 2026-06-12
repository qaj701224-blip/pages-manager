import { jsonResponse } from '@xd/worker-kit';

import { deleteScript } from '../lib/cf-api.js';
import { isReservedSiteName, RESERVED_SITE_NAMES } from '../lib/site-names.js';

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
    kvEnabled: site.kvEnabled,
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

  await deleteScript(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, data.scriptName);
  await env.SITES.delete(name);

  return jsonResponse({ status: 'ok', name, message: `站点 ${name} 已删除` });
}
