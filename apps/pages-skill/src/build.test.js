import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCellSkill } from './build.js';

test('buildCellSkill assembles xd-cell skill with bundled CLI and SDK dependency guidance', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'cell-skill-build-'));
  const cliDistDir = mkdtempSync(path.join(tmpdir(), 'cell-cli-dist-'));
  const workerSdkPackageDir = mkdtempSync(path.join(tmpdir(), 'worker-sdk-package-'));
  const legacyOutDir = path.join(path.dirname(outDir), 'xd-pages');
  try {
    await writeFixturePackage({ cliDistDir, workerSdkPackageDir });
    await mkdir(legacyOutDir, { recursive: true });
    await writeFile(path.join(legacyOutDir, 'SKILL.md'), 'name: xd-pages\n');

    await buildCellSkill({
      outDir,
      runDependencyBuilds: async () => {},
      cliDistDir,
      legacyOutDir,
      workerSdkPackageDir,
    });

    const skill = await readFile(path.join(outDir, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: xd-cell/m);
    assert.match(skill, new RegExp(`^version: ${await readPackageVersion()}$`, 'm'));
    assert.match(skill, /^description: 当用户制作网站、内部工具、SPA 或自定义 Worker/m);
    assert.doesNotMatch(skill, /^description: 围绕 .*内置.*外部 Worker SDK/m);
    assert.match(skill, /tools\/xd-cell-cli\/main\.js/);
    assert.match(skill, /始终使用本 skill 内置 CLI 和内置文档/);
    assert.match(skill, /每个会话首次使用本 skill 时，先读取 `references\/update\.md`/);
    assert.match(skill, /# XD Cell/);
    assert.match(skill, /## 制作网站时可以获得什么/);
    assert.match(skill, /不必等到用户明确提出部署/);
    assert.match(skill, /发布静态站点、SPA 和自定义 Worker/);
    assert.match(skill, /查看站点、部署和当前身份/);
    assert.match(skill, /管理团队、访问范围和 Worker secret/);
    assert.match(skill, /## 何时使用自定义 Worker/);
    assert.match(skill, /## 自定义 Worker 可获得的平台能力/);
    assert.match(skill, /只有 status 为 `501` 且响应中的 `error\.code` 为 `OFFICE_NET_UNAVAILABLE`/);
    assert.doesNotMatch(skill, /## Worker SDK 触发条件/);

    await access(path.join(outDir, 'references', 'cli.md'));
    await access(path.join(outDir, 'references', 'sdk.md'));
    await access(path.join(outDir, 'references', 'update.md'));
    await access(path.join(outDir, 'BREAKING_CHANGES.md'));
    await access(path.join(outDir, 'manifest.json'));
    await assert.rejects(() => access(path.join(outDir, 'references', 'llms', 'worker-sdk.md')), { code: 'ENOENT' });
    await assert.rejects(() => access(path.join(outDir, 'references', 'security.md')), { code: 'ENOENT' });
    await access(path.join(outDir, 'tools', 'xd-cell-cli', 'main.js'));
    await assert.rejects(() => access(path.join(outDir, 'tools', 'worker-sdk')), { code: 'ENOENT' });
    await assert.rejects(() => access(legacyOutDir), { code: 'ENOENT' });

    const cliManifest = JSON.parse(await readFile(path.join(outDir, 'tools', 'xd-cell-cli', 'package.json'), 'utf8'));
    assert.equal(cliManifest.name, '@xd-cell/cli');
    assert.equal(cliManifest.bin['xd-cell'], './main.js');

    const releaseManifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
    assert.equal(releaseManifest.product.name, 'XD Cell');
    assert.equal(releaseManifest.product.siteDomainSuffix, 'workers.xd.team');
    assert.equal(releaseManifest.skill.packageName, '@xd-cell/skill');
    assert.equal(releaseManifest.skill.version, await readPackageVersion());
    assert.deepEqual(releaseManifest.dependencies.cli, {
      packageName: '@xd-cell/cli',
      version: '0.1.0',
      bundled: true,
      path: 'tools/xd-cell-cli/main.js',
      packageJsonPath: 'tools/xd-cell-cli/package.json',
    });
    assert.deepEqual(releaseManifest.dependencies.workerSdk, {
      packageName: '@xd-cell/worker-sdk',
      recommendedVersion: '0.3.4',
      installCommand: 'pnpm add @xd-cell/worker-sdk@0.3.4',
      packagePath: 'node_modules/@xd-cell/worker-sdk',
      docsPath: 'docs/llms/worker-sdk.md',
      apiDocsPath: 'docs/llms/worker-sdk-api.md',
      breakingChangesPath: 'BREAKING_CHANGES.md',
    });

    const breakingChanges = await readFile(path.join(outDir, 'BREAKING_CHANGES.md'), 'utf8');
    assert.match(breakingChanges, /无破坏性变更/);
    assert.match(breakingChanges, /类型级破坏性变更.*@xd-cell\/worker-sdk/);
    assert.match(breakingChanges, /先发布并验证 `@xd-cell\/worker-sdk@0\.2\.0`/);
    assert.match(breakingChanges, /再构建并发布 `@xd-cell\/skill@0\.1\.1`/);
    assert.match(breakingChanges, /@xd-cell\/skill/);
    assert.doesNotMatch(breakingChanges, /存在破坏性变更/);

    const docs = await readSkillDocs(outDir);
    assert.match(docs, /不主动切换目标环境/);
    assert.doesNotMatch(docs, /--env|xd-cell env|目标环境；默认 production/);
    assert.match(docs, /node tools\/xd-cell-cli\/main\.js help deploy/);
    assert.match(docs, /tools\/xd-cell-cli\/main\.js help deploy/);
    assert.match(docs, /不要把 API token 写入本地状态/);
    assert.doesNotMatch(docs, /--access-key/);
    assert.match(docs, /@xd-cell\/cli/);
    assert.match(docs, /@xd-cell\/worker-sdk/);
    assert.match(docs, /pnpm add @xd-cell\/worker-sdk/);
    assert.match(docs, /Worker SDK 的 AI 文档随 `@xd-cell\/worker-sdk` 包发布/);
    assert.match(docs, /安装 Worker SDK 后可使用的能力/);
    assert.match(docs, /自定义 Worker/);
    assert.match(docs, /runtime\.kv/);
    assert.match(docs, /readContext/);
    assert.match(docs, /getCurrentUser/);
    assert.match(docs, /runtime\.officeNet\.fetch/);
    assert.match(docs, /办公网/);
    assert.match(docs, /完整部门路径/);
    assert.match(docs, /response\.ok/);
    assert.match(docs, /501/);
    assert.match(docs, /error\.code/);
    assert.match(docs, /OFFICE_NET_UNAVAILABLE/);
    assert.doesNotMatch(docs, /XD_OFFICE_NET/);
    assert.match(docs, /何时不需要自定义 Worker 或 Worker SDK/);
    assert.match(docs, /只是发布静态站点/);
    assert.match(docs, /D1\/R2/);
    assert.match(docs, /业务项目运行时依赖/);
    assert.match(docs, /pnpm add @xd-cell\/worker-sdk/);
    assert.match(docs, /node_modules\/@xd-cell\/worker-sdk/);
    assert.match(docs, /不要因为普通发布任务安装 Worker SDK/);
    assert.match(docs, /Worker SDK 不是管理面 SDK/);
    assert.match(docs, /只使用公开 exports/);
    assert.match(docs, /包名边界/);
    assert.match(docs, /历史草案或旧文档路径/);
    assert.match(docs, /不要为这些路径补兼容/);
    assert.doesNotMatch(docs, /旧包边界/);
    assert.match(docs, /不要绕过 Worker SDK 直连 gateway/);
    assert.match(docs, /不要把 `readContext` 的用户信息当作授权结论/);
    assert.match(docs, /不要把 departments、employeeStatus 或 accountId 当作平台授权结论/);
    assert.match(docs, /不要创建通用代理/);
    assert.match(docs, /底层资源能力通过平台注入/);
    assert.match(docs, /@xd-cell\/skill/);
    assert.match(docs, /manifest\.json/);
    assert.match(docs, /npm i -g @xd-skill\/cli/);
    assert.match(docs, /不要引导用户把内置 CLI 全局安装/);
    assert.match(docs, /不要优先使用环境里的 `xd-cell`/);
    assert.match(docs, /[sS]kill 不复制 Worker SDK 领域产物/);
    assert.match(docs, /不内置 `tools\/worker-sdk`/);
    assert.match(docs, /不要从 skill 构建产物中寻找 `tools\/worker-sdk`/);
    assert.doesNotMatch(docs, /生成或复制本地 helper/);
    assert.doesNotMatch(docs, /xd-skill publish|publish --help|发布能力|发布用法/);
    assert.doesNotMatch(docs, /优先使用当前环境里的 `xd-cell`|优先 `xd-cell`|确认适用后优先使用仓库版本|确认版本适用后使用项目版本/);
    assert.doesNotMatch(
      docs,
      /npm i -g @xd\/pages-cli|pnpm add -g @xd\/pages-cli|npm i -g @xd-cell\/cli|pnpm add -g @xd-cell\/cli/
    );
    assert.doesNotMatch(docs, /npm install -g @xd-cell\/worker-sdk|全局安装只用于 agent 读取文档和类型/);
    assert.doesNotMatch(docs, /xd-pages skill|`xd-pages` skill/);
    assert.doesNotMatch(docs, /XD Pages/);
    assert.doesNotMatch(docs, /deploy \.\/dist|status demo|access get demo|rollback demo|open demo/);
    assert.doesNotMatch(docs, /按需接入内置 `@xd\/pages-sdk`|修改导入 `@xd\/pages-sdk` 的应用代码前/);
    assert.doesNotMatch(docs, /以 `package\.json\.exports` 和 README 为准/);
    assert.doesNotMatch(
      docs,
      /import \{ createPagesClient \}|import \{ createPagesRuntime|import \{ handlePagesRuntimeRequest|function checkAccess/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(cliDistDir, { recursive: true, force: true });
    await rm(workerSdkPackageDir, { recursive: true, force: true });
    await rm(legacyOutDir, { recursive: true, force: true });
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
  assert.equal(packageJson.name, '@xd-cell/skill');
  assert.equal(packageJson.private, false);
  assert.deepEqual(packageJson.files, ['dist/xd-cell', 'BREAKING_CHANGES.md']);
  assert.equal(packageJson.exports, undefined);
  return packageJson.version;
}

async function writeFixturePackage({ cliDistDir, workerSdkPackageDir }) {
  await writeFile(
    path.join(cliDistDir, 'main.js'),
    "#!/usr/bin/env node\nconsole.log('pages fixture');\n"
  );
  await writeFile(
    path.join(cliDistDir, 'package.json'),
    JSON.stringify(
      {
        name: '@xd-cell/cli',
        version: '0.1.0',
        type: 'module',
        bin: { 'xd-cell': './main.js' },
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(workerSdkPackageDir, 'package.json'),
    JSON.stringify(
      {
        name: '@xd-cell/worker-sdk',
        version: '0.3.4',
        type: 'module',
      },
      null,
      2
    )
  );
}
