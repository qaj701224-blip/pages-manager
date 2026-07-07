import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const accessKeysSource = readFileSync(new URL('./pages/AccessKeys.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const accessKeyListSource = accessKeysSource.slice(
  accessKeysSource.indexOf('function AccessKeyList'),
  accessKeysSource.indexOf('function TokenCreatedDialog')
);

test('access key list avoids a separate refresh toolbar row', () => {
  assert.doesNotMatch(accessKeyListSource, /className="table-toolbar"/);
  assert.doesNotMatch(accessKeyListSource, /onRefresh/);
  assert.doesNotMatch(accessKeyListSource, /RotateCw/);
});

test('access key search toolbar has compact aligned spacing', () => {
  assert.match(accessKeyListSource, /className="list-toolbar api-token-toolbar"/);
  assert.match(stylesSource, /\.api-token-toolbar\s*\{[\s\S]*?padding:\s*14px 18px 12px;[\s\S]*?align-items:\s*end;/);
  assert.match(stylesSource, /\.api-token-toolbar \.list-search\s*\{[\s\S]*?max-width:\s*420px;/);
});
