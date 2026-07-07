import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminWebhookSource = readFileSync(new URL('./pages/AdminWebhooks.jsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('admin webhook payload mode tabs use compact typography', () => {
  assert.match(adminWebhookSource, /className="segmented webhook-payload-mode"/);
  assert.match(stylesSource, /\.webhook-payload-mode button\s*\{[^}]*font-size:\s*12px;[^}]*font-weight:\s*500;/s);
  assert.match(stylesSource, /\.webhook-payload-mode button\.active\s*\{[^}]*font-weight:\s*600;/s);
});
