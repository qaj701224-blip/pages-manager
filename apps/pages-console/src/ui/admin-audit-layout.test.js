import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./pages/AdminAudit.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('admin audit includes detail dialog and copy controls', () => {
  assert.match(source, /查看审计事件详情/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /audit-detail-metadata/);
  assert.match(source, /label="事件 ID"/);
  assert.match(source, /title=\{`复制\$\{label\}`\}/);
  assert.match(source, /复制 metadata/);
  assert.match(source, /serializeAuditMetadata\(event\.metadata\)/);
});

test('admin audit detail panel is responsive and bounds metadata overflow', () => {
  assert.match(styles, /\.audit-detail-panel\s*\{/);
  assert.match(styles, /\.audit-detail-metadata\s*\{[^}]*overflow: auto;/s);
  assert.match(styles, /@media \(min-width: 768px\)/);
  assert.match(styles, /@media \(min-width: 1280px\)/);
});
