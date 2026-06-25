import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await main();

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const packedFiles = await readPackedFiles();
  const requiredFiles = new Set([
    'package.json',
    'README.md',
    'BREAKING_CHANGES.md',
    'docs/llms/worker-sdk.md',
    'docs/llms/worker-sdk-api.md',
    'dist/errors.js',
    'dist/errors.d.ts',
    'dist/types.d.ts',
    'dist/worker/platform-context.js',
    'dist/worker/runtime.js',
  ]);

  for (const exportTarget of collectExportTargets(packageJson.exports)) {
    requiredFiles.add(exportTarget);
  }

  const missingFiles = [...requiredFiles].filter((file) => !packedFiles.has(file));
  if (missingFiles.length > 0) {
    fail(`Worker SDK package is missing required files:\n${missingFiles.map((file) => `- ${file}`).join('\n')}`);
  }
}

async function readPackedFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail([
      'npm pack --dry-run failed.',
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  let packResult;
  try {
    packResult = JSON.parse(result.stdout);
  } catch (error) {
    fail(`Unable to parse npm pack JSON output: ${error.message}\n${result.stdout}`);
  }

  const files = packResult?.[0]?.files;
  if (!Array.isArray(files)) {
    fail(`Unexpected npm pack JSON shape:\n${JSON.stringify(packResult, null, 2)}`);
  }

  return new Set(files.map((file) => file.path));
}

function collectExportTargets(exportsField) {
  const targets = new Set();
  visit(exportsField);
  return targets;

  function visit(value) {
    if (typeof value === 'string') {
      const normalized = normalizePackagePath(value);
      if (normalized) targets.add(normalized);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  }
}

function normalizePackagePath(value) {
  if (!value.startsWith('./')) return null;
  return value.slice(2);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
