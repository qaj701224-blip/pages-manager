import assert from 'node:assert/strict';
import test from 'node:test';

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
