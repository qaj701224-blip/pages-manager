import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildPagesSkill } from './build.js';

test('buildPagesSkill assembles xd-pages skill with bundled CLI and SDK outputs', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'pages-skill-build-'));
  const cliDistDir = mkdtempSync(path.join(tmpdir(), 'pages-cli-dist-'));
  const sdkPackageDir = mkdtempSync(path.join(tmpdir(), 'pages-sdk-package-'));
  try {
    await writeFixturePackage({ cliDistDir, sdkPackageDir });

    await buildPagesSkill({
      outDir,
      runDependencyBuilds: async () => {},
      cliDistDir,
      sdkPackageDir,
    });

    const skill = await readFile(path.join(outDir, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: xd-pages/m);
    assert.match(skill, new RegExp(`^version: ${await readPackageVersion()}$`, 'm'));
    assert.match(skill, /tools\/pages-cli\/main\.js/);
    assert.match(skill, /始终使用本 skill 内置 CLI 和内置文档/);
    assert.match(skill, /每个会话首次使用本 skill 时，先读取 `references\/update\.md`/);

    await access(path.join(outDir, 'references', 'cli.md'));
    await access(path.join(outDir, 'references', 'sdk.md'));
    await access(path.join(outDir, 'references', 'update.md'));
    await assert.rejects(() => access(path.join(outDir, 'references', 'security.md')), { code: 'ENOENT' });
    await access(path.join(outDir, 'tools', 'pages-cli', 'main.js'));
    await access(path.join(outDir, 'tools', 'pages-sdk', 'dist', 'browser.js'));
    await access(path.join(outDir, 'tools', 'pages-sdk', 'package.json'));

    const cliManifest = JSON.parse(await readFile(path.join(outDir, 'tools', 'pages-cli', 'package.json'), 'utf8'));
    assert.equal(cliManifest.bin.pages, './main.js');

    const sdkManifest = JSON.parse(await readFile(path.join(outDir, 'tools', 'pages-sdk', 'package.json'), 'utf8'));
    assert.equal(sdkManifest.name, '@xd/pages-sdk');
    assert.ok(!JSON.stringify(sdkManifest).includes('scripts'));

    const docs = await readSkillDocs(outDir);
    assert.match(docs, /除非用户明确要求使用 staging，否则发布时不要传 `--env`/);
    assert.doesNotMatch(docs, /--env staging --access-key|--env staging --json|deploy .*--env staging|目标环境；默认 production/);
    assert.match(docs, /node tools\/pages-cli\/main\.js help deploy/);
    assert.match(docs, /tools\/pages-cli\/main\.js help deploy/);
    assert.match(docs, /不要把 access key 写入本地状态/);
    assert.match(docs, /tools\/pages-sdk\/README\.md/);
    assert.match(docs, /tools\/pages-sdk\/package\.json/);
    assert.match(docs, /npm i -g @xd-skill\/cli/);
    assert.match(docs, /不要引导用户把内置 CLI 全局安装/);
    assert.match(docs, /不要优先使用环境里的 `pages`/);
    assert.match(docs, /不要优先使用用户项目里的 SDK 文档/);
    assert.doesNotMatch(docs, /xd-skill publish|publish --help|发布能力|发布用法/);
    assert.doesNotMatch(docs, /优先使用当前环境里的 `pages`|优先 `pages`|确认适用后优先使用仓库版本|确认版本适用后使用项目版本/);
    assert.doesNotMatch(docs, /npm i -g @xd\/pages-cli|pnpm add -g @xd\/pages-cli/);
    assert.doesNotMatch(docs, /deploy \.\/dist|status demo|access get demo|rollback demo|open demo/);
    assert.doesNotMatch(
      docs,
      /import \{ createPagesClient \}|import \{ createPagesRuntime|import \{ handlePagesRuntimeRequest|function checkAccess/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(cliDistDir, { recursive: true, force: true });
    await rm(sdkPackageDir, { recursive: true, force: true });
  }
});

test('source skill metadata uses package version placeholder', async () => {
  const sourceSkill = await readFile(new URL('../skill/SKILL.md', import.meta.url), 'utf8');
  assert.match(sourceSkill, /^version: __XD_PAGES_SKILL_VERSION__$/m);
  assert.doesNotMatch(sourceSkill, /^version: 0\.1\.0$/m);
});

async function readSkillDocs(outDir) {
  const files = [
    'SKILL.md',
    path.join('references', 'cli.md'),
    path.join('references', 'sdk.md'),
    path.join('references', 'update.md'),
  ];
  const contents = await Promise.all(files.map((file) => readFile(path.join(outDir, file), 'utf8')));
  return contents.join('\n');
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return packageJson.version;
}

async function writeFixturePackage({ cliDistDir, sdkPackageDir }) {
  await writeFile(
    path.join(cliDistDir, 'main.js'),
    "#!/usr/bin/env node\nconsole.log('pages fixture');\n"
  );
  await writeFile(
    path.join(cliDistDir, 'package.json'),
    JSON.stringify(
      {
        name: '@xd/pages-cli',
        version: '0.1.0',
        type: 'module',
        bin: { pages: './main.js' },
      },
      null,
      2
    )
  );

  await mkdir(path.join(sdkPackageDir, 'dist'), { recursive: true });
  await writeFile(
    path.join(sdkPackageDir, 'package.json'),
    JSON.stringify(
      {
        name: '@xd/pages-sdk',
        version: '0.1.0',
        type: 'module',
        scripts: { build: 'tsc -p tsconfig.json' },
        exports: {
          './browser': {
            types: './dist/browser.d.ts',
            import: './dist/browser.js',
          },
        },
      },
      null,
      2
    )
  );
  await writeFile(path.join(sdkPackageDir, 'README.md'), '# Fixture SDK\n');
  await writeFile(path.join(sdkPackageDir, 'dist', 'browser.js'), 'export function createPagesClient() { return {}; }\n');
  await writeFile(path.join(sdkPackageDir, 'dist', 'browser.d.ts'), 'export declare function createPagesClient(): object;\n');
}
