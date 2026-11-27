import test from 'node:test';
import assert from 'node:assert/strict';
import { depthZoneOn, edgeLabel, momentSlab, ribbonRuns, ringOf, ringPrices, sameZone, type DepthZone } from '../src/app/depth-zone.ts';

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const WIDE = [0.0125, 0.025, 0.05, 0.1, 0.2];

test('a ring above the price runs up from the band inside it, below the price down from it', () => {
  const up = ringPrices(60_000, 'up', 0.0125, 0.025)!, down = ringPrices(60_000, 'down', 0.0125, 0.025)!;
  assert.ok(close(up.lo, 60_750) && close(up.hi, 61_500));
  assert.ok(close(down.lo, 58_500) && close(down.hi, 59_250));
  // The first band starts at the price itself.
  const first = ringPrices(60_000, 'down', 0, 0.0125)!;
  assert.ok(close(first.hi, 60_000) && close(first.lo, 59_250));
  // No price, or no ring: nothing.
  assert.equal(ringPrices(0, 'up', 0, 0.01), null);
  assert.equal(ringPrices(Number.NaN, 'up', 0, 0.01), null);
  assert.equal(ringPrices(60_000, 'up', 0.02, 0.02), null);
  // A band past the whole price below it stops at zero.
  assert.equal(ringPrices(100, 'down', 0.5, 1.5)!.lo, 0);
});

test('the order book\'s ring is the bands asked; the levels\' is the bucket edges their figures read', () => {
  assert.deepEqual(ringOf(WIDE, 0), { inner: 0, outer: 0.0125 });
  assert.deepEqual(ringOf(WIDE, 3), { inner: 0.05, outer: 0.1 });
  assert.equal(ringOf(WIDE, 7), null, 'no such band');
  // The history's edges (percentages) and the bucket each band reads (bandIndex): a 2.4 % band would read the 2 % edge, so its ring ends there.
  const edges = [0.25, 0.5, 1, 1.25, 2, 2.5, 5, 10, 25];
  assert.deepEqual(ringOf([0.0125, 0.024], 1, { edges, idx: [3, 4] }), { inner: 0.0125, outer: 0.02 });
  assert.deepEqual(ringOf(WIDE, 0, { edges, idx: [3, 5, 6, 7, 8] }), { inner: 0, outer: 0.0125 });
  assert.deepEqual(ringOf(WIDE, 4, { edges, idx: [3, 5, 6, 7, 8] }), { inner: 0.1, outer: 0.25 }, 'the widest bucket reaches 25 %');
  // A band that reads no bucket, or the bucket the band inside it reads, has no ring.
  assert.equal(ringOf([0.001, 0.0125], 0, { edges, idx: [-1, 3] }), null);
  assert.equal(ringOf([0.0125, 0.013], 1, { edges, idx: [3, 3] }), null);
  assert.deepEqual(ringOf([0.001, 0.0125], 1, { edges, idx: [-1, 3] }), { inner: 0, outer: 0.0125 }, 'inside a band with no bucket, from the price');
});

test('the ribbon runs over the columns that have a centre, cut at a replay\'s moment and held inside the plot', () => {
  // Ten columns over 0..1000 ms drawn 10 px each (x = t / 10).
  const mid = Float64Array.from([100, 101, Number.NaN, 0, 104, 105, 106, 107, 108, 109]);
  const ribbon = { t0: 0, t1: 1000, w: 10, mid, cut: 8 };
  const runs = ribbonRuns(ribbon, t => t / 10, 0, 1000);
  assert.equal(runs.length, 2, 'NaN and 0 end a run');
  assert.deepEqual(runs[0]!.map(c => [c.x0, c.x1, c.centre]), [[0, 10, 100], [10, 20, 101]]);
  assert.deepEqual(runs[1]!.map(c => c.centre), [104, 105, 106, 107], 'columns past `cut` are not drawn');
  // Held inside [xMin, xMax]: a column across the edge is cut there, one wholly outside is left out.
  const inside = ribbonRuns({ ...ribbon, cut: 10 }, t => t / 10, 45, 75);
  assert.equal(inside.length, 1);
  assert.deepEqual(inside[0]!.map(c => [c.x0, c.x1]), [[45, 50], [50, 60], [60, 70], [70, 75]]);
  assert.deepEqual(ribbonRuns({ ...ribbon, t1: 0 }, t => t, 0, 100), [], 'an empty span draws nothing');
});

test('the moment\'s slab is at least a few pixels wide, centred on its column, and held inside the plot', () => {
  assert.deepEqual(momentSlab(100, 102, 6, 0, 500), { x0: 98, x1: 104 });
  assert.deepEqual(momentSlab(100, 120, 6, 0, 500), { x0: 100, x1: 120 }, 'a wide column keeps its width');
  assert.deepEqual(momentSlab(498, 500, 6, 0, 500), { x0: 496, x1: 500 });
  assert.equal(momentSlab(600, 610, 6, 0, 500), null);
});

test('zones are the same while nothing they draw changed; the ribbon is the same answer\'s', () => {
  const mid = new Float64Array([1, 2, 3]);
  const z: DepthZone = { pane: 'depth', source: 'book', side: 'up', inner: 0.0125, outer: 0.025, ink: 'ask', across: 'bid', moment: { t0: 10, t1: 20, centre: 60_000 },
    ribbon: { t0: 0, t1: 30, w: 3, mid, cut: 3 }, now: null };
  assert.equal(sameZone(z, { ...z, moment: { ...z.moment }, ribbon: { ...z.ribbon!, mid } }), true);
  assert.equal(sameZone(z, { ...z, ribbon: { ...z.ribbon!, mid: new Float64Array([1, 2, 3]) } }), false, 'a new answer is a new ribbon');
  assert.equal(sameZone(z, { ...z, side: 'down' }), false);
  assert.equal(sameZone(z, { ...z, pane: 'depth:2' }), false);
  assert.equal(sameZone(z, { ...z, moment: { ...z.moment, centre: 60_001 } }), false);
  const liq: DepthZone = { ...z, source: 'liq', ribbon: null, now: { centre: 60_000, strong: true } };
  assert.equal(sameZone(liq, { ...liq, now: { centre: 60_000, strong: true } }), true);
  assert.equal(sameZone(liq, { ...liq, now: { centre: 60_000, strong: false } }), false, 'an older snapshot read draws the stripe fainter');
  assert.equal(sameZone(liq, { ...liq, now: null }), false);
});

test('the band is named as the table names it, signed by its side; ?depthZone=off draws none', () => {
  assert.equal(edgeLabel('up', 0.025), '+2.5 %');
  assert.equal(edgeLabel('down', 0.0125), '−1.25 %');
  assert.equal(edgeLabel('down', 0.003125), '−0.31 %');
  assert.equal(edgeLabel('up', 0.2), '+20 %');
  assert.equal(depthZoneOn(''), true);
  assert.equal(depthZoneOn('?depthZone=off'), false);
  assert.equal(depthZoneOn('?coin=BTC&depthZone=on'), true);
});
