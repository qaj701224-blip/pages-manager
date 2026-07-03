import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const accessKeysSource = readFileSync(new URL('./pages/AccessKeys.jsx', import.meta.url), 'utf8');
const accessKeyListSource = accessKeysSource.slice(
  accessKeysSource.indexOf('function AccessKeyList'),
  accessKeysSource.indexOf('function TokenCreatedDialog')
);

test('access key list avoids a separate refresh toolbar row', () => {
  assert.doesNotMatch(accessKeyListSource, /className="table-toolbar"/);
  assert.doesNotMatch(accessKeyListSource, /onRefresh/);
  assert.doesNotMatch(accessKeyListSource, /RotateCw/);
});
