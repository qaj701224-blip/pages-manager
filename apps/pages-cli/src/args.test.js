import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from './args.js';

test('parses command flags and boolean aliases', () => {
  assert.deepEqual(parseArgs(['login', '--env', 'staging', '--no-open']), {
    command: 'login',
    positional: [],
    flags: {
      env: 'staging',
      noOpen: true,
    },
  });
});

test('parses repeated scopes and positional arguments', () => {
  assert.deepEqual(parseArgs(['deploy', './dist', '--scope', 'deploy:site', '--scope', 'rollback:site']), {
    command: 'deploy',
    positional: ['./dist'],
    flags: {
      scope: ['deploy:site', 'rollback:site'],
    },
  });
});

test('parses top-level help and version aliases', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'help', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['-h']), { command: 'help', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['--version']), { command: 'version', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['-v']), { command: 'version', positional: [], flags: {} });
});

test('rejects unknown short flags and missing flag values', () => {
  assert.throws(() => parseArgs(['login', '-x']), /Unknown option/);
  assert.throws(() => parseArgs(['login', '--env']), /requires a value/);
});
