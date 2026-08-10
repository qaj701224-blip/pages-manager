import assert from 'node:assert/strict';
import test from 'node:test';
import { Linter } from 'eslint';

import noDirectNextId from './eslint-rules/no-direct-next-id.js';

test('no-direct-next-id rejects member and destructured reads', () => {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('no-direct-next-id', noDirectNextId);
  const messages = linter.verify(
    `
      const one = env.nextId('route');
      const two = env['nextId']('route');
      const three = runtimeEnv?.nextId('route');
      const { nextId } = env;
      const { nextId: generated } = env;
    `,
    { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules: { 'no-direct-next-id': 'error' } }
  );
  assert.equal(messages.length, 5);
});

test('no-direct-next-id permits shared helper calls and object definitions', () => {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('no-direct-next-id', noDirectNextId);
  const messages = linter.verify(
    `
      import { nextId } from './id.js';
      const generated = nextId(env, 'route');
      const fixture = { nextId(prefix) { return prefix; } };
      const { other } = env;
    `,
    { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules: { 'no-direct-next-id': 'error' } }
  );
  assert.deepEqual(messages, []);
});
