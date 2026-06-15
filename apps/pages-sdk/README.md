# @xd/pages-sdk

Small browser and Worker helpers for the Pages runtime KV API.

## Browser

```js
import { createPagesClient } from '@xd/pages-sdk/browser';

const pages = createPagesClient();

const config = await pages.kv.get('app/config');
await pages.kv.put('app/config', { theme: 'dark' });
await pages.kv.delete('app/config');
```

## Worker

```js
import { createPagesRuntime, readPlatformContext } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const pages = createPagesRuntime({ env });
    const context = readPlatformContext(request);
    const config = await pages.kv.get('app/config');

    return Response.json({ config, userId: context?.userId ?? null });
  },
};
```

`readPlatformContext(request)` reads the minimal identity context injected by the Pages router. It does not expose the raw internal JWT and it is not a gateway capability. Platform data APIs still require the dedicated capability provided through Worker bindings.

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
