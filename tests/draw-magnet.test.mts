import test from 'node:test';
import assert from 'node:assert/strict';
import { MAGNET_PX, RELEASE, WALL_K, candleTargets, snapPoint, snapTime, wallRows, wallTargets, type CandleUnder } from '../src/app/draw/magnet.ts';

const y = (p: number): number => (200 - p) * 5;
const candle: CandleUnder = { t: 1_000, x: 300, open: 150, high: 160, low: 140, close: 155, y };

test('weak catches the candle\'s price within 8 px (14 with a finger), strong from 20 (28), off never', () => {
  const targets = candleTargets(candle, false);
  assert.deepEqual(targets.map(q => q.field), ['open', 'high', 'low', 'close']);
  // The high is at y 200: 7 px away catches with Weak, 9 does not.
  assert.equal(snapPoint(207, targets, 'weak', false, null)?.field, 'high');
  assert.equal(snapPoint(209, targets, 'weak', false, null), null);
  assert.equal(snapPoint(212, targets, 'weak', true, null)?.field, 'high', 'a finger gets more room');
  assert.equal(snapPoint(185, targets, 'strong', false, null)?.field, 'high', '15 px above the high');
  assert.equal(snapPoint(185, targets, 'weak', false, null), null);
  assert.equal(snapPoint(207, targets, 'off', false, null), null);
  assert.deepEqual([MAGNET_PX.weak.mouse, MAGNET_PX.weak.touch, MAGNET_PX.strong.mouse, MAGNET_PX.strong.touch], [8, 14, 20, 28]);
  const hit = snapPoint(203, targets, 'weak', false, null)!;
  assert.deepEqual([hit.t, hit.p], [1_000, 160], 'the point takes the candle\'s centre time and its high');
});

test('a caught target holds until one and a half times its radius, so two near targets do not flicker', () => {
  const targets = candleTargets(candle, false);
  const high = snapPoint(200, targets, 'weak', false, null)!;
  assert.equal(snapPoint(200 + 8 * RELEASE - 0.5, targets, 'weak', false, high)?.field, 'high', 'still held');
  assert.equal(snapPoint(200 + 8 * RELEASE + 1, targets, 'weak', false, high), null, 'let go');
});

test('a chart of closes offers the close alone', () => {
  assert.deepEqual(candleTargets(candle, true).map(q => q.field), ['close']);
});

test('a wall is a row holding three times its column\'s median, busier than its neighbours; a sparse column has none', () => {
  const rows = [0, 10, 12, 9, 11, 10, 50, 40, 10, 11, 9, 0, 10, 35];
  const walls = wallRows(rows, i => 100 + i);
  assert.deepEqual(walls, [{ p: 106, usd: 50 }, { p: 113, usd: 35 }], 'the 40 beside the 50 is the same wall; the median is 10');
  assert.ok(50 >= 10 * WALL_K);
  assert.deepEqual(wallRows([0, 0, 90, 1, 1], i => i), [], 'too few rows hold anything to judge');
  const targets = wallTargets(walls, 5_000, 300, y);
  assert.deepEqual(targets.map(q => [q.field, q.p, q.usd, q.t]), [['wall', 106, 50, 5_000], ['wall', 113, 35, 5_000]]);
});

test('the nearest target wins, a candle\'s price over a wall at the same height', () => {
  const walls = wallTargets([{ p: 160, usd: 9e6 }, { p: 162, usd: 5e6 }], 1_000, 300, y);
  const all = [...walls, ...candleTargets(candle, false)];
  assert.equal(snapPoint(200, all, 'weak', false, null)?.field, 'high', 'a tie: the candle');
  assert.equal(snapPoint(191, all, 'weak', false, null)?.field, 'wall', 'the wall at 162 is nearer');
});

test('a vertical line takes the centre of the candle under the pointer when it is near enough', () => {
  assert.equal(snapTime(305, candle, 'weak', false), 1_000);
  assert.equal(snapTime(312, candle, 'weak', false), null);
  assert.equal(snapTime(312, candle, 'strong', false), 1_000);
  assert.equal(snapTime(305, null, 'weak', false), null);
});

test('a wall caught stays caught while the pointer slides along it (its time follows the pointer)', () => {
  const at = (t: number) => wallTargets([{ p: 160, usd: 9e6 }, { p: 162, usd: 5e6 }], t, 300, y);
  const held = snapPoint(200, at(1_000), 'weak', false, null)!;
  assert.equal(held.p, 160);
  // Moved a pixel right and a little up: the wall at 162 is now nearer, but the one held is within its release distance.
  assert.equal(snapPoint(193, at(1_060), 'weak', false, held)?.p, 160);
});
