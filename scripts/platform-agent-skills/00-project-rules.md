# Project Rules

Use these rules before editing pages-manager platform code.

- Keep every change scoped to the Platform Dev request.
- Do not merge or auto-merge `master`; only produce branch changes for the workflow PR path.
- Every code, workflow, script, or behavior change must update matching documentation.
- Keep ordinary Markdown documents under 700 lines. Split long docs and keep an index when needed.
- Do not write secrets, tokens, cookies, local env values, real account data, or Cloudflare resource ids.
- Treat `.github/`, `k8s/`, `deploy/`, `docker/`, `Dockerfile`, and deploy/k8s/put scripts as high-risk paths.
- Do not modify personal site content under `sites/**` unless the Platform Dev request explicitly asks for it.
