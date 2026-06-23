# Validation

Choose the narrowest useful checks for the touched area, then record them in `finish.tests`.

- Platform Agent executor changes: `node --test tests/scripts/platform-agent-coding.test.js`.
- Workflow routing or permissions changes: `node --test scripts/workflows.test.js tests/project-policy.test.js`.
- Agent instruction or docs truth-source changes: `node --test scripts/agent-docs.test.js tests/project-policy.test.js`.
- Gateway, worker, or shared workflow-core changes: run the nearest affected `node:test` files first.
- Before finishing substantial platform changes, prefer `pnpm lint` and `pnpm test` when the runner environment has the required pnpm version.
- If a check cannot run because of environment limits, mention the exact command and failure in `finish.tests`.
