function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleList(request, env) {
  const url = new URL(request.url);
  const filterToken = url.searchParams.get('token') || request.headers.get('X-Pages-Token');
  const showAll = url.searchParams.get('all') === 'true';

  const result = await env.SITES.list();
  let sites = result.keys.map((key) => ({
    name: key.name,
    token: key.metadata?.token,
    ...key.metadata,
  }));

  if (filterToken && !showAll) {
    sites = sites.filter((s) => s.token === filterToken);
  }

  return json({ sites, filtered: !!filterToken && !showAll });
}
