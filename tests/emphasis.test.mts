import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_ALPHA, WEAK_ALPHA, answerMax, dominance, emphasisApplies, emphasisRamps, hexOfOklch, oklch, splitStyles, weakAlpha } from '../src/app/traded/emphasis.ts';
import { readTraded, TRADED_DEFAULTS } from '../src/app/traded/settings.ts';
import { tradedRows } from '../src/app/traded.ts';
import { PALETTES } from '../src/app/theme.ts';
import type { ProfileAnswer } from '../src/shared/footprint.ts';

const FLOOR = 25_000;

test('how one-sided a row is: thin rows are pulled to even, a large one-sided row is fully so', () => {
  assert.ok(Math.abs(dominance(10, 0, 55e6, FLOOR)) < 1e-6, '$10 against nothing is about even');
  assert.ok(dominance(50e6, 5e6, 55e6, FLOOR) > 0.99, '$50M against $5M, the busiest row $55M: about fully one-sided, to the first side');
  assert.ok(dominance(5e6, 50e6, 55e6, FLOOR) < -0.99, 'and the other way, signed');
  assert.equal(dominance(0, 0, 55e6, FLOOR), 0, 'an empty row: nothing');
  assert.equal(dominance(3e6, 3e6, 55e6, FLOOR), 0, 'even: nothing');
  // τ is the larger of the floor and 5 % of the busiest row: the same row is less one-sided beside a much busier one.
  assert.ok(dominance(2e6, 1e6, 2e6, FLOOR) > dominance(2e6, 1e6, 200e6, FLOOR));
});

test('the curve: flat at even, full from q = 0.8, smooth between', () => {
  // q = (b − s) / (T + τ); with τ = 0 (a tiny floor and a busiest row of 0) q is the plain share difference.
  const e = (q: number): number => dominance((1 + q) / 2, (1 - q) / 2, 0, 0);
  assert.equal(e(0), 0);
  assert.ok(e(0.01) < 0.001, 'no step at even: the slope there is zero');
  assert.ok(Math.abs(e(0.8) - 1) < 1e-12 && e(0.95) === 1, 'full at 0.8 and beyond');
  assert.ok(Math.abs(e(0.4) - 0.5) < 1e-12, 'half way at q = 0.4');
  let last = 0; for (let q = 0; q <= 1; q += 0.05) { const v = e(q); assert.ok(v >= last - 1e-12); last = v; }
  assert.equal(weakAlpha(0), BAR_ALPHA); assert.ok(Math.abs(weakAlpha(1) - WEAK_ALPHA) < 1e-12, 'the weaker side dims to 0.35, never to nothing');
  assert.ok(Math.abs(weakAlpha(1, 0.75) - 0.75 * WEAK_ALPHA / BAR_ALPHA) < 1e-12, 'from another bar alpha, in proportion');
});

test('the busiest row is the whole answer\'s, not that of the prices on screen', () => {
  const answer: ProfileAnswer = { from: 0, to: 1, instruments: [
    { id: 'a', step: 1, minutes: 0, first: null, earliest: 0, rows: [[100, 10, 5], [101, 2, 2], [500, 400, 300]] },
    { id: 'b', step: 1, minutes: 0, first: null, earliest: 0, rows: [[100, 1, 1]] },
  ] };
  const onScreen = tradedRows(answer, 1, 90, 110);
  assert.equal(onScreen.max, 17, 'on screen the busiest row is 17');
  assert.equal(answerMax(answer, 1), 700, 'the whole answer holds a row of 700 off screen');
  assert.equal(answerMax(answer, 10), 700);
  assert.equal(answerMax(answer, 1000), 721, 'on rows of 1,000 everything is one row');
});

test('split bars only: with Delta bars the setting does nothing, and the switch says why', () => {
  assert.equal(emphasisApplies('split'), true);
  assert.equal(emphasisApplies('delta'), false);
  assert.equal(TRADED_DEFAULTS.emphasis, true, 'on by default');
  assert.equal(readTraded({ emphasis: false }).emphasis, false, 'an explicit off is kept');
  assert.equal(readTraded({}).emphasis, true);
  const p = PALETTES.light!;
  assert.deepEqual(splitStyles(50e6, 5e6, 55e6, FLOOR, p, false), [{ color: p.bid, alpha: BAR_ALPHA }, { color: p.ask, alpha: BAR_ALPHA }], 'off: as they always were');
  const [first, second] = splitStyles(50e6, 5e6, 55e6, FLOOR, p, true);
  assert.notEqual(first.color, p.bid); assert.equal(first.alpha, BAR_ALPHA, 'the stronger side: its brighter colour, the same alpha');
  assert.equal(second.color, p.ask); assert.ok(second.alpha < 0.4, 'the weaker: its own colour, dimmer');
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
});
