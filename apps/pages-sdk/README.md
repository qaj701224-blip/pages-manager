# @xd/pages-sdk

Small browser and Worker helpers for XD Pages runtime data APIs.

## Browser

```js
import { createPagesClient } from '@xd/pages-sdk/browser';

const pages = createPagesClient();

const config = await pages.data.site.get('app/config');
await pages.data.site.set('app/config', { theme: 'dark' });

const draft = await pages.data.user.get('draft');
await pages.data.user.set('draft', { title: 'hello' });
```

`pages.data.site` is shared by everyone who can access the site. `pages.data.user` belongs to the current logged-in user in the current site. Anonymous `pages.data.user.get()` returns `null`; anonymous `set` and `delete` fail with a runtime error.

`pages.kv` is deprecated and remains as a compatibility alias for site-level data. Use `pages.data.site` in new code.

## Worker

```js
import { createPagesRuntime, readPlatformContext } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const pages = createPagesRuntime({ request, env });
    const context = readPlatformContext(request);
    const config = await pages.data.site.get('app/config');
    const draft = await pages.data.user.get('draft');

    return Response.json({ config, draft, userId: context?.userId ?? null });
  },
};
```

`readPlatformContext(request)` reads the minimal identity context injected by the Pages router. It does not expose the raw internal JWT and it is not a gateway capability. Platform data APIs still require the dedicated capability provided through Worker bindings.
`pages.data.user` only uses the per-request user data capability injected by the Pages router; it does not use static env capabilities.

## Runtime Adapter

Use `handlePagesRuntimeRequest` only when your Worker intentionally exposes the browser runtime endpoints. It fails closed unless `checkAccess` is provided; `checkAccess` should enforce your site allowlist or auth policy.

```js
import { handlePagesRuntimeRequest } from '@xd/pages-sdk/adapter';

function checkAccess(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  const allowlist = new Set((env.IP_ALLOWLIST || '').split(',').map((item) => item.trim()).filter(Boolean));
  return ip && allowlist.has(ip) ? null : new Response('IP not allowed', { status: 403 });
}

export default {
  async fetch(request, env) {
    const runtimeResponse = await handlePagesRuntimeRequest(request, env, { checkAccess });
    if (runtimeResponse) return runtimeResponse;

    return env.ASSETS.fetch(request);
  },
};
```

Runtime service binding credentials should be provided through Worker bindings and secrets, not source files.
