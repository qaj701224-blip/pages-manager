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
import { createPagesRuntime, handlePagesRuntimeRequest } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const runtimeResponse = await handlePagesRuntimeRequest(request, env, {
      checkAccess: () => null,
    });
    if (runtimeResponse) return runtimeResponse;

    const pages = createPagesRuntime({ env });
    const config = await pages.kv.get('app/config');

    return Response.json({ config });
  },
};
```

`handlePagesRuntimeRequest` fails closed unless `checkAccess` is provided. Runtime service binding credentials should be provided through Worker bindings and secrets, not source files.
