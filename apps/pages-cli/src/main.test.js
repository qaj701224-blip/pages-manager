import assert from 'node:assert/strict';
import test from 'node:test';

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
    env: { PAGES_ACCESS_KEY: 'xdpak_production_ak_1_secret' },
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
  assert.match(stderr.text(), /Site not found\./);
  assert.match(stderr.text(), /Check the site id\./);
  assert.equal(stdout.text(), '');
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
