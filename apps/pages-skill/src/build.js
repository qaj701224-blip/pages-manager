import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(moduleDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const defaultOutDir = path.join(packageDir, 'dist', 'xd-pages');
const skillSourceDir = path.join(packageDir, 'skill');
const defaultCliDistDir = path.join(repoRoot, 'apps', 'pages-cli', 'dist');
const defaultSdkPackageDir = path.join(repoRoot, 'apps', 'pages-sdk');
const skillVersionPlaceholder = '__XD_PAGES_SKILL_VERSION__';

export async function buildPagesSkill(options = {}) {
  const outDir = path.resolve(pathFromUrl(options.outDir || defaultOutDir));
  const cliDistDir = path.resolve(pathFromUrl(options.cliDistDir || defaultCliDistDir));
  const sdkPackageDir = path.resolve(pathFromUrl(options.sdkPackageDir || defaultSdkPackageDir));
  const runDependencyBuilds = options.runDependencyBuilds || runDefaultDependencyBuilds;

  await runDependencyBuilds();
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await writeFile(path.join(outDir, 'SKILL.md'), await renderedSkillMarkdown());
  await cp(path.join(skillSourceDir, 'references'), path.join(outDir, 'references'), { recursive: true });
  await cp(cliDistDir, path.join(outDir, 'tools', 'pages-cli'), { recursive: true });
  await copySdkPackage(sdkPackageDir, path.join(outDir, 'tools', 'pages-sdk'));

  return { outDir };
}

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

async function runDefaultDependencyBuilds() {
  await execFileAsync('pnpm', ['--filter', '@xd/pages-sdk', 'build'], { cwd: repoRoot });
  await execFileAsync('pnpm', ['--filter', '@xd/pages-cli', 'build'], { cwd: repoRoot });
}

async function copySdkPackage(sdkPackageDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await cp(path.join(sdkPackageDir, 'dist'), path.join(targetDir, 'dist'), { recursive: true });
  await cp(path.join(sdkPackageDir, 'README.md'), path.join(targetDir, 'README.md'));
  await writeFile(path.join(targetDir, 'package.json'), await sdkPackageManifest(sdkPackageDir));
}

async function sdkPackageManifest(sdkPackageDir) {
  const packageJson = await readPackageJson(sdkPackageDir);
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    private: packageJson.private,
    sideEffects: packageJson.sideEffects,
    exports: packageJson.exports,
  };
  return `${JSON.stringify(removeUndefined(manifest), null, 2)}\n`;
}

async function readPackageJson(packageDir) {
  return JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function pathFromUrl(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildPagesSkill();
}
