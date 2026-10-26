import test from 'node:test';
import assert from 'node:assert/strict';
import { HERO, PHONE_SPAN, PINCH_SPANS, columnAt, heroHeight, heroPoint, laneEnd, laneNet, laneRange, niceTicks, pinchSpan, priceRange, sharedRange, spanOnPhone } from '../src/app/cvd/hero.ts';
import { heroLabel } from '../src/app/cvd/text.ts';
import { PHI, locateRow, maxScroll, rowHeights } from '../src/app/cvd/layout.ts';

const near = (a: number, b: number, why = ''): void => assert.ok(Math.abs(a - b) < 1e-9, `${why} ${a} vs ${b}`);

test('a line is drawn over its own extent, zero kept in view when it starts from zero, with a tenth of air each side', () => {
  const r = laneRange({ min: -2, max: 8 }, true)!;
  near(r.lo, -3); near(r.hi, 9);
  // Starting from zero at the left edge: a line that only rose still has zero at its foot; one that has not been rebased does not.
  const up = laneRange({ min: 4, max: 14 }, true)!;
  assert.ok(up.lo < 0 && up.hi > 14);
  const running = laneRange({ min: 4, max: 14 }, false)!;
  near(running.lo, 3); near(running.hi, 15);
  // A flat line is not blown up into noise, and a line with nothing in it has no range.
  const flat = laneRange({ min: 5, max: 5 }, false)!;
  assert.ok(flat.hi - flat.lo >= 2);
  assert.equal(laneRange({ min: NaN, max: NaN }, true), null);
});

test('lines on one axis share the extent of all of them; the price has its own, an eighth of its extent in air', () => {
  const both = sharedRange([{ min: -1, max: 2 }, { min: 0, max: 30 }, null], true)!;
  assert.ok(both.lo < -1 && both.hi > 30, 'the larger line sets the axis');
  assert.equal(sharedRange([null, null], true), null);
  assert.deepEqual(sharedRange([{ min: -1, max: 2 }], true), laneRange({ min: -1, max: 2 }, true), 'one line alone reads as it does in its own row');
  const price = priceRange(80_000, 80_400)!;
  near(price.lo, 80_000 - 48); near(price.hi, 80_400 + 48);
  const flat = priceRange(80_000, 80_000)!;
  assert.ok(flat.hi > flat.lo, 'a flat price still has a range');
  assert.equal(priceRange(NaN, NaN), null);
});

test('axis ticks are round numbers inside the range, about as many as asked for, and zero is one of them when it is inside', () => {
  const t = niceTicks(-3.2e6, 17e6, 4);
  assert.equal(t.step, 5e6);
  assert.deepEqual(t.values, [0, 5e6, 10e6, 15e6]);
  assert.ok(Object.is(t.values[0], 0), 'zero, not minus zero');
  assert.deepEqual(niceTicks(80_270, 80_510, 4).values, [80_300, 80_350, 80_400, 80_450, 80_500]);
  assert.deepEqual(niceTicks(1, 1, 4), { step: 0, values: [] });
  assert.deepEqual(niceTicks(NaN, 5, 4), { step: 0, values: [] });
  for (const [lo, hi] of [[-1e9, 4e9], [0.0001, 0.0009], [2481.2, 2519.9], [-7, -3]] as const) {
    const { values } = niceTicks(lo, hi, 4);
    assert.ok(values.length >= 2 && values.length <= 8, `${lo}..${hi}: ${values.length}`);
    for (const v of values) assert.ok(v >= lo - 1e-12 && v <= hi + 1e-12);
  }
});

test('the chart takes a third of a tall pane and half of a short one, within limits', () => {
  assert.equal(heroHeight(700, false), Math.round(700 * HERO.share));
  assert.equal(heroHeight(300, false), HERO.min, 'never under its floor');
  assert.equal(heroHeight(2_000, false), HERO.max, 'never over its ceiling');
  assert.equal(heroHeight(300, true), 150);
  assert.equal(heroHeight(100, true), HERO.minSideways);
});

test('the values at a column: the price, each kind and both together, null where a line holds nothing', () => {
  const line = (...v: number[]) => ({ last: Float64Array.from(v) });
  const model = { spot: line(1, NaN, 3), perp: line(10, 20, NaN) } as unknown as Parameters<typeof heroPoint>[0];
  const price = line(80_000, 80_100, 80_200);
  assert.deepEqual(heroPoint(model, price, 0), { price: 80_000, spot: 1, perp: 10, total: 11 });
  assert.deepEqual(heroPoint(model, price, 1), { price: 80_100, spot: null, perp: 20, total: 20 });
  assert.deepEqual(heroPoint(model, price, 2), { price: 80_200, spot: 3, perp: null, total: 3 });
  assert.deepEqual(heroPoint({ spot: null, perp: null }, null, 0), { price: null, spot: null, perp: null, total: null });
  assert.equal(heroPoint(model, price, 99).price, null, 'a column past the end holds nothing');
});

test('a time falls in a column the way the lines slice the window', () => {
  assert.equal(columnAt(0, 1_000, 10, 0), 0);
  assert.equal(columnAt(0, 1_000, 10, 99), 0);
  assert.equal(columnAt(0, 1_000, 10, 100), 1);
  assert.equal(columnAt(0, 1_000, 10, 5_000), 9, 'held inside the window');
  assert.equal(columnAt(0, 1_000, 10, -5), 0);
  assert.equal(columnAt(5, 5, 10, 5), -1, 'no window, no column');
});

test('a pinch steps the span one way or the other per gesture, held at the ends, and the map span reads as an hour', () => {
  assert.deepEqual([...PINCH_SPANS], ['5m', '15m', '1h', '4h', '24h']);
  assert.equal(PHONE_SPAN, '1h');
  assert.equal(spanOnPhone('map'), '1h'); assert.equal(spanOnPhone('4h'), '4h');
  assert.equal(pinchSpan('1h', 1.5), '15m', 'fingers opening zoom in: a shorter span');
  assert.equal(pinchSpan('1h', 0.6), '4h', 'fingers closing zoom out: a longer one');
  assert.equal(pinchSpan('1h', 1.1), '1h', 'a small move is not a step');
  assert.equal(pinchSpan('5m', 2), '5m'); assert.equal(pinchSpan('24h', 0.4), '24h');
  assert.equal(pinchSpan('map', 1.5), '15m', 'the map span is the hour');
});

test('a fixed aggregate row takes its height and the venue rows share the rest, none under their minimum', () => {
  const shares = [0.4, 0.3, 0.2, 0.1];
  const l = rowHeights('golden', 700, shares, { minRow: 56, price: 0, agg: 224 });
  assert.equal(l.agg, 224); assert.equal(l.price, 0);
  assert.ok(l.rows.every(h => h >= 56));
  assert.equal(l.content, 224 + l.rows.reduce((a, b) => a + b, 0));
  assert.equal(l.content, 700, 'four rows of the ratio fill what the chart leaves');
  assert.ok(l.rows[0]! > l.rows[1]! && l.rows[1]! > l.rows[2]!, 'still ranked: each a little over half the one above');
  near(PHI ** -1, 0.6180339887498949, 'phi');
  // More rows than fit scroll under the chart, which stays where it is.
  const many = rowHeights('equal', 500, new Array(11).fill(0.09), { minRow: 56, price: 0, agg: 200 });
  assert.equal(many.agg, 200); assert.ok(many.rows.every(h => h === 56));
  assert.equal(maxScroll(many, 500), 200 + 11 * 56 - 500);
  assert.deepEqual(locateRow(many, 0, 500, 100), { kind: 'agg' });
  assert.deepEqual(locateRow(many, 0, 500, 230), { kind: 'row', index: 0 });
  assert.deepEqual(locateRow(many, 112, 500, 230), { kind: 'row', index: 2 }, 'scrolled under the chart');
  // A chart taller than the pane leaves nothing for rows to share, and the rows keep their minimum and scroll.
  const tall = rowHeights('golden', 150, [0.5, 0.5], { minRow: 56, price: 0, agg: 224 });
  assert.deepEqual(tall.rows, [56, 56]);
  // Rows that share the room evenly are whole pixels that add up to it: eight of 67.5 px were 68 each, and the column scrolled for four pixels.
  const even = rowHeights('equal', 800, Array(8).fill(0.125), { minRow: 56, price: 0, agg: 260 });
  assert.equal(even.content, 800); assert.ok(even.rows.every(r => r === 67 || r === 68));
  // Without `agg` the layout is as it was.
  const was = rowHeights('golden', 600, shares, { minRow: 54, minAgg: 84, price: 44 });
  assert.equal(was.content, 600); assert.ok(was.agg >= Math.max(...was.rows) * 1.2 - 1);
});

test('a line ends where its newest column is, and made that over the window when it starts from zero', () => {
  const line = (...v: number[]) => ({ last: Float64Array.from(v) });
  assert.equal(laneEnd(line(1, 2, NaN, NaN)), 2, 'the newest column that holds something');
  assert.equal(laneEnd(line(NaN, NaN)), null); assert.equal(laneEnd(null), null);
  assert.equal(laneNet(line(NaN, 2, 5, 9), true), 9, 'from zero at the left edge, the end is the net');
  assert.equal(laneNet(line(NaN, 100, 105, 90), false), -10, 'a running total since the history began: less where the window began');
  assert.equal(laneNet(line(NaN), false), null);
  // With the total before the window known, a burst in the first column is not lost: one column holding all the buying, and nothing after it.
  assert.equal(laneNet({ last: Float64Array.from([150, 150, 150]), before: 100 }, false), 50);
  assert.equal(laneNet({ last: Float64Array.from([NaN, 40, 40]), before: 0 }, false), 40, 'a line that began inside the window made all of it');
});

test('the legend of the chart names the window, gives each kind its net and the price its line, and says what the filter leaves out', () => {
  const line = (...v: number[]) => ({ last: Float64Array.from(v), delta: 999 });
  const model = { spot: line(NaN, 1_000_000, 2_500_000), perp: line(0, -4_000_000, -3_000_000), rankSec: 3600 } as unknown as Parameters<typeof heroLabel>[0];
  const lines = heroLabel(model, '5m', true, 80_520.1);
  assert.deepEqual(lines.map(l => l.text), ['ALL VENUES', 'S +$2.5M', 'P −$3M', 'Δ5M −$500K', '80,520.1']);
  assert.deepEqual(lines.map(l => l.dot ?? l.swatch ?? null), [null, 'spot', 'perp', null, 'price']);
  assert.ok(lines[0]!.bold && lines[3]!.tone === 'muted');
  // The figures are the lines' ends, never the ranking window's (`delta` is 999 here to show it).
  assert.ok(!lines.some(l => l.text.includes('999')));
  // A filter names itself and counts what it leaves out; no price, no price line; no lines, no total.
  const filtered = heroLabel(model, '1h', true, NaN, { kind: 'spot', hidden: 3 });
  assert.deepEqual(filtered.map(l => l.text), ['ALL SPOT VENUES', 'S +$2.5M', 'P −$3M', 'Δ1H −$500K', '3 filtered out']);
  assert.deepEqual(heroLabel({ spot: null, perp: null, rankSec: 3600 } as unknown as Parameters<typeof heroLabel>[0], '1h', true, NaN).map(l => l.text), ['ALL VENUES']);
});
