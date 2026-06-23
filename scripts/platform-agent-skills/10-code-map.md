# Code Map

Use this map to decide what to inspect first.

- Slack intake and user-facing platform request parsing: `apps/slack-agent/src/`, `apps/gateway/src/slack/`.
- Platform Dev orchestration and callbacks: `apps/gateway/src/control-plane/`, `apps/worker/src/jobs/platform-dev.js`.
- GitHub webhook and PR/comment handling: `apps/gateway/src/github/`, `packages/git-client/`.
- Runtime state and persistence: `apps/gateway/src/db/`, `packages/workflow-core/`.
- Platform Agent workflow and coding executor: `.github/workflows/platform-agent.yml`, `scripts/platform-agent-coding.mjs`.
- User site executor is separate: `.github/workflows/pages-agent.yml`, `scripts/pages-agent-coding.mjs`.
- Shared workflow policy tests live in `scripts/workflows.test.js` and `tests/project-policy.test.js`.
