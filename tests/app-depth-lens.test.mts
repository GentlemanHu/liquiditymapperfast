import test from 'node:test';
import assert from 'node:assert/strict';
import { lensWeights, logBend, logShare, logValue, moneyAt, ringWidths, warpColumns } from '../src/app/panes/depth-lens.ts';

// Two columns of five nested bands (k = 5), as the Depth pane's answers hold them: band j of column x at x * k + j, each band holding the ones
// inside it. Column 0 is Karl's screenshot of 2026-11-23 (Levels, Wide, longs): 6.9M, 43M, 112M, 246M, 405M.
const WIDE = [0.0125, 0.025, 0.05, 0.1, 0.2];
const K = 5;
const COLS = Float32Array.from([6.9, 43, 112, 246, 405, 1, 2, 4, 8, 16]);
const close = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

test('ring widths: the first from the price to its band, each next from the band inside it', () => {
  const widths = ringWidths(WIDE, 4);
  assert.deepEqual(widths.map(w => Number(w.toFixed(6))), [0.0125, 0.0125, 0.025, 0.05, 0.1]);
  assert.equal(ringWidths(WIDE, 1).length, 2, 'only the bands up to the one brought forward');
});

test('per % of price: weights are the inverse width to the strength, the innermost 1; strength 0 is no lens', () => {
  const w1 = lensWeights({ kind: 'width', strength: 1 }, WIDE, 4);
  assert.deepEqual([...w1], [1, 1, 0.5, 0.25, 0.125]);
  const w0 = lensWeights({ kind: 'width', strength: 0 }, WIDE, 4);
  assert.deepEqual([...w0], [1, 1, 1, 1, 1]);
  const half = lensWeights({ kind: 'width', strength: 0.5 }, WIDE, 4);
  assert.ok(close(half[4]!, Math.SQRT1_2 / 2), 'a ring eight times as wide at strength 0.5: 1 / √8');
  // Bands that do not double: the weights follow the widths, whatever they are.
  const odd = lensWeights({ kind: 'width', strength: 1 }, [0.01, 0.05, 0.06], 2);
  assert.ok(close(odd[1]!, 0.25) && close(odd[2]!, 1));
  assert.deepEqual([...lensWeights({ kind: 'width', strength: 1 }, [0.05], 0)], [1], 'one band: nothing to weigh');
});

test('even room: each ring weighted so that its largest thickness in view (either side) matches the innermost one', () => {
  const zero = new Float32Array(10);
  const w = lensWeights({ kind: 'even', strength: 1 }, WIDE, 4, { bid: COLS, ask: zero, k: K, cols: 2 });
  // Rings of column 0: 6.9, 36.1, 69, 134, 159; column 1: 1, 1, 2, 4, 8. Peaks are column 0's.
  const peaks = [6.9, 36.1, 69, 134, 159];
  peaks.forEach((p, j) => assert.ok(close(w[j]!, 6.9 / p), `ring ${j}`));
  const warped = warpColumns(COLS, 2, K, 4, w);
  for (let j = 0; j < 5; j++) assert.ok(close(warped[j]!, 6.9 * (j + 1), 1e-3), 'every ring as thick as the first at its peak');
});

test('warp: each band the weighted rings inside it, in proportion within a ring; the money comes back from a height', () => {
  const w = lensWeights({ kind: 'width', strength: 1 }, WIDE, 4);
  const warped = warpColumns(COLS, 2, K, 4, w);
  const expect0 = [6.9, 6.9 + 36.1, 6.9 + 36.1 + 69 / 2, 6.9 + 36.1 + 34.5 + 134 / 4, 6.9 + 36.1 + 34.5 + 33.5 + 159 / 8];
  expect0.forEach((v, j) => assert.ok(close(warped[j]!, v), `band ${j}`));
  for (let j = 1; j < 5; j++) assert.ok(warped[j]! >= warped[j - 1]!, 'bands still nest');
  // moneyAt inverts the warp at every band's edge and inside a ring.
  for (let j = 0; j < 5; j++) assert.ok(close(moneyAt(COLS, warped, 0, K, 4, w, warped[j]!)!, COLS[j]!), `edge of band ${j}`);
  const midRing3 = (warped[2]! + warped[3]!) / 2;
  assert.ok(close(moneyAt(COLS, warped, 0, K, 4, w, midRing3)!, (112 + 246) / 2), 'half way through a ring is half its money');
  assert.equal(moneyAt(COLS, warped, 0, K, 4, w, warped[4]! * 1.01), null, 'past the widest band: nothing to read');
  assert.equal(moneyAt(COLS, warped, 0, K, 4, w, -1), null);
  assert.ok(close(moneyAt(COLS, warped, 0, K, 4, w, 0)!, 0));
});

test('warp: an empty band draws nothing, a band past the reach adds no ring, and only bands up to the one brought forward are drawn', () => {
  const w = lensWeights({ kind: 'width', strength: 1 }, WIDE, 4);
  // A column with nothing in its two inner bands, and one whose widest band is past the history's reach (0).
  const src = Float32Array.from([0, 0, 10, 20, 40, 5, 10, 20, 40, 0]);
  const warped = warpColumns(src, 2, K, 4, w);
  assert.equal(warped[0], 0); assert.equal(warped[1], 0);
  assert.ok(close(warped[2]!, 5), 'the first band with money holds its whole money as one ring');
  assert.equal(warped[9], 0, 'a band past the reach draws nothing');
  const focused = warpColumns(COLS, 2, K, 1, w);
  assert.equal(focused[2], 0, 'past the band brought forward nothing is worked out');
  assert.ok(close(focused[1]!, 43));
  // Nothing at all: every value 0, never NaN.
  assert.ok([...warpColumns(new Float32Array(10), 2, K, 4, w)].every(v => v === 0));
  assert.ok([...warpColumns(Float32Array.from([NaN, 1, 2, 3, 4, 1, 2, 3, 4, 5]), 2, K, 4, w)].every(v => Number.isFinite(v)));
});

test('log curve: 0 at nothing, 1 at the top, the inverse exact, more room for small amounts the stronger it is', () => {
  for (const strength of [0.1, 1, 2]) {
    const c = logBend(strength);
    assert.equal(logShare(0, 405, c), 0);
    assert.ok(close(logShare(405, 405, c), 1));
    for (const v of [6.9, 43, 200]) assert.ok(close(logValue(logShare(v, 405, c), 405, c), v), `round trip ${v} at ${strength}`);
  }
  const inner = (s: number): number => logShare(6.9, 405, logBend(s));
  assert.ok(6.9 / 405 < inner(0.1) && inner(0.1) < inner(1) && inner(1) < inner(2), 'the thin inner band grows with the strength');
  assert.ok(close(logBend(0.1), Math.pow(10, 0.15)), 'the default 0.1 bends gently');
});

test('strength 0 is no lens: the log curve straight, the bend continuous at 0.1', () => {
  assert.equal(logBend(0), 0);
  assert.equal(logShare(100, 400, 0), 0.25);
  assert.equal(logValue(0.25, 400, 0), 100);
  assert.ok(close(logBend(0.0999999), logBend(0.1)), 'no jump at 0.1');
  assert.ok(logBend(0.05) < logBend(0.1) && logBend(0.05) > 0);
  for (const s of [0.02, 0.05]) { const c = logBend(s); assert.ok(close(logValue(logShare(43, 405, c), 405, c), 43)); }
});
