# XD Pages User Data Design

## Background

XD Pages v2 currently exposes a site-level data capability through the Pages SDK as `pages.kv`. Browser calls go through same-origin runtime paths under `/.xd-pages/runtime/v1/kv/*`, the router signs a short-lived capability, and `pages-kv-gateway` stores values in the shared `SITE_DATA` KV namespace under a site UUID prefix.

The new requirement is to add a site-user data capability without making users think in Cloudflare KV terms. The public concept is **XD Pages Data**:

- `pages.data.site`: data shared by all users of the current site.
- `pages.data.user`: data private to the current logged-in user within the current site.

CLI behavior does not change. Data access is a runtime SDK capability, not a deploy-time setting.

## Goals

- Add a user-scoped data API for browser and Worker SDK users.
- Keep user identity platform-derived. Browser code, user Workers, and SDK callers must never pass `userId`.
- Return `null` for anonymous `pages.data.user.get()` only after the router has accepted the request as an anonymous site visitor.
- Reject anonymous `pages.data.user.set()` and `pages.data.user.delete()` with a clear `USER_REQUIRED` error.
- Keep legacy `pages.kv` and `/.xd-pages/runtime/v1/kv/*` working as site-level compatibility paths.
- Mark legacy SDK and runtime surfaces deprecated, but remove them from README, skill, demo, and examples.
- Preserve staging/production isolation and avoid exposing gateway capabilities to browsers.

## Non-goals

- No CLI command or config change.
- No list, batch, admin-read-another-user, team-space, session-space, binary value, transaction, lock, or query API.
- No migration or deletion of existing site-level KV records.
- No online route snapshot lookup in `pages-kv-gateway` for hard revocation in this iteration; short capability TTL remains the revocation window.

## Public SDK Shape

Browser:

```js
import { createPagesClient } from '@xd/pages-sdk/browser';

const pages = createPagesClient();

await pages.data.site.set('app/config', { theme: 'dark' });
const config = await pages.data.site.get('app/config');

await pages.data.user.set('draft', { title: 'hello' });
const draft = await pages.data.user.get('draft');
```

Worker:

```js
import { createPagesRuntime } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const pages = createPagesRuntime({ request, env });
    const draft = await pages.data.user.get('draft');
    return Response.json({ draft });
  },
};
```

Compatibility:

```ts
interface PagesClient {
  data: {
    site: PagesDataStore;
    user: PagesDataStore;
  };

  /** @deprecated Use pages.data.site instead. */
  kv: PagesDataStore;
}
```

`pages.kv` remains equivalent to `pages.data.site` for a migration window, but public docs must not teach it as the primary API.

## Runtime Paths

New browser runtime paths:

```text
POST /.xd-pages/runtime/v1/data/site/get
POST /.xd-pages/runtime/v1/data/site/set
POST /.xd-pages/runtime/v1/data/site/delete

POST /.xd-pages/runtime/v1/data/user/get
POST /.xd-pages/runtime/v1/data/user/set
POST /.xd-pages/runtime/v1/data/user/delete
```

New gateway paths:

```text
POST /v1/data/site/get
POST /v1/data/site/set
POST /v1/data/site/delete

POST /v1/data/user/get
POST /v1/data/user/set
POST /v1/data/user/delete
```

Legacy paths remain valid and deprecated:

```text
POST /.xd-pages/runtime/v1/kv/get
POST /.xd-pages/runtime/v1/kv/set
POST /.xd-pages/runtime/v1/kv/delete

POST /v1/kv/get
POST /v1/kv/set
POST /v1/kv/delete
```

Legacy `/kv/*` paths always map to site-level data. They must never switch to user-level data based on request body, user identity, or capability claims.

## Storage Keys

Site data keeps the existing prefix:

```text
s/{siteSlug}--{siteUuid}/k/{encodedUserKey}
```

User data uses a separate prefix:

```text
s/{siteSlug}--{siteUuid}/u/{userId}/k/{encodedUserKey}
```

`siteUuid` is the site isolation anchor. `siteSlug` is for readability only. `userId` must be the stable internal platform user id from router-authenticated identity, not an email address. Email is mutable, personally identifiable, and may be reused; it must not appear in KV keys. Browser body values such as `userId`, `email`, or `scope` are ignored for key construction.

## Capability Model

Router signs short-lived capability JWTs for gateway access.

Site capability:

```json
{
  "iss": "pages-v2",
  "aud": "pages-kv-gateway",
  "apiVersion": 2,
  "dataScope": "site",
  "env": "production",
  "siteId": "demo",
  "siteUuid": "4b4c8e8361ef4b47b64f5c20a7db7c47",
  "routeId": "route_demo",
  "versionId": "ver_demo",
  "policyVersion": 3,
  "sub": "anonymous",
  "anonymous": true,
  "scope": ["data:site:get", "data:site:set", "data:site:delete"],
  "traceId": "trace_demo",
  "iat": 1700000000,
  "nbf": 1700000000,
  "exp": 1700000060
}
```

User capability:

```json
{
  "iss": "pages-v2",
  "aud": "pages-kv-gateway",
  "apiVersion": 2,
  "dataScope": "user",
  "env": "production",
  "siteId": "demo",
  "siteUuid": "4b4c8e8361ef4b47b64f5c20a7db7c47",
  "routeId": "route_demo",
  "versionId": "ver_demo",
  "policyVersion": 3,
  "sub": "usr_123",
  "anonymous": false,
  "scope": ["data:user:get", "data:user:set", "data:user:delete"],
  "traceId": "trace_demo",
  "iat": 1700000000,
  "nbf": 1700000000,
  "exp": 1700000060
}
```

Gateway verifies signature, time, environment, site slug, site UUID, `dataScope`, operation scope, and user identity shape. It only uses claims to derive storage keys.

Legacy capability compatibility:

- Existing legacy claims without `dataScope` are accepted only on `/v1/kv/*` and treated as `site`.
- New `/v1/data/site/*` requires `dataScope: "site"` and `data:site:*` scopes.
- `/v1/data/user/*` requires `dataScope: "user"` and `data:user:*` scopes.
- Router derives `data:*` scopes from existing route snapshot `kv.scopes`: `kv:get -> data:*:get`, `kv:set -> data:*:set`, and `kv:delete -> data:*:delete`. A read-only route must not gain write access by using the new data paths.

## Browser Data Flow

Site data:

```text
Browser SDK
  -> POST /.xd-pages/runtime/v1/data/site/get
  -> pages-router validates route, method, runtime header, Origin, and access policy
  -> router signs site capability
  -> router calls XD_PAGES_KV_GATEWAY /v1/data/site/get
  -> gateway verifies site capability and operation scope
  -> SITE_DATA.get s/{slug}--{siteUuid}/k/{key}
  -> response envelope returns to browser
```

User data:

```text
Browser SDK
  -> POST /.xd-pages/runtime/v1/data/user/get
  -> pages-router validates route, method, runtime header, Origin, and access policy
  -> router reads site session identity
  -> router signs user capability with sub/anonymous
  -> router calls XD_PAGES_KV_GATEWAY /v1/data/user/get
  -> gateway verifies user capability and operation scope
  -> if anonymous and get: return found=false, value=null
  -> if authenticated: SITE_DATA.get s/{slug}--{siteUuid}/u/{userId}/k/{key}
  -> response envelope returns to browser
```

Protected site behavior is unchanged. For `org`, `acl`, and `owner` sites, unauthenticated requests are redirected to auth or rejected before reaching gateway. Anonymous `user.get -> null` applies only after the router has accepted anonymous access, such as an `internal` site.

## Worker Data Flow

Router dispatches user Workers with sanitized headers. It injects separate data capability headers:

```text
CF-Platform-Data-Site-Capability: <site capability>
CF-Platform-Data-User-Capability: <user capability>
```

Worker SDK rules:

- `pages.data.site` reads `CF-Platform-Data-Site-Capability`, then falls back to `env.XD_PAGES_DATA_SITE_CAPABILITY`. If only legacy `env.XD_PAGES_KV_CAPABILITY` or `CF-Platform-KV-Capability` exists, it uses the legacy `/v1/kv/*` gateway path as a site-level compatibility fallback.
- `pages.kv` uses only the legacy site-level gateway path.
- `pages.data.user` reads only `CF-Platform-Data-User-Capability` from the current request.
- `pages.data.user` never reads `env.XD_PAGES_KV_CAPABILITY`, `env.XD_PAGES_DATA_SITE_CAPABILITY`, or any static env capability.

This keeps user data request-scoped. A deploy-time or env-level token cannot become a current-user token.

## Authorization Failures

`pages.data.user.get()` returns `null` only when gateway receives a valid user capability with `anonymous: true` and the operation is `get`.

The following must not become `null`:

- Invalid or missing capability.
- `dataScope` mismatch.
- Missing operation scope.
- Protected site unauthenticated access.
- Stale site session.
- Anonymous `set` or `delete`.

Anonymous writes return a clear runtime envelope with `USER_REQUIRED`.

## Deprecation

SDK:

- `pages.kv` is marked `@deprecated Use pages.data.site instead.`
- README, skill docs, generated docs, and demo code use `pages.data.site` and `pages.data.user`.

Runtime:

- Legacy `/kv/*` paths remain available as site-level data.
- Legacy gateway responses include `Deprecation: true` and may include `X-XD-Pages-Deprecated: kv-runtime` for internal observability. Browser/runtime proxy responses expose only the standard `Deprecation` header and continue to strip `X-XD-Pages-*` platform headers.
- Logs/metrics may record legacy path usage by site and trace id, but must not include raw keys, values, bearer tokens, email, or other PII.

## Test Requirements

- Protocol exports new runtime/gateway paths and can build site/user storage keys without collisions.
- Gateway rejects site capability on user paths and user capability on site or legacy paths.
- Gateway ignores body `siteId`, `scope`, and `userId`.
- Gateway derives user key from `claims.sub`.
- Anonymous user get returns null; anonymous user set/delete returns `USER_REQUIRED`.
- Router maps new runtime paths to the correct gateway paths and signs matching `dataScope` capabilities.
- Router sanitizes all platform capability headers from browser runtime proxy responses, including `CF-Platform-Data-Site-Capability` and `CF-Platform-Data-User-Capability`.
- Router keeps protected unauthenticated requests out of the gateway.
- Worker SDK `pages.data.user` refuses env static capabilities and uses only request user capability.
- Browser SDK posts to new data paths.
- Legacy `pages.kv` and `/kv/*` continue to work as deprecated site-level compatibility.
