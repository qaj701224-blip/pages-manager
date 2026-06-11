# Staging Demo Deployment Tests Design

## Goal

Add a repeatable local script that deploys every demo project through the staging API and verifies the deployed URLs respond.

## Demo Roles

- `demos/html-img`: static preset fixture for plain HTML and SVG assets.
- `demos/vue-app`: spa preset fixture for Vue Router fallback.
- `demos/nuxt-app`: spa preset fixture for a generated Nuxt 3 static site.
- `demos/api-demo`: worker preset fixture for `_worker.js` plus static assets.

## Environment

The script reads `.env` from the repository root by default. It requires `PAGES_TOKEN` and defaults `PAGES_API` to `https://api-staging.workers.xd.team`.

The script must not print the token. A custom env file can be passed for tests.

The script refuses non-staging `PAGES_API` values unless `PAGES_DEMO_ALLOW_NON_STAGING=true` is set.

## Site Names

Use fixed names so repeated runs overwrite the same staging sites owned by the same token:

- `demo-html-img`
- `demo-vue-app`
- `demo-nuxt-app`
- `demo-api`

`PAGES_DEMO_PREFIX` can override the prefix if a fixed name is already owned by another token.

## pnpm / Workspace Relationship

Demos are integration fixtures and are not part of the root `pnpm-workspace.yaml`. The root workspace remains limited to deployable apps and shared packages.

Framework demos keep their own package manager files and are installed only when the staging demo script builds them. This avoids making normal server CI/deploy install Vue or Nuxt demo dependencies.

## Script Behavior

Create `scripts/test-staging-demos.sh`.

- Supports `--dry-run` to print the deployment plan without installing, building, or calling staging.
- Supports `--env-file <path>` for tests or local overrides.
- Supports `--demo <id>` to run one demo.
- Builds framework demos before deployment.
- Deploys via `POST /deploy` with `X-Pages-Token`.
- Verifies each returned URL with a deterministic HTTP check.
- Keeps IP restriction enabled by default, with `PAGES_DEMO_IP_RESTRICT=false` available for local troubleshooting.
