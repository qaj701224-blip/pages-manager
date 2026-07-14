# XD Cell CLI Site Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `xd-cell sites delete <slug>` with interactive confirmation, explicit `--yes` automation support, stable JSON output, and synchronized public documentation.

**Architecture:** Keep the server contract unchanged. The CLI resolves the user-facing slug through the existing site list, confirms only on an interactive TTY, then calls the existing `DELETE /.xd-pages/api/sites/{id}` endpoint. Visible confirmation input is injected by `main.js`, separate from hidden secret input, so command tests remain deterministic.

**Tech Stack:** Node.js 22, ESM, built-in `node:test`, `node:readline/promises`, existing CLI API client and output envelopes.

---

## File Structure

- Modify `apps/pages-cli/src/args.js`: recognize `--yes` as a boolean flag.
- Modify `apps/pages-cli/src/args.test.js`: lock the `--yes` parse contract.
- Modify `apps/pages-cli/src/main.js`: provide visible TTY line input and inject `readConfirmation`.
- Modify `apps/pages-cli/src/main.test.js`: verify visible input and injection without secret-mode behavior.
- Modify `apps/pages-cli/src/commands.js`: validate delete-only flags, resolve the site, confirm, delete, and format output/help.
- Modify `apps/pages-cli/src/commands.test.js`: cover success, confirmation, cancellation, fail-closed automation, usage errors, and API failures.
- Modify `apps/pages-api/src/public-docs.js`: expose the CLI command to users/agents without exposing HTTP.
- Modify `apps/pages-api/src/openapi.test.js`: assert public skill/README examples use the CLI boundary.
- Modify `docs/architecture/publishing-and-runtime.md`: record CLI command and existing soft-delete/hostname-hold semantics.

### Task 1: Parse the `--yes` Boolean Flag

**Files:**

- Modify: `apps/pages-cli/src/args.test.js`
- Modify: `apps/pages-cli/src/args.js:1`

- [ ] **Step 1: Write the failing parser test**

Add to `apps/pages-cli/src/args.test.js`:

```js
test('parses sites delete confirmation as a boolean flag', () => {
  assert.deepEqual(parseArgs(['sites', 'delete', 'demo', '--yes', '--json']), {
    command: 'sites',
    positional: ['delete', 'demo'],
    flags: {
      yes: true,
      json: true,
    },
  });
});
```

- [ ] **Step 2: Run the parser test and verify it fails**

Run: `node --test apps/pages-cli/src/args.test.js`

Expected: FAIL because `--yes` currently requires a value.

- [ ] **Step 3: Add `yes` to the boolean flag set**

Change the first line of `apps/pages-cli/src/args.js` to:

```js
const BOOLEAN_FLAGS = new Set(['no-open', 'print', 'json', 'help', 'save-config', 'details', 'dry-run', 'stdin', 'yes']);
```

- [ ] **Step 4: Run the parser test and verify it passes**

Run: `node --test apps/pages-cli/src/args.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the parser change**

```bash
git add apps/pages-cli/src/args.js apps/pages-cli/src/args.test.js
git commit -m "feat(pages-cli): 解析站点删除确认参数"
```

### Task 2: Add Injectable Visible TTY Input

**Files:**

- Modify: `apps/pages-cli/src/main.test.js`
- Modify: `apps/pages-cli/src/main.js:1-35`

- [ ] **Step 1: Write failing tests for visible input and command injection**

Add `PassThrough` to the imports and add these tests to `apps/pages-cli/src/main.test.js`:

```js
import { PassThrough } from 'node:stream';

import { main, readHiddenLine, readVisibleLine } from './main.js';

test('readVisibleLine reads a visible line from an interactive TTY', async () => {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = capture();
  const answer = readVisibleLine('确认删除? ', { stdin, stdout });

  stdin.write('yes\n');

  assert.equal(await answer, 'yes');
  assert.equal(stdout.text(), '确认删除? ');
});

test('main injects visible confirmation input separately from secret input', async () => {
  const stdout = capture();
  const stderr = capture();
  let readConfirmation;

  const exitCode = await main(['sites', 'delete', 'demo'], {
    stdout,
    stderr,
    stdin: { isTTY: true },
    readConfirmation: async () => 'yes',
    commandRunner: async (_argv, options) => {
      readConfirmation = options.readConfirmation;
      assert.equal(await options.readConfirmation('确认? '), 'yes');
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(typeof readConfirmation, 'function');
  assert.equal(stderr.text(), '');
});
```

- [ ] **Step 2: Run the main tests and verify they fail**

Run: `node --test apps/pages-cli/src/main.test.js`

Expected: FAIL because `readVisibleLine` and `readConfirmation` do not exist.

- [ ] **Step 3: Implement visible line input and inject it**

Add the import and exported helper in `apps/pages-cli/src/main.js`:

```js
import { createInterface } from 'node:readline/promises';

export async function readVisibleLine(prompt = '', { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin?.isTTY) throw codedError('CONFIRMATION_STDIN_REQUIRED');
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: Boolean(stdin.isTTY && stdout?.isTTY),
  });
  try {
    return await readline.question(prompt);
  } catch {
    throw codedError('CONFIRMATION_INPUT_CANCELLED');
  } finally {
    readline.close();
  }
}
```

Add this property beside `readSecret` in the `commandRunner` options:

```js
readConfirmation:
  io.readConfirmation ||
  ((prompt) =>
    readVisibleLine(prompt, {
      stdin: io.stdin || process.stdin,
      stdout,
    })),
```

- [ ] **Step 4: Run the main tests and verify they pass**

Run: `node --test apps/pages-cli/src/main.test.js`

Expected: PASS, including existing hidden-input tests.

- [ ] **Step 5: Commit the visible-input boundary**

```bash
git add apps/pages-cli/src/main.js apps/pages-cli/src/main.test.js
git commit -m "feat(pages-cli): 增加可见删除确认输入"
```

### Task 3: Implement `sites delete`

**Files:**

- Modify: `apps/pages-cli/src/commands.test.js`
- Modify: `apps/pages-cli/src/commands.js:39,692-723`

- [ ] **Step 1: Write failing tests for explicit confirmation and JSON output**

Add to `apps/pages-cli/src/commands.test.js`:

```js
test('sites delete resolves the slug and deletes the returned site id with --yes', async () => {
  const calls = [];
  const output = [];
  await executeCommand(['sites', 'delete', 'demo', '--yes', '--json'], {
    env: { XD_CELL_API_TOKEN: 'token' },
    fetch: fakeFetch(calls, [
      { sites: [{ id: 'site_1', slug: 'demo', environment: 'production' }] },
      { site: { id: 'site_1', slug: 'demo', deletedAt: '2026-07-14T00:00:00.000Z' } },
    ]),
    output: (line) => output.push(line),
  });

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(calls[1].url, 'https://api.pages.xd.team/.xd-pages/api/sites/site_1');
  assert.deepEqual(JSON.parse(output[0]), {
    ok: true,
    schemaVersion: 1,
    type: 'site',
    environment: 'production',
    site: 'demo',
    operation: 'delete',
    deleted: true,
  });
});
```

- [ ] **Step 2: Write failing tests for interactive confirmation and cancellation**

```js
test('sites delete accepts y or yes and treats any other answer as cancellation', async () => {
  for (const answer of ['y', 'YES']) {
    const calls = [];
    await executeCommand(['sites', 'delete', 'demo'], {
      env: { XD_CELL_API_TOKEN: 'token' },
      stdin: { isTTY: true },
      readConfirmation: async (prompt) => {
        assert.equal(prompt, '确认删除站点 "demo"? (y/N) ');
        return answer;
      },
      fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'demo' }] }, { site: { id: 'site_1', slug: 'demo' } }]),
      output: () => {},
    });
    assert.equal(calls[1].method, 'DELETE');
  }

  const cancelCalls = [];
  const cancelOutput = [];
  await executeCommand(['sites', 'delete', 'demo'], {
    env: { XD_CELL_API_TOKEN: 'token' },
    stdin: { isTTY: true },
    readConfirmation: async () => 'n',
    fetch: fakeFetch(cancelCalls, [{ sites: [{ id: 'site_1', slug: 'demo' }] }]),
    output: (line) => cancelOutput.push(line),
  });
  assert.equal(cancelCalls.length, 1);
  assert.deepEqual(cancelOutput, ['已取消删除站点：demo']);
});
```

- [ ] **Step 3: Write failing tests for fail-closed automation and flag boundaries**

```js
test('sites delete requires --yes for JSON or non-interactive execution', async () => {
  for (const argv of [
    ['sites', 'delete', 'demo', '--json'],
    ['sites', 'delete', 'demo'],
  ]) {
    const calls = [];
    await assert.rejects(
      () =>
        executeCommand(argv, {
          env: { XD_CELL_API_TOKEN: 'token' },
          stdin: { isTTY: false },
          fetch: fakeFetch(calls, [{ sites: [{ id: 'site_1', slug: 'demo' }] }]),
          output: () => {},
        }),
      { code: 'SITE_DELETE_CONFIRMATION_REQUIRED' }
    );
    assert.equal(calls.length, 1);
  }

  await assert.rejects(() => executeCommand(['sites', 'list', '--yes'], { output: () => {} }), {
    code: 'SITES_LIST_USAGE_INVALID',
  });
  await assert.rejects(() => executeCommand(['sites', 'info', 'demo', '--yes'], { output: () => {} }), {
    code: 'SITES_INFO_USAGE_INVALID',
  });
  await assert.rejects(() => executeCommand(['sites', 'delete', 'demo', '--details'], { output: () => {} }), {
    code: 'SITES_DELETE_USAGE_INVALID',
  });
});
```

- [ ] **Step 4: Run the command tests and verify they fail**

Run: `node --test apps/pages-cli/src/commands.test.js`

Expected: FAIL because `yes` is not allowed by `sites` and the delete subcommand is unknown.

- [ ] **Step 5: Implement delete-only validation and execution**

Extend the sites flag set:

```js
const SITES_FLAGS = new Set(['env', 'token', 'accessKey', 'json', 'help', 'details', 'yes']);
```

Move sites subcommand usage validation before credential resolution, so invalid deletion flags never read credentials or call the API:

```js
let siteSlug = null;
if (subcommand === 'list') {
  if (parsed.flags.yes !== undefined) {
    throw usageError('SITES_LIST_USAGE_INVALID', 'sites list 不接受 --yes。', '请使用 xd-cell sites list。');
  }
  assertNoPositionals(child, 'SITES_LIST_USAGE_INVALID', 'xd-cell sites list 不接受位置参数。');
} else if (subcommand === 'info') {
  if (parsed.flags.yes !== undefined) {
    throw usageError('SITES_INFO_USAGE_INVALID', 'sites info 不接受 --yes。', '请使用 xd-cell sites info <站点名>。');
  }
  siteSlug = readSingleSiteArg(child, 'SITES_INFO_USAGE_INVALID', '请使用 xd-cell sites info <站点名>。');
} else if (subcommand === 'delete') {
  if (parsed.flags.details !== undefined) {
    throw usageError('SITES_DELETE_USAGE_INVALID', 'sites delete 不接受 --details。', '请使用 xd-cell sites delete <站点名>。');
  }
  siteSlug = readSingleSiteArg(child, 'SITES_DELETE_USAGE_INVALID', '请使用 xd-cell sites delete <站点名>。');
} else {
  throw usageError(
    'SITES_COMMAND_INVALID',
    'sites 命令无效。',
    '请使用 xd-cell sites list、xd-cell sites info <站点名> 或 xd-cell sites delete <站点名>。'
  );
}

const config = readConfigForCommand(parsed, context);
const credential = await resolveCredential(config.environment, context, parsed);
const client = createClient(config, credential, context);
```

Remove the now-duplicate `assertNoPositionals` from the `list` branch, and replace the first two lines of the `info` branch with:

```js
if (subcommand === 'info') {
  const result = await readSiteBySlug(client, siteSlug);
```

Insert this branch before `SITES_COMMAND_INVALID`:

```js
if (subcommand === 'delete') {
  const { site } = await readSiteBySlug(client, siteSlug);

  if (!parsed.flags.yes) {
    if (parsed.flags.json || !context.stdin?.isTTY || typeof context.readConfirmation !== 'function') {
      throw usageError(
        'SITE_DELETE_CONFIRMATION_REQUIRED',
        '删除站点需要显式确认。',
        '确认目标后添加 --yes；JSON 和非交互环境必须使用 --yes。'
      );
    }
    const answer = await context.readConfirmation(`确认删除站点 "${site.slug}"? (y/N) `);
    if (
      !['y', 'yes'].includes(
        String(answer || '')
          .trim()
          .toLowerCase()
      )
    ) {
      context.output(`已取消删除站点：${site.slug}`);
      return 0;
    }
  }

  await client.requestApi('DELETE', `/.xd-pages/api/sites/${encodeURIComponent(site.id)}`);
  if (
    outputJsonResult(parsed, context, {
      type: 'site',
      environment: config.environment,
      site: site.slug,
      operation: 'delete',
      deleted: true,
    })
  ) {
    return 0;
  }
  context.output(`已删除站点：${site.slug}`);
  return 0;
}
```

Remove the old final `SITES_COMMAND_INVALID` throw because unknown subcommands are now rejected before credentials are loaded.

- [ ] **Step 6: Add API failure and missing-site regression assertions**

Add a test that confirms `SITE_NOT_FOUND` sends no DELETE, and an `ApiError` with `SITE_POLICY_FORBIDDEN` produces no success output:

```js
test('sites delete does not report success when lookup or delete fails', async () => {
  const missingCalls = [];
  await assert.rejects(
    () =>
      executeCommand(['sites', 'delete', 'missing', '--yes'], {
        env: { XD_CELL_API_TOKEN: 'token' },
        fetch: fakeFetch(missingCalls, [{ sites: [] }]),
        output: () => {},
      }),
    { code: 'SITE_NOT_FOUND' }
  );
  assert.equal(missingCalls.length, 1);

  const output = [];
  await assert.rejects(
    () =>
      executeCommand(['sites', 'delete', 'demo', '--yes'], {
        env: { XD_CELL_API_TOKEN: 'token' },
        fetch: fakeFetch(
          [],
          [
            { sites: [{ id: 'site_1', slug: 'demo' }] },
            {
              status: 403,
              body: { error: { code: 'SITE_POLICY_FORBIDDEN', message: 'Forbidden.', action: 'Ask the owner.' } },
            },
          ]
        ),
        output: (line) => output.push(line),
      }),
    { code: 'SITE_POLICY_FORBIDDEN' }
  );
  assert.deepEqual(output, []);
});
```

- [ ] **Step 7: Run focused CLI tests and verify they pass**

Run: `node --test apps/pages-cli/src/args.test.js apps/pages-cli/src/main.test.js apps/pages-cli/src/commands.test.js`

Expected: PASS.

- [ ] **Step 8: Commit the command behavior**

```bash
git add apps/pages-cli/src/commands.js apps/pages-cli/src/commands.test.js
git commit -m "feat(pages-cli): 支持删除站点"
```

### Task 4: Synchronize CLI Help and Public Documentation

**Files:**

- Modify: `apps/pages-cli/src/commands.test.js`
- Modify: `apps/pages-cli/src/commands.js:1435-1545`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `apps/pages-api/src/public-docs.js`
- Modify: `docs/architecture/publishing-and-runtime.md`

- [ ] **Step 1: Write failing help and public-doc tests**

Add to `apps/pages-cli/src/commands.test.js`:

```js
test('sites help documents interactive and non-interactive deletion', async () => {
  const output = [];
  await executeCommand(['help', 'sites'], { output: (line) => output.push(line) });
  const help = output.join('\n');
  assert.match(help, /xd-cell sites delete <站点名>/);
  assert.match(help, /--yes/);
  assert.match(help, /默认要求交互确认/);
});
```

Extend the production public-doc test in `apps/pages-api/src/openapi.test.js`:

```js
assert.match(body, /xd-cell sites delete <site> --yes --json/);
assert.doesNotMatch(body, /DELETE \/\.xd-pages\/api\/sites/);
```

- [ ] **Step 2: Run the documentation tests and verify they fail**

Run: `node --test apps/pages-cli/src/commands.test.js apps/pages-api/src/openapi.test.js`

Expected: FAIL because help and public skill do not mention deletion.

- [ ] **Step 3: Update `sites` help**

Replace the `sites` help header and options with:

```text
用法：xd-cell sites list [选项]
      xd-cell sites info <站点名> [选项]
      xd-cell sites delete <站点名> [--yes] [选项]

查看站点列表、站点详情或删除站点。

选项：
  --yes                                     确认删除；JSON 和非交互环境必须显式传入。
  --token <token>                           只在本次命令中使用的 API token；也可以设置 XD_CELL_API_TOKEN。
  --details                                 仅 sites list 输出完整站点详情；默认只显示概要。
  --json                                    输出稳定 JSON，适合 AI agent 和 CI 解析。
  --help                                    显示帮助。

说明：
  sites delete 默认要求交互确认；取消不发送删除请求。
```

- [ ] **Step 4: Add safe CLI examples to public docs**

Add this production-only line to both command guides in `apps/pages-api/src/public-docs.js`:

```text
xd-cell sites delete <site> --yes --json
```

Use `demo` instead of `<site>` in the README command guide.

- [ ] **Step 5: Document the existing server deletion semantics**

Add after the daily CLI command block in `docs/architecture/publishing-and-runtime.md`:

```markdown
`xd-cell sites delete <站点名>` 默认在交互终端确认；agent、CI 和 `--json` 必须显式传 `--yes`。CLI 先按当前凭证可见站点解析 slug，再调用现有按 site ID 删除接口。服务端继续执行软删除、移除 route snapshot，并保留 hostname reuse hold；本命令不提供恢复、永久删除或批量删除。
```

Also add `xd-cell sites delete foo --yes` to the command block.

- [ ] **Step 6: Run help and public-doc tests**

Run: `node --test apps/pages-cli/src/commands.test.js apps/pages-api/src/openapi.test.js`

Expected: PASS.

- [ ] **Step 7: Commit help and documentation**

```bash
git add apps/pages-cli/src/commands.js apps/pages-cli/src/commands.test.js apps/pages-api/src/public-docs.js apps/pages-api/src/openapi.test.js docs/architecture/publishing-and-runtime.md
git commit -m "docs(pages-cli): 说明站点删除命令"
```

### Task 5: Verify the CLI Deliverable

**Files:**

- Verify only; no expected source edits.

- [ ] **Step 1: Run all CLI tests**

Run: `node --test apps/pages-cli/src/*.test.js`

Expected: PASS.

- [ ] **Step 2: Run affected pages-api documentation tests**

Run: `node --test apps/pages-api/src/openapi.test.js`

Expected: PASS.

- [ ] **Step 3: Check the diff for secrets and accidental API changes**

Run:

```bash
git diff --check
git diff -- apps/pages-cli apps/pages-api/src/public-docs.js apps/pages-api/src/openapi.test.js docs/architecture/publishing-and-runtime.md
```

Expected: no whitespace errors, no token values, and no changes to the pages-api delete handler/OpenAPI contract.

- [ ] **Step 4: Run repository lint and test suites**

Run:

```bash
pnpm lint
pnpm test
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit any test-only correction if verification required one**

Only when verification exposed a defect:

```bash
git add apps/pages-cli apps/pages-api/src/public-docs.js apps/pages-api/src/openapi.test.js docs/architecture/publishing-and-runtime.md
git commit -m "test(pages-cli): 补充站点删除回归覆盖"
```
