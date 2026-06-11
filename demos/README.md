# Demos

`demos/` contains staging integration fixtures for Pages Manager. They are intentionally not part of the root `pnpm-workspace.yaml`; normal server CI and deploys should not install Vue or Nuxt demo dependencies.

## Projects

| Demo | Preset | Purpose | Deploy source |
| --- | --- | --- | --- |
| `html-img` | `static` | Plain HTML plus SVG asset serving | `demos/html-img` |
| `vue-app` | `spa` | Vue Router fallback for client-side routes | `demos/vue-app/dist` after build |
| `nuxt-app` | `spa` | Nuxt 3 generated static output | `demos/nuxt-app/.output/public` after generate |
| `api-demo` | `worker` | Custom `_worker.js` plus static assets through `env.ASSETS` | `demos/api-demo` |

## Staging Test Script

Create a local `.env` at the repository root:

```bash
PAGES_TOKEN=pages_yourname@xd.com
```

Run a dry run:

```bash
scripts/test-staging-demos.sh --dry-run
```

Deploy and verify all demos through staging:

```bash
scripts/test-staging-demos.sh
```

The script defaults to:

```bash
PAGES_API=https://api-staging.workers.xd.team
PAGES_DEMO_PREFIX=demo
PAGES_DEMO_IP_RESTRICT=true
```

For safety, the script refuses non-staging `PAGES_API` values by default. To target another API intentionally, set:

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
