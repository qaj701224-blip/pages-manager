# Demos

`demos/` contains staging integration fixtures for Pages Manager. They are intentionally not part of the root `pnpm-workspace.yaml`; normal server CI and deploys should not install Vue or Nuxt demo dependencies.

## Projects

| Demo | Preset | Purpose | Deploy source |
| --- | --- | --- | --- |
| `html-img` | `static` | Plain HTML plus SVG asset serving | `demos/html-img` |
| `vue-app` | `spa` | Vue Router fallback plus browser Pages KV SDK read/write test panel | `demos/vue-app/dist` after build |
| `nuxt-app` | `spa` | Nuxt 3 generated static output | `demos/nuxt-app/.output/public` after generate |
| `api-demo` | `worker` | Custom `_worker.js`, explicit IP guard, and static assets through `env.ASSETS` | `demos/api-demo` |

## Staging Test Script

Create a local `.env` at the repository root:

```bash
cp .env.example .env
```

Then replace `PAGES_TOKEN=pages_yourname@xd.com` with your own token.

Run a dry run:

```bash
scripts/test-staging-demos.sh --dry-run
```

Deploy and verify all demos through staging:

```bash
scripts/test-staging-demos.sh
```

The script targets staging by default. To run the same smoke test against production, pass an explicit target and use a production-safe prefix:

```bash
PAGES_DEMO_PREFIX=prod-demo scripts/test-staging-demos.sh --target production
```

The script defaults to:

```bash
PAGES_DEMO_TARGET=staging
PAGES_API=https://api-staging.workers.xd.team
PAGES_DEMO_PREFIX=demo
PAGES_DEMO_IP_RESTRICT=true
```

`vue-app` is deployed with `kv=true` so the home page can exercise `@xd/pages-sdk/browser`.
Because `@xd/pages-sdk` may not be published yet, the demo imports the local built browser entry from `apps/pages-sdk/dist`.
The test script builds `@xd/pages-sdk` before building `vue-app`.

For safety, `PAGES_API` must match the selected target by default:

- `staging` -> `https://api-staging.workers.xd.team`
- `production` -> `https://api.workers.xd.team`

To target a nonstandard API intentionally, set:

```bash
PAGES_DEMO_ALLOW_NON_STAGING=true
```

Fixed staging site names:

| Demo | Site name |
| --- | --- |
| `html-img` | `demo-html-img` |
| `vue-app` | `demo-vue-app` |
| `nuxt-app` | `demo-nuxt-app` |
| `api-demo` | `demo-api` |

Repeated runs overwrite the same sites when the same `PAGES_TOKEN` owns them. If a name is already owned by another token, set a personal prefix in `.env`:

```bash
PAGES_DEMO_PREFIX=xtq-demo
```

Then the script deploys names such as `xtq-demo-html-img` and `xtq-demo-vue-app`.

To run one demo:

```bash
scripts/test-staging-demos.sh --demo vue-app
```

After deploying `vue-app`, open the published home page and use the Pages KV panel to write, read, and delete a test key.
The runtime endpoint remains protected by the staging IP allowlist.

## Package Manager Relationship

The root workspace remains:

```yaml
packages:
  - apps/*
  - packages/*
```

Demo dependencies are installed only by `scripts/test-staging-demos.sh` when a framework demo needs a build. The script uses the package manager implied by each demo lockfile:

- `pnpm-lock.yaml` -> `pnpm --dir <demo> install --frozen-lockfile`
- `package-lock.json` -> `npm --prefix <demo> ci`
- no lockfile -> `pnpm --dir <demo> install`

This keeps production deployment fast while still allowing demos to validate real framework output.

## Worker Preset IP Guard

`api-demo/_worker.js` includes the same `checkIP(request, env)` pattern exposed by `/openapi.json` under `x-libs.ip-guard`.

This matters because `worker` preset deployments receive `env.IP_ALLOWLIST`, but Pages Manager does not rewrite user `_worker.js` files. A custom Worker must call the guard explicitly near the start of `fetch()`:

```js
const blocked = checkIP(request, env);
if (blocked) return blocked;
```
