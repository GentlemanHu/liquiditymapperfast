import test from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, groupLevels } from '../src/app/panes/levels-data.ts';
import type { Kernels } from '../src/app/kernels.ts';
import type { LevelsFrame } from '../src/app/wire.ts';

/** Point levels only: each level's dollars into the bin its price falls in (the kernel's rule for a level of one price). */
const kernels = { spreadLevels: (lo: Float64Array, _hi: Float64Array, usd: Float64Array, inst: Uint32Array, n: number, step: number, bin0: number, nBins: number): Float32Array => {
  const out = new Float32Array(n * nBins);
  for (let i = 0; i < usd.length; i++) { const k = Math.floor(lo[i]! / step) - bin0; if (k >= 0 && k < nBins) out[inst[i]! * nBins + k]! += usd[i]!; }
  return out;
} } as unknown as Kernels;
const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
const frame: LevelsFrame = { asOf: 0, books: [
  { id: 'a:X', venue: 'a', timestamp: 0, coarse: false, bids: side([[99_950, 999_500], [99_850, 199_700]]), asks: side([[100_050, 1_000_500]]) },
  { id: 'b:X', venue: 'b', timestamp: 0, coarse: false, bids: side([[99_950, 99_950]]), asks: side([[100_150, 2_003_000]]) },
] };

test('a grouping asked in coins carries each row over the price in its middle, beside the same dollars', () => {
  const usdOnly = groupLevels(kernels, frame, ['a:X', 'b:X'], 100, 99_800, 100_200);
  const g = groupLevels(kernels, frame, ['a:X', 'b:X'], 100, 99_800, 100_200, true);
  assert.equal(usdOnly.coins, undefined);
  assert.deepEqual([...g.totalBid], [...usdOnly.totalBid], 'the dollars are the dollars grouping\'s');
  const c = g.coins!;
  for (let i = 0; i < g.nBins; i++) {
    const mid = (g.bin0 + i + 0.5) * g.step;
    assert.ok(Math.abs(c.totalBid[i]! - g.totalBid[i]! / mid) < 1e-6, `bid ${i}`);
    assert.ok(Math.abs(c.totalAsk[i]! - g.totalAsk[i]! / mid) < 1e-6, `ask ${i}`);
    for (let k = 0; k < 2; k++) assert.ok(Math.abs(c.bid[k]![i]! - g.bid[k]![i]! / mid) < 1e-6, `venue ${k} bid ${i}`);
  }
  // 999,500 + 99,950 at the 99,900 row (middle 99,950) is 11 coins; 1,000,500 at the 100,000 row (middle 100,050) is 10.
  const row = (p: number) => Math.floor(p / 100) - g.bin0;
  assert.ok(Math.abs(c.totalBid[row(99_950)]! - 11) < 1e-6); assert.ok(Math.abs(c.totalAsk[row(100_050)]! - 10) < 1e-6);
  // Running totals from the mark come from the coins as the dollars' come from the dollars.
  assert.ok(Math.abs(cumulative(c, 100_000).maxAsk - (10 + 2_003_000 / 100_150)) < 1e-4);
  assert.equal(groupLevels(kernels, frame, ['a:X', 'b:X'], 100, 99_800, 100_200, true), g, 'kept for the frame');
});

test('each level is its own dollars over its own price before it is spread: two levels in one wide row add their own coins (review 2)', () => {
  const wide: LevelsFrame = { asOf: 0, books: [{ id: 'a:X', venue: 'a', timestamp: 0, coarse: false, bids: side([[90_000, 900_000], [99_000, 99_000]]), asks: side([]) }] };
  const g = groupLevels(kernels, wide, ['a:X'], 10_000, 90_000, 100_000, true);
  const row = Math.floor(95_000 / 10_000) - g.bin0;
  assert.ok(Math.abs(g.coins!.totalBid[row]! - 11) < 1e-6, `11 coins, not the row's middle's ${999_000 / 95_000}: ${g.coins!.totalBid[row]}`);
  assert.equal(g.totalBid[row], 999_000, 'the dollars as they were');
});
