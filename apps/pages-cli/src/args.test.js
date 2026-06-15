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

test('rejects unknown short flags and missing flag values', () => {
  assert.throws(() => parseArgs(['login', '-x']), /Unknown option/);
  assert.throws(() => parseArgs(['login', '--env']), /requires a value/);
});
