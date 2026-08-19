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

test('admin webhook editor consumes the API event catalog and preserves unsupported history', () => {
  assert.doesNotMatch(adminWebhookSource, /const EVENT_OPTIONS/);
  assert.match(adminWebhookSource, /supportedEvents/);
  assert.match(adminWebhookSource, /历史不支持事件/);
  assert.match(adminWebhookSource, /移除历史事件/);
  assert.match(adminWebhookSource, /unsupportedEvents\.length > 0/);
  assert.match(adminWebhookSource, /requiredTemplateVariables/);
  assert.match(adminWebhookSource, /optionalTemplateVariables/);
  assert.match(adminWebhookSource, /选择预览事件/);
});

test('admin webhook template editor exposes variable availability warnings', () => {
  assert.match(adminWebhookSource, /getTemplateVariableWarnings/);
  assert.match(adminWebhookSource, /模板变量可能缺失/);
  assert.match(adminWebhookSource, /templateWarnings\.map/);
});
