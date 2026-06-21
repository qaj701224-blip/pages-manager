# Pages V2 Artifact Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ADR 0001 artifact detection model so users and AI can deploy with `source`, `fallback`, and optional `worker.entry` instead of choosing `artifactKind`.

**Architecture:** Split implementation into safe phases. First add a CLI-side detector, package plan, `pages detect`, `pages deploy --dry-run`, and friendly output without changing the deployed wire protocol. Then introduce the pages-api `publishPlan` multipart protocol, authoritative decision validation, storage/provider metadata, switch CLI deploy to the new protocol, and finally update public docs once the behavior is live.

**Tech Stack:** Node.js ESM, `node:test`, existing `apps/pages-cli`, `apps/pages-api`, Cloudflare Workers multipart APIs, existing WFP/normal-worker-slot provider helpers.

Test snippets may use existing `api.pages.xd.team` fixtures because current tests already do. User-facing docs and final CLI URL examples must use the project’s configured public site domain (`workers.xd.team` / staging suffixes from config), not hardcoded historical fixture domains.

---

## File Structure

The implementation should keep new behavior focused and testable:

- Modify `apps/pages-cli/src/artifact.js`: add detector and packaging exports while leaving existing helpers only as temporary implementation scaffolding until Task 6 removes user-facing legacy paths:
  - `detectPublishTarget(targetPath, options)`
  - `createUploadPlan(targetPath, detection, options)`
  - `createPreflightEnvelope({ mode, target, detection, uploadPlan, diagnostics })`
  - canonical path, control-file, denylist, and manifest helpers.
- Modify `apps/pages-cli/src/artifact.test.js`: detector, fallback, denylist, `_worker.js`, control file, and upload plan tests.
- Modify `apps/pages-cli/src/command-config.js`: accept `source`, `fallback`, and `worker.entry`; keep `dir` as a temporary alias for existing config users, and remove `artifactKind` as a user intent field.
- Modify `apps/pages-cli/src/command-config.test.js`: config validation, secret-field rejection, nested worker config tests.
- Modify `apps/pages-cli/src/commands.js`: add `detect` command, `--dry-run`, `--fallback`, `--worker-entry`, `--yes`, JSON envelope, and human progress.
- Modify `apps/pages-cli/src/commands.test.js`: CLI command behavior, no network on detect/dry-run, JSON envelope, stdout/stderr style output through injected outputs.
- Modify `apps/pages-api/src/deployments.js`: introduce v2 multipart metadata parsing and authoritative decision validation.
- Modify `apps/pages-api/src/deployments.test.js`: multipart `metadata.schemaVersion`, manifest arrays, duplicate part rejection, fallback conflict, and worker-with-assets validation.
- Modify `apps/pages-api/src/schema.js` and migrations under `apps/pages-api/migrations/`: add resolved decision fields and provider metadata fields to site versions/deployments.
- Modify `apps/pages-api/src/store.js` and `apps/pages-api/src/store.test.js`: persist and read resolved deployment metadata.
- Modify `apps/pages-api/src/execution-provider.js`: map `deploymentShape` / `routingMode` to Cloudflare assets metadata, separating `assets-only` from `worker-first`.
- Modify `apps/pages-api/src/openapi.js` and `apps/pages-api/src/openapi.test.js`: only after behavior is implemented; responses may show resolved decision, requests must not expose user-input `artifactKind`.
- Modify `apps/pages-skill/skill/SKILL.md`, `apps/pages-skill/skill/references/cli.md`, README/API docs only after implementation is complete.

## Task 1: CLI Detector And Decision Model

**Files:**
- Modify: `apps/pages-cli/src/artifact.js`
- Modify: `apps/pages-cli/src/artifact.test.js`

- [ ] **Step 1: Add failing detector tests**

Append focused tests to `apps/pages-cli/src/artifact.test.js`:

```js
import { symlink } from 'node:fs/promises';

import { createUploadPlan, detectPublishTarget } from './artifact.js';

test('detectPublishTarget treats static and SPA as fallback decisions, not artifact kinds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'index.html'), '<div id="app"></div>');
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("app");');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.requestedFallback, 'auto');
  assert.equal(decision.resolvedFallback, 'index');
  assert.equal(decision.routingMode, 'assets-only');
  assert.equal(decision.confidence, 'medium');
  assert.equal(decision.workerEntry, null);
});

test('detectPublishTarget prefers not-found for multi-page static exports', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-static-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Home</h1>');
  await writeFile(path.join(dir, 'about.html'), '<h1>About</h1>');
  await writeFile(path.join(dir, '404.html'), '<h1>Missing</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.resolvedFallback, 'not-found');
  assert.equal(decision.routingMode, 'assets-only');
});

test('detectPublishTarget recognizes top-level _worker.js as Worker with Assets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-worker-assets-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '_worker.js'), 'export default { fetch() {} };');
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'worker-with-assets');
  assert.equal(decision.workerEntry, '_worker.js');
  assert.equal(decision.routingMode, 'worker-first');
  assert.equal(decision.resolvedFallback, 'index');
});

test('detectPublishTarget does not auto-detect ordinary worker.js in directories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-detect-ordinary-worker-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'worker.mjs'), 'export default { fetch() {} };');
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  assert.equal(decision.deploymentShape, 'assets-only');
  assert.equal(decision.workerEntry, null);
});

test('createUploadPlan excludes control files and rejects denylisted files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-upload-plan-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, '_redirects'), '/* /index.html 200');
  await writeFile(path.join(dir, '.env'), 'SECRET=bad');

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /PACKAGE_DENYLISTED_FILE/);
});

test('createUploadPlan rejects symlinks escaping source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'pages-cli-outside-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  test.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'secret-link.txt'));

  const decision = await detectPublishTarget(dir, { requestedFallback: 'auto' });

  await assert.rejects(() => createUploadPlan(dir, decision), /DETECT_SYMLINK_OUTSIDE_SOURCE/);
});
```

- [ ] **Step 2: Run detector tests and verify they fail**

Run:

```bash
node --test apps/pages-cli/src/artifact.test.js
```

Expected: FAIL because `detectPublishTarget` and `createUploadPlan` do not exist.

- [ ] **Step 3: Implement detector return shape**

In `apps/pages-cli/src/artifact.js`, add the new detector while keeping existing exports for compatibility:

```js
const CONTROL_FILE_NAMES = new Set(['_worker.js', '_headers', '_redirects', '_routes.json', '.assetsignore', 'pages.config.json']);
const SAFE_IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const DENYLISTED_BASENAMES = new Set(['.env', '.dev.vars', 'wrangler.toml', '.gitlab-ci.yml']);
const DENYLISTED_EXTENSIONS = new Set(['.pem', '.key']);

export async function detectPublishTarget(targetPath, options = {}) {
  const requestedFallback = options.requestedFallback || 'auto';
  if (!['auto', 'index', 'not-found'].includes(requestedFallback)) throw new Error('FALLBACK_INVALID');
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (stats.isFile()) return detectFileTarget(absolute, requestedFallback);
  if (!stats.isDirectory()) throw new Error('DETECT_TARGET_NOT_FOUND');

  const entries = await scanDirectory(absolute, { readControlSignals: true });
  const workerEntry = resolveWorkerEntry(absolute, entries, options.workerEntry);
  const publicAssets = entries.files.filter((file) => !file.control);
  const deploymentShape = workerEntry
    ? publicAssets.length > 0
      ? 'worker-with-assets'
      : 'worker-only'
    : 'assets-only';
  const resolvedFallback = resolveFallback({ requestedFallback, deploymentShape, entries, publicAssets });
  return {
    deploymentShape,
    requestedFallback,
    resolvedFallback,
    routingMode: deploymentShape === 'worker-with-assets' ? 'worker-first' : deploymentShape,
    workerEntry,
    confidence: confidenceFor({ requestedFallback, resolvedFallback, entries }),
    source: requestedFallback === 'auto' ? 'auto' : 'explicit',
    signals: entries.signals,
    diagnostics: entries.diagnostics,
  };
}
```

Implement helpers with these concrete rules:

```js
function detectFileTarget(absolute, requestedFallback) {
  const extension = path.extname(absolute).toLowerCase();
  if (extension === '.ts') throw new Error('WORKER_TYPESCRIPT_UNSUPPORTED');
  if (requestedFallback !== 'auto') throw new Error('FALLBACK_REQUIRES_ASSETS');
  if (extension === '.js' || extension === '.mjs') {
    return {
      deploymentShape: 'worker-only',
      requestedFallback,
      resolvedFallback: null,
      routingMode: 'worker-only',
      workerEntry: path.basename(absolute),
      confidence: 'high',
      source: 'auto',
      signals: [{ code: 'WORKER_FILE_TARGET', path: path.basename(absolute) }],
      diagnostics: [],
    };
  }
  return {
    deploymentShape: 'assets-only',
    requestedFallback,
    resolvedFallback: requestedFallback === 'index' ? 'index' : 'not-found',
    routingMode: 'assets-only',
    workerEntry: null,
    confidence: 'low',
    source: requestedFallback === 'auto' ? 'auto' : 'explicit',
    signals: [{ code: 'FILE_TARGET' }],
    diagnostics: [],
  };
}

function resolveFallback({ requestedFallback, deploymentShape, entries, publicAssets }) {
  if (deploymentShape === 'worker-only') {
    if (requestedFallback !== 'auto') throw new Error('FALLBACK_REQUIRES_ASSETS');
    return null;
  }
  if (requestedFallback === 'index') {
    if (!entries.files.some((file) => file.relativePath === 'index.html')) throw new Error('FALLBACK_INDEX_REQUIRES_INDEX_HTML');
    return 'index';
  }
  if (requestedFallback === 'not-found') return 'not-found';
  if (entries.signals.some((signal) => signal.code === 'STATIC_EXPORT_SIGNALS_FOUND')) return 'not-found';
  if (entries.signals.some((signal) => signal.code === 'EXPLICIT_INDEX_REWRITE_FOUND')) return 'index';
  const htmlFiles = publicAssets.filter((file) => file.relativePath.endsWith('.html'));
  if (htmlFiles.length === 1 && htmlFiles[0].relativePath === 'index.html') return 'index';
  return 'not-found';
}
```

- [ ] **Step 4: Implement scan and upload plan helpers**

Add these helpers in `apps/pages-cli/src/artifact.js`:

```js
export async function createUploadPlan(targetPath, decision) {
  const absolute = path.resolve(targetPath);
  const stats = await stat(absolute);
  if (!stats.isDirectory()) {
    if (decision.deploymentShape !== 'worker-only') throw new Error('STATIC_ARTIFACT_DIRECTORY_REQUIRED');
    const bundle = await buildWorkerBundle(absolute);
    return {
      publishPlan: publishPlanFromDecision(decision),
      contentHash: await hashUploadPlan([{ relativePath: bundle.mainModule, bytes: Buffer.from(bundle.modules[0].content) }], decision),
      fileCount: 1,
      sizeBytes: Buffer.byteLength(bundle.modules[0].content),
      assetManifest: [],
      assetFiles: [],
      workerMainModuleName: bundle.mainModule,
      workerModules: [{ moduleName: bundle.mainModule, partName: 'worker-main', content: bundle.modules[0].content, contentType: 'application/javascript+module' }],
      controlSignals: [],
    };
  }

  const entries = await scanDirectory(absolute, { failOnDenylist: true });
  const publicFiles = entries.files.filter((file) => !file.control && file.relativePath !== decision.workerEntry);
  if (decision.deploymentShape !== 'worker-only' && publicFiles.length === 0) throw new Error('PACKAGE_NO_PUBLIC_ASSETS_AFTER_EXCLUDES');
  const assetFiles = [];
  const assetManifest = [];
  let sizeBytes = 0;
  for (const [index, file] of publicFiles.sort(compareRelativePath).entries()) {
    const bytes = await readFile(file.absolutePath);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > MAX_STATIC_ARTIFACT_BYTES) throw new Error('ARTIFACT_BUNDLE_TOO_LARGE');
    const contentType = contentTypeFor(file.relativePath);
    assetManifest.push({ path: `/${file.relativePath}`, partName: `asset-file-${index}`, hash: hashAsset(bytes, contentType), size: bytes.byteLength, contentType });
    assetFiles.push({ relativePath: file.relativePath, partName: `asset-file-${index}`, bytes, contentType });
  }
  if (assetFiles.length > MAX_STATIC_ARTIFACT_FILES) throw new Error('ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED');

  return {
    publishPlan: publishPlanFromDecision(decision),
    contentHash: await hashUploadPlan(assetFiles, decision),
    fileCount: assetFiles.length,
    sizeBytes,
    assetManifest,
    assetFiles,
    workerMainModuleName: decision.workerEntry,
    workerModules: [],
    controlSignals: entries.controlSignals,
  };
}
```

Keep the old `buildAssetArtifact()` output for the legacy deploy path until Task 3 migrates it.

- [ ] **Step 5: Run detector tests and fix focused issues**

Run:

```bash
node --test apps/pages-cli/src/artifact.test.js
```

Expected: PASS for the new detector tests and existing artifact tests.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/pages-cli/src/artifact.js apps/pages-cli/src/artifact.test.js
git commit -m "feat(cli): 增加发布产物自动识别"
```

## Task 2: CLI Config Model

**Files:**
- Modify: `apps/pages-cli/src/command-config.js`
- Modify: `apps/pages-cli/src/command-config.test.js`

- [ ] **Step 1: Add failing config tests**

First update the existing `reads explicit one-shot command config` test so the fixture no longer contains `artifactKind`:

```js
await writeFile(
  path.join(dir, 'pages.config.json'),
  JSON.stringify({
    environment: 'staging',
    site: 'docs',
    source: './dist',
    visibility: 'org',
    fallback: 'auto',
  })
);

assert.deepEqual(await readCommandConfig('pages.config.json', { cwd: dir }), {
  environment: 'staging',
  site: 'docs',
  source: './dist',
  visibility: 'org',
  fallback: 'auto',
});
```

Then append tests to `apps/pages-cli/src/command-config.test.js`:

```js
test('command config accepts source fallback and worker entry', async () => {
  assert.deepEqual(
    validateCommandConfig({
      environment: 'production',
      site: 'demo',
      source: './dist',
      fallback: 'index',
      worker: { entry: './worker.mjs' },
    }),
    {
      environment: 'production',
      site: 'demo',
      source: './dist',
      fallback: 'index',
      worker: { entry: 'worker.mjs' },
    }
  );
});

test('command config rejects worker entry outside source', async () => {
  assert.throws(
    () => validateCommandConfig({ source: './dist', worker: { entry: '../worker.mjs' } }),
    /COMMAND_CONFIG_WORKER_ENTRY_INVALID/
  );
});

test('command config rejects artifactKind as a user intent field', async () => {
  assert.throws(() => validateCommandConfig({ artifactKind: 'spa' }), /COMMAND_CONFIG_UNKNOWN_FIELD:artifactKind/);
});
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```bash
node --test apps/pages-cli/src/command-config.test.js
```

Expected: FAIL because `source`, `fallback`, and `worker` are not allowed yet, and `artifactKind` is still accepted.

- [ ] **Step 3: Implement config parsing**

In `apps/pages-cli/src/command-config.js`, replace the allowed fields and add nested worker normalization:

```js
const ALLOWED_FIELDS = new Set(['environment', 'site', 'source', 'dir', 'visibility', 'fallback', 'worker']);
const VALID_FALLBACKS = new Set(['auto', 'index', 'not-found']);

function normalizeField(key, value) {
  if (key === 'fallback') {
    if (!VALID_FALLBACKS.has(value)) throw new Error('COMMAND_CONFIG_FALLBACK_INVALID');
    return value;
  }
  if (key === 'worker') return normalizeWorkerConfig(value);
  if (key === 'dir') return normalizeNonEmptyString('dir', value);
  if (key === 'source') return normalizeNonEmptyString('source', value);
  // keep existing environment / visibility / site handling here
}

function normalizeWorkerConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('COMMAND_CONFIG_WORKER_INVALID');
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'entry')) throw new Error(`COMMAND_CONFIG_UNKNOWN_FIELD:worker.${keys.find((key) => key !== 'entry')}`);
  const entry = normalizeNonEmptyString('worker_entry', value.entry).replaceAll('\\', '/');
  if (path.isAbsolute(entry) || entry.split('/').includes('..')) throw new Error('COMMAND_CONFIG_WORKER_ENTRY_INVALID');
  return { entry: entry.replace(/^\.\/+/, '') };
}
```

Keep `dir` as a temporary alias for compatibility in existing tests, but make new code prefer `source`.

- [ ] **Step 4: Run config tests**

Run:

```bash
node --test apps/pages-cli/src/command-config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/pages-cli/src/command-config.js apps/pages-cli/src/command-config.test.js
git commit -m "feat(cli): 支持发布配置 source fallback worker"
```

## Task 3: CLI Detect, Dry Run, And Output Envelope

**Files:**
- Modify: `apps/pages-cli/src/commands.js`
- Modify: `apps/pages-cli/src/commands.test.js`

- [ ] **Step 1: Add failing detect and dry-run tests**

Append tests to `apps/pages-cli/src/commands.test.js`:

```js
test('detect --json is local-only and emits resolved decision without upload plan', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const output = [];

  const exitCode = await executeCommand(['detect', '.', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('detect should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('detect should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'detect');
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.decision.requestedFallback, 'auto');
  assert.equal(body.decision.resolvedFallback, 'index');
  assert.equal(body.checks.packageChecked, false);
  assert.equal(body.checks.canPackage, null);
  assert.equal(body.sideEffects.willDeploy, false);
  assert.equal('uploadPlanSummary' in body, false);
  assert.equal('artifactKind' in JSON.parse(output.join('\n')), false);
});

test('deploy --dry-run --json packages locally without network side effects', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  const output = [];

  const exitCode = await executeCommand(['deploy', '.', 'docs', '--dry-run', '--json'], {
    cwd: dir,
    secretStore: {
      get: async () => {
        throw new Error('dry-run should not read secrets');
      },
    },
    fetch: async () => {
      throw new Error('dry-run should not access network');
    },
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  const body = JSON.parse(output.join('\n'));
  assert.equal(body.mode, 'dry-run');
  assert.equal(body.site, 'docs');
  assert.equal(body.checks.packageChecked, true);
  assert.equal(body.checks.canPackage, true);
  assert.equal(body.checks.remoteChecked, false);
  assert.equal(body.checks.canDeploy, null);
  assert.equal(body.sideEffects.willDeploy, false);
  assert.equal(body.uploadPlanSummary.fileCount, 1);
  assert.equal('artifactKind' in body, false);
});

test('deploy --json returns confirmation required instead of prompting for danger diagnostics', async () => {
  const dir = await tempProject();
  await writeFile(path.join(dir, 'index.html'), '<h1>Hello</h1>');
  await writeFile(path.join(dir, '.env'), 'SECRET=bad');
  const output = [];

  await assert.rejects(
    () =>
      executeCommand(['deploy', '.', 'docs', '--dry-run', '--json'], {
        cwd: dir,
        output: (line) => output.push(line),
      }),
    { code: 'PACKAGE_DENYLISTED_FILE' }
  );
});
```

- [ ] **Step 2: Run command tests and verify they fail**

Run:

```bash
node --test apps/pages-cli/src/commands.test.js
```

Expected: FAIL because `detect`, `--dry-run`, and the new envelope do not exist.

- [ ] **Step 3: Add command flags and dispatch**

In `apps/pages-cli/src/commands.js`:

```js
const DETECT_FLAGS = new Set(['config', 'fallback', 'workerEntry', 'json', 'help']);
const DEPLOY_FLAGS = new Set([
  'env',
  'visibility',
  'fallback',
  'workerEntry',
  'dryRun',
  'yes',
  'accessKey',
  'config',
  'json',
  'help',
  'slug',
  'site',
  'saveConfig',
]);
```

Add command dispatch:

```js
case 'detect':
  return runDetect(parsed, { ...options, cwd, env, profileDir, profile, output });
```

Update `validateCommandUsage()` to allow `detect` with `DETECT_FLAGS`.

- [ ] **Step 4: Implement `runDetect()`**

Add:

```js
async function runDetect(parsed, context) {
  if (parsed.positional.length > 1) {
    throw usageError('DETECT_USAGE_INVALID', 'detect 参数过多。', '请使用 pages detect <目录>。');
  }
  const commandConfig = await readCommandConfig(parsed.flags.config, { cwd: context.cwd });
  const source = parsed.positional[0] || commandConfig?.source || commandConfig?.dir || '.';
  const targetPath = path.resolve(context.cwd, source);
  const requestedFallback = parsed.flags.fallback || commandConfig?.fallback || 'auto';
  const workerEntry = parsed.flags.workerEntry || commandConfig?.worker?.entry || null;
  const decision = await detectPublishTarget(targetPath, { requestedFallback, workerEntry });
  const envelope = preflightEnvelope({
    mode: 'detect',
    target: { source, kind: 'directory', requestedFallback, workerEntry },
    decision,
    checks: { localDetectionPassed: true, packageChecked: false, canPackage: null, remoteChecked: false, canDeploy: null, canDeployScope: 'none' },
    sideEffects: { willDeploy: false },
  });
  if (parsed.flags.json) {
    context.output(JSON.stringify(envelope));
    return 0;
  }
  outputHumanDetection(context.output, source, decision);
  return 0;
}
```

- [ ] **Step 5: Implement dry-run branch before credential resolution**

In `runDeploy()`, move credential/client creation below preflight. Resolve `source`, `site`, `fallback`, and `workerEntry` first. Before `resolveCredential()`:

```js
const decision = await detectPublishTarget(targetPath, { requestedFallback, workerEntry });
const uploadPlan = await createUploadPlan(targetPath, decision);
if (parsed.flags.dryRun) {
  const envelope = preflightEnvelope({
    mode: 'dry-run',
    site: siteSlug,
    target: { source: dirInput, kind: 'directory', requestedFallback, workerEntry },
    decision,
    uploadPlan,
    checks: { localDetectionPassed: true, packageChecked: true, canPackage: true, remoteChecked: false, canDeploy: null, canDeployScope: 'local' },
    sideEffects: { willDeploy: false, siteCreated: false, deploymentCreated: false, filesUploaded: false, routeChanged: false },
  });
  if (parsed.flags.json) context.output(JSON.stringify(envelope));
  else outputHumanDryRun(context.output, dirInput, siteSlug, decision, uploadPlan);
  return 0;
}
```

Keep the actual deployment request on the legacy wire protocol in this task. Use `decision` only for JSON output and progress. The API wire migration happens in Task 4.

- [ ] **Step 6: Update human help text**

In deploy help output, remove `--artifact-kind` and add:

```text
  --fallback <auto|index|not-found>  设置找不到文件时的行为
  --worker-entry <file>              指定目录内的 Worker 入口
  --dry-run                          只做本地预演，不创建站点、不上传文件
```

Ensure tests assert help does not mention `artifactKind`, `--artifact-kind`, WFP, slot, or dispatch namespace. It may mention `worker.entry` and `--worker-entry` because those are part of the new user model.

- [ ] **Step 7: Run CLI tests**

Run:

```bash
node --test apps/pages-cli/src/artifact.test.js apps/pages-cli/src/command-config.test.js apps/pages-cli/src/commands.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add apps/pages-cli/src/commands.js apps/pages-cli/src/commands.test.js
git commit -m "feat(cli): 增加 detect 和 dry-run 预演"
```

## Task 4: API PublishPlan Protocol And Validation

**Files:**
- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: Add failing API protocol tests**

Add tests to `apps/pages-api/src/deployments.test.js`:

```js
test('accepts v2 publishPlan multipart metadata and stores resolved decision', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push(input.decision);
        return { artifactRef: `assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          { path: '/index.html', partName: 'asset-file-0', hash: 'hash_index', size: 5, contentType: 'text/html; charset=utf-8' },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_ok' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads[0], {
    deploymentShape: 'assets-only',
    requestedFallback: 'auto',
    resolvedFallback: 'index',
    routingMode: 'assets-only',
  });
});

test('rejects v2 publishPlan with duplicate part names or undeclared uploads', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          { path: '/index.html', partName: 'asset-file-0', hash: 'hash_index', size: 5, contentType: 'text/html; charset=utf-8' },
          { path: '/app.js', partName: 'asset-file-0', hash: 'hash_app', size: 5, contentType: 'text/javascript' },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_duplicate' }
    ),
    env
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'PUBLISH_PLAN_INVALID');
});

test('rejects explicit fallback for worker-only publishPlan', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'index',
        publishPlan: {
          deploymentShape: 'worker-only',
          requestedFallback: 'index',
          resolvedFallback: null,
          routingMode: 'worker-only',
          workerEntry: 'worker.mjs',
          workerMainModuleName: 'worker.mjs',
        },
        workerModules: [{ moduleName: 'worker.mjs', partName: 'worker-main', hash: 'hash_worker', size: 18, contentType: 'application/javascript+module' }],
        worker: { field: 'worker-main', filename: 'worker.mjs', content: 'export default {};', type: 'application/javascript+module' },
      },
      { 'Idempotency-Key': 'fallback_worker_only' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FALLBACK_REQUIRES_ASSETS');
});
```

Add a helper `publishPlanMultipartRequest()` next to existing multipart test helpers. It should set one `metadata` JSON part and Blob parts named by `partName`.

- [ ] **Step 2: Run deployment tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js
```

Expected: FAIL because v2 metadata is not parsed or validated.

- [ ] **Step 3: Implement v2 multipart parser**

In `apps/pages-api/src/deployments.js`, update multipart parsing to recognize a `metadata` JSON field:

```js
async function readMultipartDeploymentBody(request) {
  const form = await request.formData();
  if (form.has('metadata')) return readPublishPlanMultipartBody(form);
  return readLegacyMultipartDeploymentBody(form);
}
```

Implement `readPublishPlanMultipartBody(form)` with:

```js
function readPublishPlanMultipartBody(form) {
  const metadata = parseSingleMetadata(form);
  if (metadata.schemaVersion !== 1) throw codedError('PUBLISH_PLAN_VERSION_UNSUPPORTED');
  const partMap = collectDeclaredParts(metadata);
  const uploaded = collectUploadedParts(form);
  validatePartMaps(partMap, uploaded);
  const decision = normalizePublishPlanDecision(metadata.publishPlan, metadata.requestedFallback, partMap);
  return {
    siteId: metadata.siteId,
    siteSlug: metadata.siteSlug,
    source: 'cli',
    contentHash: metadata.contentHash || 'sha256:client-hint',
    decision,
    publishPlan: metadata.publishPlan,
    assetManifest: assetManifestObjectForProvider(metadata.assetManifest || []),
    assetFiles: assetFilesForProvider(metadata.assetManifest || [], uploaded),
    artifactBundle: artifactBundleForProvider(metadata, uploaded),
  };
}
```

Return stable errors:

- `PUBLISH_PLAN_INVALID`
- `PUBLISH_PLAN_VERSION_UNSUPPORTED`
- `FALLBACK_REQUIRES_ASSETS`
- `ASSET_MANIFEST_INVALID`
- `ASSET_FILES_REQUIRED`

- [ ] **Step 4: Keep legacy deploy path isolated until CLI switches**

Do not let legacy `artifactKind` appear in new docs, OpenAPI, skill, or CLI help. If this task keeps the old request branch temporarily so the current CLI tests still pass, mark it as implementation scaffolding and remove the public path when Task 6 switches CLI deploy to `publishPlan`. Do not add compatibility promises around it.

- [ ] **Step 5: Run API deployment tests**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js
git commit -m "feat(api): 校验 publishPlan 部署协议"
```

## Task 5: Storage And Provider Resolved Metadata

**Files:**
- Modify: `apps/pages-api/src/schema.js`
- Add: `apps/pages-api/migrations/0004_pages_v2_resolved_deployment_metadata.sql`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/store.test.js`
- Modify: `apps/pages-api/src/execution-provider.js`
- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: Add failing storage tests**

In `apps/pages-api/src/store.test.js`, add:

```js
test('site versions persist resolved deployment metadata', async () => {
  const store = await createTestPagesStore();
  await seedUserAndSite(store);
  await store.createDeploymentForIdempotency({
    id: 'dep_meta',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_meta',
    requestHash: 'hash_meta',
    visibility: 'org',
    status: 'pending',
  });

  await store.createSiteVersion({
    id: 'ver_meta',
    siteId: 'site_1',
    deploymentId: 'dep_meta',
    workerName: 'pages-v2-docs-ver-meta',
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    dispatchBindingName: 'PAGES_SLOT_001',
    slotId: 'slot_001',
    artifactKind: 'spa',
    artifactRef: 'slot://production/slot_001/pages-v2-docs-ver-meta/ver_meta',
    contentHash: 'sha256:abc',
    deploymentShape: 'assets-only',
    requestedFallback: 'auto',
    resolvedFallback: 'index',
    routingMode: 'assets-only',
    workerEntry: null,
    assetsConfigJson: { not_found_handling: 'single-page-application' },
    createdBy: 'usr_1',
  });

  const version = await store.getSiteVersion('ver_meta');
  assert.equal(version.deploymentShape, 'assets-only');
  assert.equal(version.requestedFallback, 'auto');
  assert.equal(version.resolvedFallback, 'index');
  assert.equal(version.routingMode, 'assets-only');
  assert.deepEqual(version.assetsConfigJson, { not_found_handling: 'single-page-application' });
});
```

- [ ] **Step 2: Run store tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/store.test.js
```

Expected: FAIL because fields do not exist.

- [ ] **Step 3: Add migration and schema fields**

Create `apps/pages-api/migrations/0004_pages_v2_resolved_deployment_metadata.sql`:

```sql
ALTER TABLE site_versions ADD COLUMN deployment_shape TEXT;
ALTER TABLE site_versions ADD COLUMN requested_fallback TEXT;
ALTER TABLE site_versions ADD COLUMN resolved_fallback TEXT;
ALTER TABLE site_versions ADD COLUMN routing_mode TEXT;
ALTER TABLE site_versions ADD COLUMN worker_entry TEXT;
ALTER TABLE site_versions ADD COLUMN assets_config_json TEXT;
ALTER TABLE site_versions ADD COLUMN worker_modules_json TEXT;
ALTER TABLE site_versions ADD COLUMN asset_manifest_json TEXT;
ALTER TABLE site_versions ADD COLUMN canonical_content_hash TEXT;
ALTER TABLE site_versions ADD COLUMN artifact_availability TEXT DEFAULT 'active';

ALTER TABLE deployments ADD COLUMN decision_json TEXT;
ALTER TABLE deployments ADD COLUMN diagnostics_json TEXT;
ALTER TABLE deployments ADD COLUMN previous_version_id TEXT;
ALTER TABLE deployments ADD COLUMN provider_error_code TEXT;
ALTER TABLE deployments ADD COLUMN terminal_response_json TEXT;
```

Update `apps/pages-api/src/schema.js` initial schema with the same columns so test stores match migrations.

- [ ] **Step 4: Update store mapping**

In `apps/pages-api/src/store.js`, map camelCase fields to columns in `createSiteVersion()` and `getSiteVersion()`:

```js
deploymentShape: row.deployment_shape || null,
requestedFallback: row.requested_fallback || null,
resolvedFallback: row.resolved_fallback || null,
routingMode: row.routing_mode || null,
workerEntry: row.worker_entry || null,
assetsConfigJson: parseJsonColumn(row.assets_config_json),
workerModulesJson: parseJsonColumn(row.worker_modules_json),
assetManifestJson: parseJsonColumn(row.asset_manifest_json),
canonicalContentHash: row.canonical_content_hash || row.content_hash,
artifactAvailability: row.artifact_availability || 'active',
```

- [ ] **Step 5: Update provider mapping**

In `apps/pages-api/src/execution-provider.js`, add decision-aware assets config:

```js
function assetConfigForDecision(decision) {
  return {
    not_found_handling: decision?.resolvedFallback === 'index' ? 'single-page-application' : '404-page',
    ...(decision?.routingMode === 'worker-first' ? { run_worker_first: true } : {}),
  };
}
```

Replace `assetConfigForKind(artifactKind)` with `assetConfigForDecision(input.decision)` when a decision is present. Keep legacy fallback for old `artifactKind`.

- [ ] **Step 6: Run API tests**

Run:

```bash
node --test apps/pages-api/src/store.test.js apps/pages-api/src/deployments.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/pages-api/src/schema.js apps/pages-api/migrations/0004_pages_v2_resolved_deployment_metadata.sql apps/pages-api/src/store.js apps/pages-api/src/store.test.js apps/pages-api/src/execution-provider.js apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js
git commit -m "feat(api): 存储 resolved 发布元数据"
```

## Task 6: Switch CLI Deploy To PublishPlan Protocol

**Files:**
- Modify: `apps/pages-cli/src/commands.js`
- Modify: `apps/pages-cli/src/commands.test.js`
- Modify: `apps/pages-cli/src/api-client.js` if request helper needs Blob filename support changes.

- [ ] **Step 1: Update deploy tests for new multipart metadata**

Change the first deploy test in `apps/pages-cli/src/commands.test.js` so the deployment form assertions read:

```js
const deployForm = await calls[1].formData();
const metadata = JSON.parse(await deployForm.get('metadata').text());
assert.equal(metadata.schemaVersion, 1);
assert.equal(metadata.siteSlug, 'docs');
assert.equal(metadata.publishPlan.deploymentShape, 'assets-only');
assert.equal(metadata.publishPlan.requestedFallback, 'auto');
assert.equal(metadata.publishPlan.resolvedFallback, 'index');
assert.equal(metadata.publishPlan.routingMode, 'assets-only');
assert.deepEqual(metadata.assetManifest.map((asset) => asset.path), ['/index.html']);
assert.equal(deployForm.has('artifactKind'), false);
assert.equal(await deployForm.get(metadata.assetManifest[0].partName).text(), '<h1>Hello</h1>');
```

Update JSON output expectations to assert:

```js
assert.equal(body.decision.deploymentShape, 'assets-only');
assert.equal(body.decision.resolvedFallback, 'index');
assert.equal(body.diagnostics.errors.length, 0);
assert.equal('artifactKind' in body, false);
```

- [ ] **Step 2: Run CLI command tests and verify they fail**

Run:

```bash
node --test apps/pages-cli/src/commands.test.js
```

Expected: FAIL because deploy still sends legacy form fields.

- [ ] **Step 3: Build v2 deployment form**

Replace `buildAssetDeploymentForm()` with a publishPlan-aware helper:

```js
async function buildPublishPlanDeploymentForm({ siteSlug, uploadPlan }) {
  const form = new FormData();
  const metadata = {
    schemaVersion: 1,
    siteSlug,
    requestedFallback: uploadPlan.publishPlan.requestedFallback,
    source: 'cli',
    contentHash: uploadPlan.contentHash,
    publishPlan: uploadPlan.publishPlan,
    assetManifest: uploadPlan.assetManifest,
    workerMainModuleName: uploadPlan.workerMainModuleName,
    workerModules: uploadPlan.workerModules.map(({ moduleName, partName, hash, size, contentType }) => ({ moduleName, partName, hash, size, contentType })),
    controlSignals: uploadPlan.controlSignals,
  };
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const file of uploadPlan.assetFiles) {
    form.set(file.partName, new Blob([file.bytes], { type: file.contentType }), file.relativePath);
  }
  for (const module of uploadPlan.workerModules) {
    form.set(module.partName, new Blob([module.content], { type: module.contentType }), module.moduleName);
  }
  return form;
}
```

- [ ] **Step 4: Use authoritative API decision in final JSON**

After API response, prefer `deployed.decision` when present:

```js
const finalDecision = deployed.decision || uploadPlan.publishPlan;
```

Human output should use labels:

```text
识别结果：静态资源目录
找不到文件时：返回 /index.html
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
node --test apps/pages-cli/src/artifact.test.js apps/pages-cli/src/commands.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add apps/pages-cli/src/commands.js apps/pages-cli/src/commands.test.js apps/pages-cli/src/api-client.js
git commit -m "feat(cli): 使用 publishPlan 部署协议"
```

## Task 7: Public Docs, Skill, OpenAPI, And Final Verification

**Files:**
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `apps/pages-skill/skill/SKILL.md`
- Modify: `apps/pages-skill/skill/references/cli.md`
- Modify: `README.md` if present
- Modify: `API.md` if present
- Modify: `docs/adr/0001-pages-v2-artifact-detection.md` only if implementation discovers a design correction.

- [ ] **Step 1: Add OpenAPI tests**

In `apps/pages-api/src/openapi.test.js`, assert:

```js
assert.equal(JSON.stringify(spec).includes('artifactKind'), false);
assert.equal(JSON.stringify(spec).includes('publishPlan'), false);
assert.match(JSON.stringify(spec), /resolvedFallback/);
assert.match(JSON.stringify(spec), /deploymentShape/);
```

The response schema may expose resolved `decision`; request examples must not teach users to send `artifactKind`, `deploymentShape`, or `publishPlan`.

- [ ] **Step 2: Update public docs**

Update user-facing docs to show:

```bash
pages detect ./dist --json
pages deploy ./dist example-site --dry-run --json
pages deploy ./dist example-site
pages deploy ./dist example-site --fallback index
pages deploy ./dist example-site --worker-entry worker.mjs
```

Document config:

```json
{
  "site": "example-site",
  "source": "./dist",
  "fallback": "auto",
  "worker": {
    "entry": "./worker.mjs"
  }
}
```

Do not include `artifactKind` in README, API docs, OpenAPI request schema, skill, or CLI reference.

- [ ] **Step 3: Run targeted tests**

Run:

```bash
node --test apps/pages-cli/src/artifact.test.js apps/pages-cli/src/command-config.test.js apps/pages-cli/src/commands.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/store.test.js apps/pages-api/src/openapi.test.js apps/pages-skill/src/build.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm lint
pnpm test
```

Expected: both commands exit 0.

- [ ] **Step 5: Final artifactKind scan**

Run:

```bash
rg -n "artifactKind|--artifact-kind|static/spa/worker|static\\|spa\\|worker" README.md API.md apps/pages-skill apps/pages-api/src/openapi.js apps/pages-cli/src/commands.js
```

Expected: no user-facing matches. Mentions of `worker.entry`, `worker-with-assets`, or `--worker-entry` are allowed because they are part of the target model. Implementation-internal or migration-test `artifactKind` matches must be removed before public docs are updated.

- [ ] **Step 6: Commit Task 7**

```bash
git add apps/pages-api/src/openapi.js apps/pages-api/src/openapi.test.js apps/pages-skill README.md API.md docs/adr/0001-pages-v2-artifact-detection.md
git commit -m "docs: 更新发布产物自动识别说明"
```

## Self-Review Checklist

- [x] Task 1 covers detector rules from ADR: `_worker.js`, ordinary `worker.js`, `index` vs `not-found`, denylist, symlink, control files.
- [x] Task 2 covers config model and removes `artifactKind` from user intent.
- [x] Task 3 covers `detect`, `dry-run`, JSON envelope, human output, and no network side effects.
- [x] Task 4 covers API authority boundary and v2 multipart validation.
- [x] Task 5 covers storage/provider semantics, `run_worker_first`, rollback metadata, and audit fields.
- [x] Task 6 switches CLI real deploy to the v2 protocol.
- [x] Task 7 updates public docs only after behavior exists.
- [x] No task asks users or AI to choose `artifactKind`.
- [x] Each task has a runnable test command and expected result.
