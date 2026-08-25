import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./components/RadixPrimitives.jsx', import.meta.url), 'utf8');
const scrollHookSource = source.slice(
  source.indexOf('function usePreservedDialogScroll'),
  source.indexOf('export function SelectField')
);
const appDialogSource = source.slice(
  source.indexOf('export function AppDialog'),
  source.indexOf('export function ConfirmDialog')
);
const confirmDialogSource = source.slice(source.indexOf('export function ConfirmDialog'));
const siteDetailSource = readFileSync(new URL('./pages/SiteDetail.jsx', import.meta.url), 'utf8');
const teamsSource = readFileSync(new URL('./pages/Teams.jsx', import.meta.url), 'utf8');

test('shared dialogs restore the captured document scroll after Radix autofocus', () => {
  assert.match(scrollHookSource, /scrollPositionRef\.current = \{ x: window\.scrollX, y: window\.scrollY \}/);
  assert.match(scrollHookSource, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?window\.scrollTo\(x, y\)/);

  for (const dialogSource of [appDialogSource, confirmDialogSource]) {
    assert.match(dialogSource, /usePreservedDialogScroll\(open\)/);
    assert.match(dialogSource, /onCloseAutoFocus=\{restoreFocusAndScroll\}/);
  }
  assert.match(appDialogSource, /onOpenAutoFocus=\{handleOpenAutoFocus\}/);
  assert.match(confirmDialogSource, /onOpenAutoFocus=\{restoreScroll\}/);
});

test('closing a shared dialog restores focus without scrolling the document', () => {
  assert.match(scrollHookSource, /openerRef\.current = document\.activeElement/);
  assert.match(scrollHookSource, /opener\.ownerDocument === document/);
  assert.match(scrollHookSource, /window\.location\.href === locationRef\.current/);
  assert.match(scrollHookSource, /opener\.focus\(\{ preventScroll: true \}\)/);
  assert.match(scrollHookSource, /if \(openRef\.current \|\| !canRestoreScroll\(\)\) return;\s*event\.preventDefault\(\)/);
});

test('closing a dialog still restores scroll after its opener is removed', () => {
  const restoreScrollSource = scrollHookSource.slice(
    scrollHookSource.indexOf('const restoreScroll'),
    scrollHookSource.indexOf('const restoreFocusAndScroll')
  );

  assert.match(restoreScrollSource, /canRestoreScroll\(\)/);
  assert.doesNotMatch(restoreScrollSource, /openerRef|canRestoreFocus/);
  assert.match(scrollHookSource, /const opener = canRestoreFocus\(\) \? openerRef\.current : null/);
});

test('delayed close autofocus can restore after unmount while stale open-cycle callbacks remain guarded', () => {
  assert.match(scrollHookSource, /return \(\) => \{\s*openRef\.current = false/);
  assert.match(scrollHookSource, /openRef\.current = open/);
  assert.match(scrollHookSource, /const openState = openRef\.current/);
  assert.match(scrollHookSource, /openRef\.current !== openState \|\| !canRestoreScroll\(\)/);
  assert.match(scrollHookSource, /if \(openRef\.current \|\| !canRestoreScroll\(\)\) return/);
});

test('shared dialogs focus requested fields after capturing the opener', () => {
  assert.match(appDialogSource, /initialFocusRef/);
  assert.match(appDialogSource, /onOpenAutoFocus=\{handleOpenAutoFocus\}/);
  assert.match(appDialogSource, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(siteDetailSource, /autoFocus/);
  assert.doesNotMatch(teamsSource, /autoFocus/);
});
