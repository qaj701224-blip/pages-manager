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
  assert.deepEqual(parseArgs(['deploy', './dist', 'docs', '--json']), {
    command: 'deploy',
    positional: ['./dist', 'docs'],
    flags: {
      json: true,
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

test('parses sites delete confirmation as a boolean flag', () => {
  assert.deepEqual(parseArgs(['sites', 'delete', 'demo', '--yes', '--json']), {
    command: 'sites',
    positional: ['delete', 'demo'],
    flags: { yes: true, json: true },
  });
});

test('parses top-level help and version aliases', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'help', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['-h']), { command: 'help', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['--version']), { command: 'version', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['-v']), { command: 'version', positional: [], flags: {} });
  assert.deepEqual(parseArgs(['deploy', '-h']), { command: 'deploy', positional: [], flags: { help: true } });
});

test('rejects unknown short flags and missing flag values', () => {
  assert.throws(() => parseArgs(['login', '-x']), /未知选项/);
  assert.throws(() => parseArgs(['login', '--env']), /需要一个值/);
});
