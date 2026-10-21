import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTab, resolveTab, tabsFor } from '../src/app/dock.ts';
import { DEFAULT_SHOW } from '../src/app/store.ts';

test('a window opens on the map on a desktop and on the Tape on a phone, in either direction of holding it', () => {
  assert.equal(defaultTab('desktop'), 'map');
  assert.equal(defaultTab('phone'), 'candle');
  assert.equal(defaultTab('phone-landscape'), 'candle');
});

test('the Tape is always among the tabs, so the phone default is never turned back to the map', () => {
  assert.ok(tabsFor({ ...DEFAULT_SHOW, cvd: false, book: false, depth: false, oi: false }).includes('candle'));
  assert.equal(resolveTab(defaultTab('phone'), { ...DEFAULT_SHOW, cvd: false }), 'candle');
  // A chosen tab whose pane was switched off still falls back to the map.
  assert.equal(resolveTab('flow', { ...DEFAULT_SHOW, cvd: false }), 'map');
});

test('the Stats tab follows the table\'s own switch, not the footprint\'s', () => {
  assert.ok(tabsFor({ ...DEFAULT_SHOW, stats: true }).includes('stats'));
  assert.ok(!tabsFor({ ...DEFAULT_SHOW, footprint: true, stats: false }).includes('stats'));
});
