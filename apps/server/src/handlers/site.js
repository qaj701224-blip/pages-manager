import { deleteScript } from '../lib/cf-api.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleGetSite(request, env, params) {
  const data = await env.SITES.get(params.name, 'json');
  if (!data) {
    return json({ error: '站点不存在', name: params.name, hint: '使用 GET /list 查看所有已部署站点' }, 404);
  }
  return json(data);
}

export async function handleDeleteSite(request, env, params) {
  const { name } = params;
  const data = await env.SITES.get(name, 'json');
  if (!data) {
    return json({ error: '站点不存在', name: params.name, hint: '使用 GET /list 查看所有已部署站点' }, 404);
  }

  const prefix = env.WORKER_PREFIX || 'pages-';
  if (!data.scriptName || !data.scriptName.startsWith(prefix)) {
    return json(
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

  return json({ status: 'ok', name, message: `站点 ${name} 已删除` });
}
