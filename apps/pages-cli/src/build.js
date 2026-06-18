import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(moduleDir, '..');
const sourceDir = path.join(packageDir, 'src');
const defaultOutDir = path.join(packageDir, 'dist');

export async function buildPagesCli(options = {}) {
  const outDir = path.resolve(options.outDir || defaultOutDir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await cp(sourceDir, outDir, {
    recursive: true,
    filter: (source) => !source.endsWith('.test.js') && path.basename(source) !== 'build.js',
  });
  await writeFile(path.join(outDir, 'package.json'), await packageManifest());
  await chmod(path.join(outDir, 'main.js'), 0o755);
  return { outDir };
}

async function packageManifest() {
  const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    private: packageJson.private,
    type: packageJson.type,
    bin: {
      pages: './main.js',
    },
    engines: packageJson.engines,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await buildPagesCli();
}
