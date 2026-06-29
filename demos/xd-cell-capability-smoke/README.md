# XD Cell Capability Smoke Demo

This demo is a single `worker-with-assets` target for checking the current XD Cell v2 publishing path.

It covers:

- Worker with Assets packaging.
- SPA fallback through `assets.not_found_handling = "single-page-application"`.
- Runtime `vars` from `xd-cell.config.json`.
- Site-level secrets injected on the next Worker deploy.
- `XD_PAGES_KV_GATEWAY` runtime data binding inspection.
- JSON API routes served before static assets.

## Local Dry Run

From this directory:

```bash
xd-cell deploy --dry-run --json
```

Expected shape:

- `decision.deploymentShape` is `worker-with-assets`.
- `decision.routingMode` is `worker-first`.
- `runtime.vars` lists `API_BASE`, `DEMO_LABEL`, and `FEATURE_FLAG`.
- No network request is needed for the dry run.

## Staging Smoke

Use a personal staging slug when running repeated manual tests. The simplest path is to copy this demo to a scratch
directory and change `name` in `xd-cell.config.json` before deploying.

```bash
printf '%s' "$XD_CELL_DEMO_API_TOKEN" | xd-cell secrets put xd-cell-capability-smoke API_TOKEN --env staging --stdin
xd-cell deploy --env staging
xd-cell open xd-cell-capability-smoke --env staging
```

Then check:

- `/api/health` returns `ok: true`.
- `checks.vars.API_BASE` matches the config value.
- `checks.secrets.hasApiToken` is `true`; the secret value itself is not returned.
- The page loads `/app.js` and `/styles.css` through the Assets binding.
- A deep link such as `/client/route/deep-link` serves the SPA fallback.
- The Runtime Data panel reports whether the gateway binding is present.

## Second Deploy Checks

To verify site-level runtime config behavior:

1. Change `FEATURE_FLAG` in `xd-cell.config.json`.
2. Deploy again.
3. Confirm `/api/health` shows the new value.
4. Remove the `vars` field entirely and deploy again.
5. Confirm the previous vars are still present because omitted vars are preserved.
6. Set `"vars": {}` and deploy again.
7. Confirm the vars are cleared on the newly deployed Worker.

Secrets follow a similar rule: `xd-cell secrets put/delete` changes the site-level secret store, and the next Worker deploy materializes the current enabled secrets into the new user Worker bindings.
