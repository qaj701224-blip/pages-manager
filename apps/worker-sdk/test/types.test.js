import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('worker-sdk package exposes a root Worker runtime entry only', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/worker-sdk/package.json'), 'utf8'));

  assert.equal(packageJson.name, '@xd-cell/worker-sdk');
  assert.deepEqual(Object.keys(packageJson.exports), ['.']);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/src/browser.ts')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/src/adapter.ts')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/src/inline.ts')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/src/internal/runtime-source.ts')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/src/worker.ts')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/dist/browser.js')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/dist/adapter.js')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/dist/inline.js')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/dist/internal/runtime-source.js')), false);
  assert.equal(existsSync(join(process.cwd(), 'apps/worker-sdk/dist/worker.js')), false);
});

test('worker-sdk package builds generated artifacts before pack and publish', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/worker-sdk/package.json'), 'utf8'));
  const generateLlms = readFileSync(join(process.cwd(), 'apps/worker-sdk/scripts/generate-llms.js'), 'utf8');

  assert.equal(packageJson.scripts.clean, 'node -e "require(\'node:fs\').rmSync(\'dist\',{recursive:true,force:true})"');
  assert.equal(packageJson.scripts.build, 'pnpm run clean && tsc -p tsconfig.json');
  assert.equal(packageJson.scripts['docs:llms'], 'node scripts/generate-llms.js');
  assert.equal(packageJson.scripts['docs:llms:check'], 'node scripts/generate-llms.js --check');
  assert.equal(packageJson.scripts['pack:prepare'], 'pnpm run build && pnpm run docs:llms');
  assert.equal(packageJson.scripts['pack:surface'], 'node scripts/check-pack-surface.js');
  assert.equal(packageJson.scripts['pack:check'], 'pnpm run build && pnpm run docs:llms:check && pnpm run pack:surface');
  assert.equal(packageJson.scripts.prepack, 'pnpm run pack:prepare');
  assert.equal(packageJson.scripts.prepublishOnly, undefined);
  assert.doesNotMatch(generateLlms, /spawnSync|@xd-cell\/worker-sdk', 'build|function run\(/);
});

test('worker-sdk tsconfig stays constrained to Worker-safe library output', () => {
  const tsconfig = JSON.parse(readFileSync(join(process.cwd(), 'apps/worker-sdk/tsconfig.json'), 'utf8'));
  const options = tsconfig.compilerOptions;

  assert.equal(options.module, 'NodeNext');
  assert.equal(options.moduleResolution, 'NodeNext');
  assert.deepEqual(options.lib, ['ES2022', 'WebWorker']);
  assert.deepEqual(options.types, []);
  assert.equal(options.verbatimModuleSyntax, true);
  assert.equal(options.isolatedModules, true);
  assert.equal(options.noEmitOnError, true);
  assert.equal(options.declarationMap, true);
});

test('worker entry stays focused on Worker runtime helpers', async () => {
  const worker = await import('@xd-cell/worker-sdk');
  const workerEntry = readFileSync(join(process.cwd(), 'apps/worker-sdk/dist/worker/index.js'), 'utf8');

  assert.equal(typeof worker.createRuntime, 'function');
  assert.equal(typeof worker.getCurrentUser, 'function');
  assert.equal(typeof worker.readContext, 'function');
  assert.equal(Object.hasOwn(worker, 'createPagesRuntime'), false);
  assert.equal(Object.hasOwn(worker, 'readPlatformContext'), false);
  assert.equal(Object.hasOwn(worker, 'PagesSDKError'), false);
  assert.equal(Object.hasOwn(worker, 'handlePagesRuntimeRequest'), false);
  assert.doesNotMatch(workerEntry, /adapter-core/);
});

test('worker source keeps index as a public facade over focused modules', () => {
  const workerDir = join(process.cwd(), 'apps/worker-sdk/src/worker');
  const workerIndex = readFileSync(join(workerDir, 'index.ts'), 'utf8');
  const workerModules = new Set(readdirSync(workerDir).filter((entry) => entry.endsWith('.ts')));

  assert.deepEqual([...workerModules].sort(), [
    'capabilities.ts',
    'constants.ts',
    'data-store.ts',
    'gateway.ts',
    'index.ts',
    'office-net.ts',
    'platform-context.ts',
    'runtime.ts',
  ]);
  assert.match(workerIndex, /export \{ createRuntime \} from '\.\/runtime\.js';/);
  assert.match(workerIndex, /export \{ getCurrentUser, readContext \} from '\.\/platform-context\.js';/);
  assert.doesNotMatch(workerIndex, /createPagesRuntime|readPlatformContext|Pages|GATEWAY_ORIGIN|CF-Platform-/);
});

test('published declarations keep platform binding names internal', () => {
  const declarationFiles = [
    'apps/worker-sdk/dist/worker/index.d.ts',
    'apps/worker-sdk/dist/types.d.ts',
  ];
  const declarations = declarationFiles.map((file) => readFileSync(join(process.cwd(), file), 'utf8')).join('\n');

  assert.doesNotMatch(declarations, /XD_PAGES_|XD_CELL_|CF-Platform-|createPagesRuntime|readPlatformContext|Pages/);
});

test('published AI documentation keeps office network binding details internal', () => {
  const workerDoc = readFileSync(join(process.cwd(), 'apps/worker-sdk/docs/llms/worker-sdk.md'), 'utf8');
  const publicDocs = [
    'apps/worker-sdk/README.md',
    'apps/worker-sdk/docs/llms/worker-sdk.md',
    'apps/worker-sdk/docs/llms/worker-sdk-api.md',
  ]
    .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
    .join('\n');

  assert.doesNotMatch(publicDocs, /XD_OFFICE_NET/);
  assert.match(workerDoc, /## 当前用户/);
  assert.match(workerDoc, /## 办公网访问/);
  assert.match(workerDoc, /getCurrentUser/);
  assert.match(workerDoc, /runtime\.officeNet\.fetch/);
  assert.match(workerDoc, /501/);
  assert.match(workerDoc, /response\.ok/);
  assert.match(workerDoc, /response\.status === 501/);
  assert.match(workerDoc, /errorBody\?\.error\?\.code === 'OFFICE_NET_UNAVAILABLE'/);
});

test('breaking changes documents required Runtime and RuntimeContext fields', () => {
  const breakingChanges = readFileSync(join(process.cwd(), 'apps/worker-sdk/BREAKING_CHANGES.md'), 'utf8');

  assert.match(breakingChanges, /存在类型级破坏性变更/);
  assert.match(breakingChanges, /RuntimeContext\.user/);
  assert.match(breakingChanges, /Runtime\.officeNet/);
});

test('published entry exposes TypeScript declarations to NodeNext consumers', () => {
  const dir = mkdtempSync(join(process.cwd(), 'apps/worker-sdk/test/.tmp-types-'));
  const file = join(dir, 'smoke.ts');
  writeFileSync(
    file,
    `
import {
  createRuntime,
  getCurrentUser,
  readContext,
  type EmployeeStatus,
  type KVNamespace,
  type KVGetWithMetadataResult,
  type KVListResult,
  type OfficeNet,
  type Runtime,
  type RuntimeContext,
  type RuntimeEnv,
  type RuntimeUser,
} from '@xd-cell/worker-sdk';

const env: RuntimeEnv = {
  XD_PAGES_KV_CAPABILITY: 'capability-token',
  XD_PAGES_KV_GATEWAY: { fetch: async () => Response.json({ ok: true }) },
};
const runtime = createRuntime({ env });
const typedRuntime: Runtime = runtime;
const kv: KVNamespace = runtime.kv;
const officeNet: OfficeNet = runtime.officeNet;
const context: RuntimeContext | null = readContext(new Request('https://site.example/app'));
const user: RuntimeUser | null = getCurrentUser(new Request('https://site.example/app'));
const employeeStatus: EmployeeStatus = user?.employeeStatus ?? 'unknown';
const userName: string | null = user?.name ?? null;
const officeResponse: Promise<Response> = runtime.officeNet.fetch('https://internal.example.test/health');
const runtimeTextValue: Promise<string | null> = runtime.kv.get('app/text');
const runtimeTextValueWithOption: Promise<string | null> = runtime.kv.get('app/text', { type: 'text' });
const runtimeJsonValue: Promise<{ enabled: boolean } | null> =
  runtime.kv.get<{ enabled: boolean }>('app/config', { type: 'json' });
const runtimePutTextValue: Promise<void> = runtime.kv.put('app/message', 'hello');
const runtimePutJsonValue: Promise<void> =
  runtime.kv.put('app/config', { enabled: true }, { type: 'json', metadata: { owner: 'docs' }, expiration: 1900000000 });
const runtimeMetadataValue: Promise<KVGetWithMetadataResult<{ enabled: boolean }, { owner: string }>> =
  runtime.kv.getWithMetadata<{ enabled: boolean }, { owner: string }>('app/config', { type: 'json' });
const runtimeListValue: Promise<KVListResult<{ owner: string }>> =
  runtime.kv.list<{ owner: string }>({ prefix: 'app/', limit: 10 });

void typedRuntime;
void kv;
void officeNet;
void officeResponse;
void runtimeTextValue;
void runtimeTextValueWithOption;
void runtimeJsonValue;
void runtimePutTextValue;
void runtimePutJsonValue;
void runtimeMetadataValue;
void runtimeListValue;
void context;
void user;
void employeeStatus;
void userName;
`,
    'utf8'
  );

  try {
    runTypeScriptSmoke('pnpm', [
      '--filter',
      '@xd-cell/worker-sdk',
      'exec',
      'tsc',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,WebWorker',
      '--strict',
      '--noEmit',
      file,
    ]);
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('published entry typechecks in Bundler-style Worker consumers', () => {
  const dir = mkdtempSync(join(process.cwd(), 'apps/worker-sdk/test/.tmp-types-'));
  const file = join(dir, 'smoke.ts');
  writeFileSync(
    file,
    `
import {
  createRuntime,
  getCurrentUser,
  readContext,
  type RuntimeEnv,
} from '@xd-cell/worker-sdk';

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const runtime = createRuntime({ request, env });
    const context = readContext(request);
    const user = getCurrentUser(request);
    const config = await runtime.kv.get('app/config');

    return Response.json({ config, userId: context?.userId ?? null, accountId: user?.accountId ?? null });
  },
};
`,
    'utf8'
  );

  try {
    runTypeScriptSmoke('pnpm', [
      '--filter',
      '@xd-cell/worker-sdk',
      'exec',
      'tsc',
      '--module',
      'ES2022',
      '--moduleResolution',
      'Bundler',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,WebWorker',
      '--strict',
      '--noEmit',
      file,
    ]);
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runTypeScriptSmoke(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join('\n')
  );
}
