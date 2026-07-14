import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildPagesCli } from './build.js';

const execFileAsync = promisify(execFile);

test('buildPagesCli copies runtime files and package metadata without tests', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'pages-cli-build-'));
  try {
    await buildPagesCli({ outDir });

    const files = await readdir(outDir);
    assert.ok(files.includes('main.js'));
    assert.ok(files.includes('commands.js'));
    assert.ok(files.includes('package.json'));
    assert.ok(files.includes('README.md'));
    assert.ok(!files.includes('build.js'));
    assert.ok(!files.some((file) => file.endsWith('.test.js')));

    const main = await readFile(path.join(outDir, 'main.js'), 'utf8');
    assert.match(main, /^#!\/usr\/bin\/env node/);
    assert.equal(statSync(path.join(outDir, 'main.js')).mode & 0o111, 0o111);

    const packageJson = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'));
    assert.equal(packageJson.name, '@xd-cell/cli');
    assert.equal(packageJson.private, false);
    assert.equal(packageJson.type, 'module');
    assert.deepEqual(packageJson.bin, { 'xd-cell': './main.js' });
    const readme = await readFile(path.join(outDir, 'README.md'), 'utf8');
    assert.match(readme, /^# @xd-cell\/cli/m);
    for (const command of [
      'xd-cell logout',
      'xd-cell whoami --json',
      'xd-cell detect ./dist --json',
      'xd-cell teams --json',
      'xd-cell secrets delete demo API_TOKEN',
      'xd-cell access set demo --visibility acl',
      'xd-cell access grant demo',
      'xd-cell access revoke demo',
      'xd-cell help deploy',
      'xd-cell --version',
    ]) {
      assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(existsSync(path.join(outDir, 'src')), false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('built CLI can print its version from bundled package metadata', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'pages-cli-build-'));
  try {
    await buildPagesCli({ outDir });

    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const { stdout } = await execFileAsync(process.execPath, [path.join(outDir, 'main.js'), 'version']);
    assert.equal(stdout.trim(), packageJson.version);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
