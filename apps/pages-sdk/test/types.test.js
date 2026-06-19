import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('published adapter subpath is importable at runtime', async () => {
  const adapter = await import('@xd/pages-sdk/adapter');

  assert.equal(typeof adapter.handlePagesRuntimeRequest, 'function');
});

test('published subpaths expose TypeScript declarations', () => {
  const dir = mkdtempSync(join(process.cwd(), 'apps/pages-sdk/test/.tmp-types-'));
  const file = join(dir, 'smoke.ts');
  writeFileSync(
    file,
    `
import { createPagesClient, type KVType } from '@xd/pages-sdk/browser';
import {
  createPagesRuntime,
  readPlatformContext,
  type PagesPlatformContext,
  type PagesRuntimeEnv,
} from '@xd/pages-sdk/worker';
import { handlePagesRuntimeRequest } from '@xd/pages-sdk/adapter';
import { PAGES_RUNTIME_SOURCE } from '@xd/pages-sdk/internal/runtime-source';

const kvType: KVType = 'json';
const client = createPagesClient();
const defaultValue: Promise<unknown | null> = client.data.site.get('app/config');
const jsonValue: Promise<{ theme: string } | null> = client.data.site.get<{ theme: string }>('app/config', { type: kvType });
const textValue: Promise<string | null> = client.data.user.get('app/text', { type: 'text' });
const browserSetValue: Promise<void> = client.data.user.set('app/config', { theme: 'dark' });
const legacyBrowserValue: Promise<unknown | null> = client.kv.get('app/config');

const env: PagesRuntimeEnv = {
  XD_PAGES_KV_CAPABILITY: 'capability-token',
  XD_PAGES_KV_GATEWAY: { fetch: async () => Response.json({ ok: true }) },
};
const runtime = createPagesRuntime({ env });
const context: PagesPlatformContext | null = readPlatformContext(new Request('https://site.example/app'));
const runtimeJsonValue: Promise<{ enabled: boolean } | null> = runtime.data.site.get<{ enabled: boolean }>('app/config');
const runtimeTextValue: Promise<string | null> = runtime.data.user.get('app/text', { type: 'text' });
const runtimeSetValue: Promise<void> = runtime.data.site.set('app/config', { enabled: true });
const legacyRuntimeValue: Promise<unknown | null> = runtime.kv.get('app/config');
const maybeResponse: Promise<Response | null> = handlePagesRuntimeRequest(new Request('https://site.example/app'), env);
const runtimeSource: string = PAGES_RUNTIME_SOURCE;

void defaultValue;
void jsonValue;
void textValue;
void browserSetValue;
void legacyBrowserValue;
void runtimeJsonValue;
void runtimeTextValue;
void runtimeSetValue;
void legacyRuntimeValue;
void maybeResponse;
void runtimeSource;
void context;
`,
    'utf8'
  );

  try {
    execFileSync(
      'pnpm',
      [
        '--filter',
        '@xd/pages-sdk',
        'exec',
        'tsc',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--strict',
        '--noEmit',
        file,
      ],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
