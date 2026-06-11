import { jsonResponse } from '@xd/worker-kit';

function withoutToken(site) {
  const visibleSite = { ...site };
  delete visibleSite.token;
  return visibleSite;
}

export async function handleList(request, env) {
  const url = new URL(request.url);
  const filterToken = (url.searchParams.get('token') || request.headers.get('X-Pages-Token') || '').trim();

  if (!filterToken) {
    return jsonResponse(
      {
        error: '缺少 token',
        hint: '请通过 X-Pages-Token 请求头或 token 查询参数提供部署者 token',
      },
      400
    );
  }

  const result = await env.SITES.list();
  const sites = result.keys
    .map((key) => ({
      name: key.name,
      ...(key.metadata || {}),
    }))
    .filter((site) => site.token === filterToken)
    .map(withoutToken);

  return jsonResponse({ sites, filtered: true });
}
