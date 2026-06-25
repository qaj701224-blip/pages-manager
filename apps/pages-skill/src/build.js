import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(moduleDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const defaultOutDir = path.join(packageDir, 'dist', 'xd-cell');
const defaultLegacyOutDir = path.join(packageDir, 'dist', 'xd-pages');
const skillSourceDir = path.join(packageDir, 'skill');
const defaultCliDistDir = path.join(repoRoot, 'apps', 'pages-cli', 'dist');
const defaultWorkerSdkPackageDir = path.join(repoRoot, 'apps', 'worker-sdk');
const skillVersionPlaceholder = '__XD_PAGES_SKILL_VERSION__';

export async function buildCellSkill(options = {}) {
  const outDir = path.resolve(pathFromUrl(options.outDir || defaultOutDir));
  const legacyOutDir = path.resolve(pathFromUrl(options.legacyOutDir || defaultLegacyOutDir));
  const cliDistDir = path.resolve(pathFromUrl(options.cliDistDir || defaultCliDistDir));
  const workerSdkPackageDir = path.resolve(pathFromUrl(options.workerSdkPackageDir || defaultWorkerSdkPackageDir));
  const runDependencyBuilds = options.runDependencyBuilds || runDefaultDependencyBuilds;

  await runDependencyBuilds();
  await rm(outDir, { recursive: true, force: true });
  if (legacyOutDir !== outDir) {
    await rm(legacyOutDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });

  await writeFile(path.join(outDir, 'SKILL.md'), await renderedSkillMarkdown());
  await cp(path.join(skillSourceDir, 'references'), path.join(outDir, 'references'), { recursive: true });
  await cp(cliDistDir, path.join(outDir, 'tools', 'xd-cell-cli'), { recursive: true });
  await cp(path.join(packageDir, 'BREAKING_CHANGES.md'), path.join(outDir, 'BREAKING_CHANGES.md'));
  await writeFile(path.join(outDir, 'manifest.json'), await renderedReleaseManifest({ cliDistDir, workerSdkPackageDir }));

  return { outDir };
}

export const buildPagesSkill = buildCellSkill;

async function renderedSkillMarkdown() {
  const [skillMarkdown, packageJson] = await Promise.all([
    readFile(path.join(skillSourceDir, 'SKILL.md'), 'utf8'),
    readPackageJson(packageDir),
  ]);
  if (!skillMarkdown.includes(skillVersionPlaceholder)) {
    throw new Error(`SKILL.md must contain ${skillVersionPlaceholder}`);
  }
  return skillMarkdown.replace(skillVersionPlaceholder, packageJson.version);
}

async function renderedReleaseManifest({ cliDistDir, workerSdkPackageDir }) {
  const [skillPackage, cliPackage, workerSdkPackage] = await Promise.all([
    readPackageJson(packageDir),
    readPackageJson(cliDistDir),
    readPackageJson(workerSdkPackageDir),
  ]);
  const workerSdkInstallCommand = `pnpm add ${workerSdkPackage.name}@${workerSdkPackage.version}`;
  const manifest = {
    schemaVersion: 1,
    product: {
      name: 'XD Cell',
      siteDomainSuffix: 'pages.xd.team',
    },
    skill: {
      name: 'xd-cell',
      packageName: skillPackage.name,
      version: skillPackage.version,
      breakingChangesPath: 'BREAKING_CHANGES.md',
    },
    dependencies: {
      cli: {
        packageName: cliPackage.name,
        version: cliPackage.version,
        bundled: true,
        path: 'tools/xd-cell-cli/main.js',
        packageJsonPath: 'tools/xd-cell-cli/package.json',
      },
      workerSdk: {
        packageName: workerSdkPackage.name,
        recommendedVersion: workerSdkPackage.version,
        installCommand: workerSdkInstallCommand,
        packagePath: 'node_modules/@xd-cell/worker-sdk',
        docsPath: 'docs/llms/worker-sdk.md',
        apiDocsPath: 'docs/llms/worker-sdk-api.md',
        breakingChangesPath: 'BREAKING_CHANGES.md',
      },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function runDefaultDependencyBuilds() {
  await execFileAsync('pnpm', ['--filter', '@xd-cell/cli', 'build'], { cwd: repoRoot });
}

async function readPackageJson(packageDir) {
  return JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
}

function pathFromUrl(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildCellSkill();
}
