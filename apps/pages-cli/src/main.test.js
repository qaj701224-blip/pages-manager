import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { symlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ApiError } from './api-client.js';
import { main } from './main.js';

test('main dispatches commands and writes stdout', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['env', 'list'], {
    stdout,
    stderr,
    env: {},
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.text(), /production/);
  assert.equal(stderr.text(), '');
});

test('main returns non-zero safe errors for unknown commands', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['missing'], {
    stdout,
    stderr,
    env: {},
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /UNKNOWN_COMMAND/);
  assert.equal(stdout.text(), '');
});

test('main prints API error code, message, and action', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['deploy', '.'], {
    stdout,
    stderr,
    env: {},
    cwd: '/',
    commandRunner: async () => {
      throw new ApiError({
        status: 404,
        code: 'SITE_NOT_FOUND',
        message: 'Site not found.',
        action: 'Check the site id.',
      });
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text(), /SITE_NOT_FOUND/);
  assert.match(stderr.text(), /未找到站点/);
  assert.match(stderr.text(), /确认站点名和当前环境/);
  assert.equal(stdout.text(), '');
});

test('main prints JSON error envelopes when --json is requested', async () => {
  const stdout = capture();
  const stderr = capture();
  const exitCode = await main(['deploy', '.', '--json'], {
    stdout,
    stderr,
    env: {},
    commandRunner: async () => {
      const error = new Error('SITE_SLUG_REQUIRED');
      error.code = 'SITE_SLUG_REQUIRED';
      throw error;
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.text(), '');
  assert.deepEqual(JSON.parse(stderr.text()), {
    ok: false,
    schemaVersion: 1,
    error: {
      code: 'SITE_SLUG_REQUIRED',
      message: '缺少站点名。',
      action: '请传入站点名，例如 pages deploy ./dist demo。',
    },
  });
});

test('global symlinked bin invokes the CLI entrypoint', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-cli-bin-'));
  test.after(() => rm(dir, { recursive: true, force: true }));
  const linkPath = path.join(dir, 'pages');
  const mainPath = fileURLToPath(new URL('./main.js', import.meta.url));
  await symlink(mainPath, linkPath);

  const result = await runNode([linkPath, 'help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /用法：pages/);
  assert.equal(result.stderr, '');
});

function capture() {
  let value = '';
  return {
    write(chunk) {
      value += chunk;
    },
    text() {
      return value;
    },
  };
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
