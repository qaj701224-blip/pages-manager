function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleList(request, env) {
  const url = new URL(request.url);
  const filterToken = url.searchParams.get('token') || request.headers.get('X-Pages-Token');

  const result = await env.SITES.list();
  let sites = result.keys.map((key) => ({
    name: key.name,
    ...key.metadata,
  }));

  if (filterToken) {
    sites = sites.filter((s) => s.token === filterToken);
  }

  return json({ sites, filtered: !!filterToken });
}
