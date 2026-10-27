import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, runScript } from '../src/app/script/lang/engine.ts';
import { SCRIPTS_KEY, loadScripts, storeScripts } from '../src/app/script/records.ts';
import { HEATMAP_ID, STARTER_ID, VWAP_SOURCE, starterScripts } from '../src/app/script/starter.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

const MIN = 60_000;
/** Candles 0..n-1 whose typical price is 100 + i, with 15·(i+1) dollars traded in each. */
function inputs(n = 8): BarInputs {
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  return {
    tf: MIN, time,
    open: Float64Array.from(time, (_, i) => 100 + i), high: Float64Array.from(time, (_, i) => 101 + i), low: Float64Array.from(time, (_, i) => 99 + i),
    close: Float64Array.from(time, (_, i) => 100 + i), volume: Float64Array.from(time, () => 1),
    sources: { '': { vbuy: Float64Array.from(time, (_, i) => 10 * (i + 1)), vsell: Float64Array.from(time, (_, i) => 5 * (i + 1)), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 } },
    forming: false,
  };
}

test('a browser that never kept scripts starts with the VWAP and the heat map; one that kept a list, an empty one too, keeps it', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
  const first = loadScripts(storage, starterScripts);
  assert.deepEqual(first.map(r => [r.id, r.on, r.place]), [[STARTER_ID, true, 'map'], [HEATMAP_ID, true, 'pane']], 'both on: the VWAP on the map, the heat map in a row');
  assert.equal(first[1]!.height, 160, "the heat map's row has room for its sixteen bands");
  assert.equal(first[0]!.source, VWAP_SOURCE);
  assert.equal(kept.size, 0, 'nothing is written until the person changes the list');
  assert.ok(storeScripts([], storage));
  assert.deepEqual(loadScripts(storage, starterScripts), [], 'a deleted starter stays deleted');
  kept.set(SCRIPTS_KEY, '{broken');
  assert.deepEqual(loadScripts(storage, starterScripts), [], 'something unreadable is not replaced by the starter');
  assert.equal(loadScripts({ getItem: () => { throw new Error('blocked'); } }, starterScripts).length, 2, 'storage the page cannot reach: the starters, for this visit');
  assert.deepEqual(loadScripts(storage), [], 'without a starter, none');
});

test('the VWAP reads, runs without a warning and draws its line inside its bands on the price scale', () => {
  const a = analyze(VWAP_SOURCE);
  assert.deepEqual(a.declared.map(d => d.name), ['len', 'mult', 'midColor', 'bandColor']);
  const r = runScript('vwap', VWAP_SOURCE, {}, inputs());
  assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.plots.map(p => [p.kind, p.title]), [['line', 'VWAP'], ['line', '+SD'], ['line', '-SD']]);
  for (const p of r.plots) assert.equal(p.style.priceScaleId ?? 'right', 'right', 'drawn at its prices on the map');
  const [mid, upper, lower] = r.plots.map(p => [...p.fields.value!]);
  assert.equal(mid![0], 100, 'one candle: its own typical price');
  // Two candles: (100·15 + 101·30) / 45.
  assert.ok(Math.abs(mid![1]! - (100 * 15 + 101 * 30) / 45) < 1e-9);
  for (let i = 0; i < mid!.length; i++) assert.ok(lower![i]! <= mid![i]! && mid![i]! <= upper![i]!, `candle ${i}`);
  const short = runScript('vwap', VWAP_SOURCE, { len: 4 }, inputs());
  assert.ok(short.ok);
  // Four candles back from the last (typical 104..107, volumes 75..120): its options change what it draws.
  const want = [104, 105, 106, 107].reduce((s, p, k) => s + p * 15 * (5 + k), 0) / [5, 6, 7, 8].reduce((s, k) => s + 15 * k, 0);
  assert.ok(Math.abs(short.plots[0]!.fields.value![7]! - want) < 1e-9);
  // A candle whose flow was not recorded: nothing drawn there, and the next candles go on from the ones before.
  const gap = inputs(), src = gap.sources['']!;
  src.vbuy[3] = NaN; src.vsell[3] = NaN;
  const g = runScript('vwap', VWAP_SOURCE, {}, gap);
  assert.ok(g.ok);
  assert.ok(g.plots.every(p => Number.isNaN(p.fields.value![3]!)), 'a gap, not the close');
  assert.ok(Number.isFinite(g.plots[0]!.fields.value![4]!) && Math.abs(g.plots[0]!.fields.value![4]! - 100) < 10);
});
