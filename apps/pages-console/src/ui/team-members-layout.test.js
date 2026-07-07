import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('team members table keeps a white table surface with comfortable rows', () => {
  assert.match(stylesSource, /\.team-members-panel\s*\{[^}]*background:\s*var\(--xd-panel-strong\);/s);
  assert.match(stylesSource, /\.member-row\s*\{[^}]*padding-block:\s*12px;[^}]*background:\s*var\(--xd-panel-strong\);/s);
});

test('team member header action and avatars keep primary color contrast', () => {
  assert.doesNotMatch(stylesSource, /\.member-panel-head\s+span\s*\{/);
  assert.match(stylesSource, /\.member-panel-head > div > span\s*\{[^}]*color:\s*var\(--xd-muted\);/s);
  assert.match(stylesSource, /\.member-panel-head \.primary-button\s*\{[^}]*color:\s*#ffffff;/s);
  assert.match(stylesSource, /\.member-avatar\s*\{[^}]*place-items:\s*center;[^}]*color:\s*#ffffff;[^}]*line-height:\s*1;/s);
  assert.match(
    stylesSource,
    /\.member-row \.member-avatar,\s*\.member-picker-row \.member-avatar\s*\{[^}]*color:\s*#ffffff;/s
  );
});

test('member picker rows use the same compact white-card treatment', () => {
  assert.match(stylesSource, /\.member-picker-row\s*\{[^}]*padding:\s*12px;[^}]*background:\s*var\(--xd-panel-strong\);/s);
  assert.match(stylesSource, /\.member-picker-row \.member-avatar\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;/s);
});
