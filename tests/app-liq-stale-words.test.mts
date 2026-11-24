import test from 'node:test';
import assert from 'node:assert/strict';
import { staleOfAll, staleWords } from '../src/app/liq-words.ts';
import type { LiqView } from '../src/app/liq-view.ts';

const view = (o: Partial<LiqView>): LiqView => ({ liq: true, stops: false, takes: false, group: 'all', ...o } as LiqView);
const set = (v: LiqView, liqOld: boolean, ordersOld: boolean) => ({ view: v, liqOld: () => liqOld, ordersOutOfDate: () => ordersOld });

test('what is out of date is named: the liquidations (no newer snapshot) or else the stops (no newer order file) (Karl, 2026-11-24)', () => {
  // HyperTracker's positions came back at 14:45Z while its order files stayed missing: fresh liquidations, stops from 09:20.
  assert.equal(staleWords(set(view({ stops: true }), false, true)), 'Stops out of date: no newer order file yet');
  assert.equal(staleWords(set(view({ liq: false, stops: true }), false, true)), 'Stops out of date: no newer order file yet');
  assert.equal(staleWords(set(view({ liq: false, takes: true }), false, true)), 'Take profits out of date: no newer order file yet');
  // Both stalled (the morning): the snapshot's words, which cover both.
  assert.equal(staleWords(set(view({ stops: true }), true, true)), 'Out of date: no newer snapshot yet');
  assert.equal(staleWords(set(view({}), true, false)), 'Out of date: no newer snapshot yet');
  // Liquidations off: their age says nothing.
  assert.equal(staleWords(set(view({ liq: false, stops: true }), true, false)), null);
  assert.equal(staleWords(set(view({ stops: true }), false, false)), null);
});

test('a split column says one line for both halves: the snapshot\'s words where either half\'s liquidations are old, else the stops\'', () => {
  const liq = view({}), stops = view({ liq: false, stops: true });
  assert.equal(staleOfAll([set(liq, false, false), set(stops, false, true)]), 'Stops out of date: no newer order file yet');
  assert.equal(staleOfAll([set(liq, true, false), set(stops, false, true)]), 'Out of date: no newer snapshot yet');
  assert.equal(staleOfAll([set(liq, false, false), set(stops, false, false)]), null);
});
