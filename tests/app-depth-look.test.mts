import test from 'node:test';
import assert from 'node:assert/strict';
import { bandUnder, litWeights, type BandsAt, type LitBand } from '../src/app/panes/depth-look.ts';

// One column, three bands, a pixel a unit: the asks' bands reach 10, 20 and 30 px above the price line at 100, the bids' 10, 25 and 40 below.
const at: BandsAt = { k: 3, top: 2, ask: [10, 20, 30], bid: [10, 25, 40], mid: 100, yOf: v => v };
const pick = (y: number, keep: LitBand | null = null, margin = 3) => bandUnder(at, 0, y, keep, margin);

test('the band under the pointer: the innermost band whose edge is past the pointer, on its side of the price line; none past the widest', () => {
  assert.deepEqual([pick(95), pick(85), pick(75), pick(65)], [{ side: 'up', j: 0 }, { side: 'up', j: 1 }, { side: 'up', j: 2 }, null]);
  assert.deepEqual([pick(105), pick(120), pick(139), pick(150)], [{ side: 'down', j: 0 }, { side: 'down', j: 1 }, { side: 'down', j: 2 }, null]);
  assert.equal(bandUnder(at, -1, 95, null, 3), null, 'no column, no band');
});

test('a lit band holds while the pointer stays within the margin of its edges, lets go past it, and never across the price line', () => {
  const one: LitBand = { side: 'up', j: 1 };
  // Its strip is 10..20 px above the price line: held from 7 to 23 (3 px either side), the next band picked past that.
  assert.deepEqual([pick(100 - 21.5, one), pick(100 - 8, one), pick(100 - 24, one)], [one, one, { side: 'up', j: 2 }]);
  // The innermost band on the asks' side: crossing the price line by a pixel lights the bids' instead (it held there before, review 2026-11-22).
  const inner: LitBand = { side: 'up', j: 0 };
  assert.deepEqual([pick(99, inner), pick(101, inner)], [inner, { side: 'down', j: 0 }]);
  // A band of no thickness (two bands at the same height) is never held: the pointer picks afresh.
  const flat: BandsAt = { ...at, ask: [10, 10, 30] };
  assert.deepEqual(bandUnder(flat, 0, 100 - 9, { side: 'up', j: 1 }, 3), { side: 'up', j: 0 });
  // A band beyond the bands shown (the band count fell) is not held.
  assert.deepEqual(pick(95, { side: 'up', j: 5 }), { side: 'up', j: 0 });
});

test('how much each band lights up: the band 1, its neighbours 0.45 and 0.18, the same bands across the price at half, nothing with none lit', () => {
  const close = (a: Float32Array, b: number[]) => assert.deepEqual([...a].map(v => Math.round(v * 1000) / 1000), b);
  const w = litWeights(4, { side: 'up', j: 2 });
  close(w.up, [0.18, 0.45, 1, 0.45, 0.18]);
  close(w.down, [0.09, 0.225, 0.5, 0.225, 0.09]);
  const d = litWeights(2, { side: 'down', j: 0 });
  close(d.down, [1, 0.45, 0.18]);
  close(d.up, [0.5, 0.225, 0.09]);
  const none = litWeights(3, null);
  close(none.up, [0, 0, 0, 0]); close(none.down, [0, 0, 0, 0]);
});
