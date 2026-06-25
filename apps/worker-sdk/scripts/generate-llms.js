import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const workerSdkDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(workerSdkDir, '..', '..');
const docsDir = path.join(workerSdkDir, 'docs', 'llms');

const generatedFiles = [
  path.join(docsDir, 'worker-sdk.md'),
  path.join(docsDir, 'worker-sdk-api.md'),
  path.join(repoRoot, 'llms.txt'),
];

const checkMode = process.argv.includes('--check');

await main();

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(workerSdkDir, 'package.json'), 'utf8'));
  const readme = await readFile(path.join(workerSdkDir, 'README.md'), 'utf8');
  const apiDtsPath = path.join(workerSdkDir, 'dist', 'worker', 'index.d.ts');
  const apiDts = await readFile(apiDtsPath, 'utf8');
  const breakingChanges = await readFile(path.join(workerSdkDir, 'BREAKING_CHANGES.md'), 'utf8');

  const outputs = new Map([
    [generatedFiles[0], renderWorkerDoc({ packageJson, readme, breakingChanges })],
    [generatedFiles[1], renderApiDoc({ packageJson, apiDtsPath, apiDts })],
    [generatedFiles[2], renderLlmsIndex()],
  ]);

  if (checkMode) {
    await checkGenerated(outputs);
    return;
  }

  await mkdir(docsDir, { recursive: true });
  for (const [file, content] of outputs) {
    await writeFile(file, content);
  }
}

function renderWorkerDoc({ packageJson, readme, breakingChanges }) {
  const sections = [
    renderIntro(readme),
    readSection(readme, '设计目标'),
    readSection(readme, '当前状态'),
    readSection(readme, '安装与导入'),
    readSection(readme, '核心用法'),
    readSection(readme, '资源模型'),
    readSection(readme, 'KV API'),
    readSection(readme, '运行时边界'),
    readSection(readme, '非目标'),
    readSection(readme, '安全约束'),
    readSection(readme, '迁移方向'),
  ];

  return `${generatedHeader()}
# ${packageJson.name}

## 生成来源

- 包元数据：\`package.json\`
- 使用说明：\`README.md\`
- 公开 API：\`dist/worker/index.d.ts\`
- 破坏性变更：\`BREAKING_CHANGES.md\`

## 包信息

- 包名：\`${packageJson.name}\`
- 版本：\`${packageJson.version}\`
- 类型：\`${packageJson.type}\`
- 当前公开入口：\`${Object.keys(packageJson.exports ?? {}).join('`, `')}\`

${sections.join('\n\n')}

## 破坏性变更摘要

${readSectionOrBody(breakingChanges, '状态')}

详见 \`BREAKING_CHANGES.md\`。
`;
}

function renderIntro(markdown) {
  const firstSection = markdown.indexOf('\n## ');
  const intro = markdown
    .slice(0, firstSection === -1 ? markdown.length : firstSection)
    .replace(/^# .+\n+/, '')
    .trim();
  if (!intro) {
    throw new Error('Missing README intro');
  }
  return `## 定位\n\n${intro}`;
}

function renderApiDoc({ packageJson, apiDtsPath, apiDts }) {
  return `${generatedHeader()}
# ${packageJson.name} API

## 生成来源

- 包入口：\`package.json\` 的 \`exports["."]\`
- TypeScript 声明：\`dist/worker/index.d.ts\`

## 公开 API 摘要

\`\`\`ts
${renderPublicApiSummary(apiDtsPath, apiDts)}
\`\`\`

## 约束

- 本文只描述 \`${packageJson.name}\` 根导出的公开 API。
- 为了让公开类型可读，本文会展开 public export 引用到的支持类型声明。
- 不包含 internal modules、browser helper、adapter 或 inline runtime source。
- API 变化必须先更新源码和类型声明，再重新生成本文。
`;
}

function renderPublicApiSummary(entryFile, entryContent) {
  const sourceFiles = new Map([[entryFile, parseDeclarationFile(entryFile, entryContent)]]);
  const queue = [];
  const enqueued = new Set();
  const seen = new Set();
  const rendered = [];

  for (const exported of readEntryExports(readSourceFile(entryFile))) {
    enqueue(exported);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const key = declarationKey(current);
    if (seen.has(key)) continue;
    seen.add(key);

    const declaration = findExportedDeclaration(current.file, current.name);
    rendered.push(cleanDeclarationText(declaration));

    for (const dependency of findReferencedExportedDeclarations(declaration)) {
      enqueue(dependency);
    }
  }

  if (rendered.length === 0) {
    throw new Error('Missing public API declarations');
  }

  return rendered.join('\n\n');

  function enqueue(item) {
    const key = declarationKey(item);
    if (seen.has(key) || enqueued.has(key)) return;
    enqueued.add(key);
    queue.push(item);
  }

  function readSourceFile(file) {
    if (!sourceFiles.has(file)) {
      sourceFiles.set(file, parseDeclarationFile(file));
    }
    return sourceFiles.get(file);
  }

  function readEntryExports(sourceFile) {
    const exports = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      const targetFile = resolveDeclarationModule(sourceFile.fileName, statement.moduleSpecifier.text);
      for (const element of statement.exportClause.elements) {
        exports.push({
          file: targetFile,
          name: (element.propertyName ?? element.name).text,
        });
      }
    }
    return exports;
  }

  function findExportedDeclaration(file, name) {
    const declarations = exportedDeclarationsFor(readSourceFile(file));
    const declaration = declarations.get(name);
    if (!declaration) {
      throw new Error(`Missing public declaration ${name} in ${path.relative(repoRoot, file)}`);
    }
    return declaration;
  }

  function findReferencedExportedDeclarations(declaration) {
    const dependencies = [];
    const sourceFile = declaration.getSourceFile();
    const localExports = exportedDeclarationsFor(sourceFile);
    const importedTypes = importedTypeDeclarationsFor(sourceFile);

    visit(declaration);
    return dependencies;

    function visit(node) {
      if (ts.isIdentifier(node)) {
        const name = node.text;
        const imported = importedTypes.get(name);
        if (imported) dependencies.push(imported);
        if (localExports.has(name)) dependencies.push({ file: sourceFile.fileName, name });
      }
      ts.forEachChild(node, visit);
    }
  }

  function exportedDeclarationsFor(sourceFile) {
    const declarations = new Map();
    for (const statement of sourceFile.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          declarations.set(element.name.text, statement);
        }
        continue;
      }

      if (!hasExportModifier(statement)) continue;

      const name = declarationName(statement);
      if (name) {
        declarations.set(name, statement);
        continue;
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            declarations.set(declaration.name.text, statement);
          }
        }
      }
    }
    return declarations;
  }

  function importedTypeDeclarationsFor(sourceFile) {
    const imports = new Map();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;

      const targetFile = resolveDeclarationModule(sourceFile.fileName, statement.moduleSpecifier.text);
      for (const element of namedBindings.elements) {
        imports.set(element.name.text, {
          file: targetFile,
          name: (element.propertyName ?? element.name).text,
        });
      }
    }
    return imports;
  }
}

function parseDeclarationFile(file, content) {
  return ts.createSourceFile(
    file,
    content ?? readDeclarationFile(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function readDeclarationFile(file) {
  return ts.sys.readFile(file) ?? missingDeclarationFile(file);
}

function missingDeclarationFile(file) {
  throw new Error(`Missing declaration file: ${path.relative(repoRoot, file)}`);
}

function resolveDeclarationModule(fromFile, moduleSpecifier) {
  const resolved = path.resolve(path.dirname(fromFile), moduleSpecifier);
  if (resolved.endsWith('.js')) return `${resolved.slice(0, -3)}.d.ts`;
  return `${resolved}.d.ts`;
}

function cleanDeclarationText(declaration) {
  return declaration
    .getFullText(declaration.getSourceFile())
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .trim();
}

function declarationKey({ file, name }) {
  return `${file}#${name}`;
}

function hasExportModifier(statement) {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function declarationName(statement) {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name?.text;
  }
  return undefined;
}

function renderLlmsIndex() {
  return `# XD Cell AI 文档索引

本文面向 AI agent，列出高信号、低重复的 XD Cell 文档入口。API 细节以生成文档为准，不在 skill reference 中重复维护。

## Worker SDK

- Worker SDK 使用快照：apps/worker-sdk/docs/llms/worker-sdk.md
- Worker SDK API 摘要：apps/worker-sdk/docs/llms/worker-sdk-api.md
- Worker SDK 破坏性变更：apps/worker-sdk/BREAKING_CHANGES.md
- Worker SDK README：apps/worker-sdk/README.md

## Agent 与发布

- xd-cell skill：apps/pages-skill/skill/SKILL.md
- Skill SDK reference：apps/pages-skill/skill/references/sdk.md
- CLI reference：apps/pages-skill/skill/references/cli.md
- 分发边界 ADR：docs/adr/0004-cli-sdk-skill-release-boundaries.md

## 平台边界

- 文档索引与真相源矩阵：docs/README.md
- API 边界说明：docs/api-boundary.md
- v2 架构索引：docs/pages-v2-wfp-architecture.md
`;
}

function generatedHeader() {
  return `<!-- This file is generated by apps/worker-sdk/scripts/generate-llms.js. Do not edit by hand. -->\n`;
}

function readSection(markdown, title) {
  const marker = `## ${title}`;
  const start = markdown.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing README section: ${title}`);
  }
  const next = markdown.indexOf('\n## ', start + marker.length);
  return markdown.slice(start, next === -1 ? markdown.length : next).trim();
}

function readSectionOrBody(markdown, title) {
  const marker = `## ${title}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return markdown.trim();
  const next = markdown.indexOf('\n## ', start + marker.length);
  return markdown.slice(start, next === -1 ? markdown.length : next).trim();
}

async function checkGenerated(outputs) {
  const mismatches = [];
  for (const [file, expected] of outputs) {
    const actual = existsSync(file) ? await readFile(file, 'utf8') : '';
    if (actual !== expected) {
      mismatches.push(path.relative(repoRoot, file));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Generated Worker SDK AI docs are stale: ${mismatches.join(', ')}`);
  }
}
