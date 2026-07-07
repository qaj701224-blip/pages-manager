# XD Cell XDS VPC Smoke Demo

This demo verifies three runtime capabilities in one Worker with Assets deployment:

- Plain env vars from `xd-cell.config.json`.
- Site-level secrets through `xd-cell secrets put`.
- The `XD_OFFICE_NET` VPC Network binding by calling the XDS search endpoint.

The Worker never returns the secret value. It only reports whether the secret binding is present and summarizes the XDS response shape.

## Dry Run

```bash
xd-cell deploy --dry-run --json
```

Expected shape:

- `decision.deploymentShape` is `worker-with-assets`.
- `decision.routingMode` is `worker-first`.
- `runtime.vars` lists `XDS_SEARCH_KEYWORD`.

## Staging Smoke

Configure the secret before testing XDS:

```bash
printf '%s' "$XDS_OPENAI_TOKEN" | xd-cell secrets put xd-cell-xds-vpc-smoke XDS_OPENAI_TOKEN --env staging --stdin
xd-cell deploy --env staging
```

Then check:

- `/api/health` returns `secret.secretPresent: true`.
- `/api/health` returns `bindings.XD_OFFICE_NET: true`.
- `/api/xds-search` posts to `/xds-open-api/v1/oa-user/search` through `env.XD_OFFICE_NET.fetch(...)`.
- The JSON response includes only `status`, `code`, `itemCount`, and `sampleKeys`; it does not include token values or full user records.

If `XD_OFFICE_NET` is missing, `/api/xds-search` returns `VPC_BINDING_MISSING`. If the XDS token secret is missing, it returns `XDS_TOKEN_MISSING`.
