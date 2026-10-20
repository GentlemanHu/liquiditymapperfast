import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_ALPHA, FULL_AT, WEAK_ALPHA, answerMedian, bucketsMedian, dominance, emphasisApplies, emphasisRamps, hexOfOklch, medianRow, oklch, splitStyles, strongAlpha, weakAlpha } from '../src/app/traded/emphasis.ts';
import { readTraded, TRADED_DEFAULTS } from '../src/app/traded/settings.ts';
import { tradedRows } from '../src/app/traded.ts';
import { PALETTES } from '../src/app/theme.ts';
import type { ProfileAnswer } from '../src/shared/footprint.ts';

const FLOOR = 25_000;

test('how one-sided a row is: thin rows are pulled to even, a large one-sided row is fully so', () => {
  assert.ok(Math.abs(dominance(10, 0, 2e6, FLOOR)) < 1e-5, '$10 against nothing is about even');
  assert.ok(dominance(50e6, 5e6, 2e6, FLOOR) > 0.99, '$50M against $5M: fully one-sided, to the first side');
  assert.ok(dominance(5e6, 50e6, 2e6, FLOOR) < -0.99, 'and the other way, signed');
  assert.equal(dominance(0, 0, 2e6, FLOOR), 0, 'an empty row: nothing');
  assert.equal(dominance(3e6, 3e6, 2e6, FLOOR), 0, 'even: nothing');
  // τ is the larger of the floor and 2 % of the median row: the same row is less one-sided among much busier ones.
  assert.ok(dominance(2e6, 1e6, 2e6, FLOOR) > dominance(2e6, 1e6, 200e6, FLOOR));
});

test('one fixed scale: about 0.05 at 52 / 48, about 0.74 at 60 / 40, full from 65 / 35, whatever the window', () => {
  // q = (b − s) / (T + τ); with τ = 0 (no floor and no median) q is the plain share difference.
  const e = (q: number): number => dominance((1 + q) / 2, (1 - q) / 2, 0, 0);
  assert.equal(e(0), 0);
  assert.ok(e(0.005) < 0.001, 'no step at even: the slope there is zero');
  assert.ok(Math.abs(e(0.04) - 0.05) < 0.005, `52 / 48: ${e(0.04)}`);
  assert.ok(Math.abs(e(0.2) - 0.74) < 0.005, `60 / 40: ${e(0.2)}`);
  assert.ok(Math.abs(e(FULL_AT) - 1) < 1e-12 && e(0.5) === 1, 'full at 65 / 35 and beyond');
  let last = 0; for (let q = 0; q <= 1; q += 0.02) { const v = e(q); assert.ok(v >= last - 1e-12); last = v; }
  // A row as busy as the median, $2M: τ is 2 % of it, so a 60 / 40 split is still clearly shown.
  assert.ok(dominance(1.2e6, 0.8e6, 2e6, FLOOR) > 0.65, 'a median row at 60 / 40');
  // The same split reads the same in a quiet window and a busy one, rows scaling with the window.
  assert.ok(Math.abs(dominance(1.2e6, 0.8e6, 2e6, 0) - dominance(120e6, 80e6, 200e6, 0)) < 1e-12);
});

test('alphas: the weaker side dims to 0.35, never to nothing, and the stronger rises to opaque', () => {
  assert.equal(weakAlpha(0), BAR_ALPHA); assert.ok(Math.abs(weakAlpha(1) - WEAK_ALPHA) < 1e-12);
  assert.ok(Math.abs(weakAlpha(1, 0.75) - 0.75 * WEAK_ALPHA / BAR_ALPHA) < 1e-12, 'from another bar alpha, in proportion');
  assert.equal(strongAlpha(0), BAR_ALPHA); assert.equal(strongAlpha(1), 1); assert.ok(Math.abs(strongAlpha(0.5) - 0.925) < 1e-12);
});

test('the median row is the whole answer\'s, not that of the prices on screen, and only rows that hold anything count', () => {
  const answer: ProfileAnswer = { from: 0, to: 1, instruments: [
    { id: 'a', step: 1, minutes: 0, first: null, earliest: 0, rows: [[100, 10, 5], [101, 2, 2], [102, 0, 0], [500, 400, 300], [501, 30, 30]] },
    { id: 'b', step: 1, minutes: 0, first: null, earliest: 0, rows: [[100, 1, 1]] },
  ] };
  const onScreen = tradedRows(answer, 1, 90, 110);
  assert.equal(onScreen.max, 17, 'on screen the busiest row is 17');
  assert.equal(answerMedian(answer, 1), 38.5, 'rows of 4, 17, 60 and 700 (the empty one left out): the median is 38.5');
  assert.equal(answerMedian(answer, 1), 38.5, 'kept');
  assert.equal(answerMedian(answer, 1000), 781, 'on rows of 1,000 everything is one row');
  assert.equal(medianRow([]), 0); assert.equal(medianRow([0, 0]), 0); assert.equal(medianRow([5, 1, 3]), 3);
  const run = { buy: [1, 0, 5, 0], sell: [1, 0, 1, 2] };
  assert.equal(bucketsMedian(run), 2, 'buckets of 2, 6 and 2: the median is 2'); assert.equal(bucketsMedian(run), 2);
});

test('split bars only: with Delta bars the setting does nothing, and the switch says why', () => {
  assert.equal(emphasisApplies('split'), true);
  assert.equal(emphasisApplies('delta'), false);
  assert.equal(TRADED_DEFAULTS.emphasis, true, 'on by default');
  assert.equal(readTraded({ emphasis: false }).emphasis, false, 'an explicit off is kept');
  assert.equal(readTraded({}).emphasis, true);
  const p = PALETTES.light!;
  assert.deepEqual(splitStyles(50e6, 5e6, 2e6, FLOOR, p, false), [{ color: p.bid, alpha: BAR_ALPHA }, { color: p.ask, alpha: BAR_ALPHA }], 'off: as they always were');
  const [first, second] = splitStyles(50e6, 5e6, 2e6, FLOOR, p, true);
  assert.notEqual(first.color, p.bid); assert.equal(first.alpha, 1, 'the stronger side: its stronger colour, opaque');
  assert.equal(second.color, p.ask); assert.ok(second.alpha < 0.4, 'the weaker: its own colour, dimmer');
  const [, sells] = splitStyles(5e6, 50e6, 2e6, FLOOR, p, true);
  assert.equal(sells.color, emphasisRamps(p).ask[255], 'the other way round: the second side is the stronger');
});

test('OKLCH round-trips, and a colour pushed out of sRGB is brought back in by its chroma', () => {
  for (const hex of ['#16a34a', '#e11d48', '#2563eb', '#f59e0b', '#ffffff', '#000000']) {
    const [L, C, h] = oklch(hex);
    assert.equal(hexOfOklch(L, C, h), hex);
  }
  const [L, C, h] = oklch('#00ff00'), out = hexOfOklch(Math.min(1, L + 0.08), C, h);
  assert.match(out, /^#[0-9a-f]{6}$/);
  assert.ok(oklch(out)[0] > L, 'lighter, inside the gamut');
  const ramps = emphasisRamps(PALETTES.dark!);
  assert.equal(ramps.bid.length, 256); assert.equal(ramps.bid[0], PALETTES.dark!.bid, 'at even, the side\'s own colour');
  assert.equal(emphasisRamps(PALETTES.dark!), ramps, 'built once a theme');
  // Away from the background toward the text's lightness, by up to 0.12 and never past it, in every theme; a side already past it stays.
  for (const [id, pal] of Object.entries(PALETTES)) {
    const text = oklch(pal.text)[0], r = emphasisRamps(pal), sign = pal.dark ? 1 : -1;
    for (const side of ['bid', 'ask'] as const) {
      const from = oklch(pal[side])[0], moved = sign * (oklch(r[side][255]!)[0] - from), room = Math.max(0, sign * (text - from));
      assert.ok(moved >= -0.01 && moved <= Math.min(room, 0.12) + 0.01, `${id} ${side}: moved ${moved.toFixed(3)}, room ${room.toFixed(3)}`);
    }
  }
});
