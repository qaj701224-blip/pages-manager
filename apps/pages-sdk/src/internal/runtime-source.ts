export const PAGES_RUNTIME_SOURCE = String.raw`
const RUNTIME = {
  KV_GET_PATH: '/.xd-pages/runtime/v1/kv/get',
  KV_PUT_PATH: '/.xd-pages/runtime/v1/kv/put',
  KV_DELETE_PATH: '/.xd-pages/runtime/v1/kv/delete',
};

export async function handlePagesRuntimeRequest(request, env, options = {}) {
  const url = new URL(request.url);
  if (![RUNTIME.KV_GET_PATH, RUNTIME.KV_PUT_PATH, RUNTIME.KV_DELETE_PATH].includes(url.pathname)) return null;
  if (request.method !== 'POST') return Response.json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, { status: 405 });
  if (request.headers.get('X-XD-Pages-Runtime') !== '1') return Response.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 });
  if (!options.checkAccess) return Response.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 });
  const accessResponse = await options.checkAccess(request, env);
  if (accessResponse) return accessResponse;
  return Response.json({ ok: false, error: { code: 'KV_FAILED', message: 'Inline runtime is not wired yet' } }, { status: 501 });
}
`;
