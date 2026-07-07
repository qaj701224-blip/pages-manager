import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_SELECT_VALUE, radixValueToSelectValue, selectValueToRadixValue } from './select-model.js';

test('select model maps empty value to a visible Radix item sentinel', () => {
  assert.equal(selectValueToRadixValue(''), EMPTY_SELECT_VALUE);
  assert.equal(radixValueToSelectValue(EMPTY_SELECT_VALUE), '');
  assert.equal(selectValueToRadixValue('team_a'), 'team_a');
  assert.equal(radixValueToSelectValue('team_a'), 'team_a');
});
