# Demos

`demos/` contains staging integration fixtures for Pages Manager. They are intentionally not part of the root `pnpm-workspace.yaml`; normal server CI and deploys should not install Vue or Nuxt demo dependencies.

## Projects

| Demo | Preset | Purpose | Deploy source |
| --- | --- | --- | --- |
| `html-img` | `static` | Plain HTML plus SVG asset serving | `demos/html-img` |
| `vue-app` | `spa` | Vue Router fallback and client-side state smoke test | `demos/vue-app/dist` after build |
| `nuxt-app` | `spa` | Nuxt 3 generated static output | `demos/nuxt-app/.output/public` after generate |
| `api-demo` | `worker` | Custom `_worker.js`, explicit IP guard, and static assets through `env.ASSETS` | `demos/api-demo` |

## Staging Test Script

This section covers the legacy v1 `workers.xd.team` demos.

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
```

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

After deploying `vue-app`, open the published home page and verify client-side routing by navigating to `/about` and refreshing the page.

## Pages v2 Vue Demo

The Vue demo can also smoke-test the v2 `pages.xd.team` platform through the v2 CLI. This path does not use `PAGES_TOKEN` or the legacy multipart API.

Dry run:

```bash
scripts/test-pages-v2-demos.sh --dry-run
```

Deploy the Vue demo to v2 staging:

```bash
PAGES_ACCESS_KEY=xdpak_staging_xxx scripts/test-pages-v2-demos.sh
```

The v2 script defaults to:

```bash
PAGES_V2_DEMO_TARGET=staging
PAGES_V2_API=https://api-staging.pages.xd.team
PAGES_V2_DEMO_SLUG=demo-vue-app
PAGES_V2_DEMO_VISIBILITY=public
```

By default it verifies `https://demo-vue-app-staging.pages.xd.team/` and `/about`. Use `--slug <name>` for a personal staging site, or `--target production --slug <name>` for a production smoke test.

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
