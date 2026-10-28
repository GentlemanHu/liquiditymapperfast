import test from 'node:test';
import assert from 'node:assert/strict';
import { channelLines, deltaOf, distToSegment, extendSegment, fibLevels, handlesOf, hitDrawing, strokesOf, type Projection } from '../src/app/draw/geometry.ts';
import { newDrawing } from '../src/app/draw/model.ts';

const T = Date.UTC(2026, 9, 28, 0), H = 3_600_000;
/** A plot 1000 x 500 px over 10 hours and the prices 100 to 200: 100 px an hour, 5 px a dollar. */
const pr: Projection = { x: t => (t - T) / H * 100, y: p => (200 - p) * 5, t: x => T + x / 100 * H, p: y => 200 - y / 5, w: 1000, h: 500 };
const at = (hours: number, p: number): { t: number; p: number } => ({ t: T + hours * H, p });
const size = () => ({ w: 60, h: 18 });

test('a line is clipped to the box, between its points or run on past either end', () => {
  const box = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, false, false, box), { a: { x: 20, y: 20 }, b: { x: 40, y: 40 } });
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, false, true, box), { a: { x: 20, y: 20 }, b: { x: 100, y: 100 } }, 'a ray');
  assert.deepEqual(extendSegment({ x: 20, y: 20 }, { x: 40, y: 40 }, true, true, box), { a: { x: 0, y: 0 }, b: { x: 100, y: 100 } }, 'both ways');
  assert.equal(extendSegment({ x: 200, y: 200 }, { x: 300, y: 300 }, false, false, box), null, 'off the box');
  assert.equal(distToSegment({ x: 30, y: 0 }, { a: { x: 0, y: 10 }, b: { x: 100, y: 10 } }), 10);
  assert.equal(distToSegment({ x: -30, y: 10 }, { a: { x: 0, y: 10 }, b: { x: 100, y: 10 } }), 30, 'past the end: to the end');
});

test('the retracement runs from 1 at its first point to 0 at its second; the channel\'s parallel keeps its price offset', () => {
  const fib = newDrawing('fib', [at(1, 100), at(3, 200)], T);
  const levels = fibLevels(fib, pr);
  assert.deepEqual(levels.map(l => Math.round(l.price * 10) / 10), [200, 176.4, 161.8, 150, 138.2, 121.4, 100]);
  assert.deepEqual([levels[0]!.x0, levels[0]!.x1], [100, 300]);
  assert.equal(fibLevels({ ...fib, extendRight: true }, pr)[0]!.x1, 1000, 'to the right edge');
  const ch = newDrawing('channel', [at(0, 150), at(4, 170), at(2, 140)], T);
  const lines = channelLines(ch, pr);
  assert.equal(lines.offset, -20, 'the third point is 20 under the line at its time');
  assert.deepEqual([lines.parallel!.a.y - lines.base!.a.y, lines.parallel!.b.y - lines.base!.b.y], [100, 100], '20 dollars = 100 px all along');
});

test('a level runs across the map, or from its anchor to the right as a ray; a vertical line\'s handle is halfway down', () => {
  const level = newDrawing('level', [at(5, 150)], T);
  const [s] = strokesOf(level, pr);
  assert.ok(s!.a.x < 0 && s!.b.x > 1000 && s!.a.y === 250);
  const ray = strokesOf({ ...level, extendLeft: false }, pr)[0]!;
  assert.equal(ray.a.x, 500, 'from its anchor');
  assert.deepEqual(handlesOf(newDrawing('vline', [at(2, 1)], T), pr), [{ x: 200, y: 250 }]);
});

test('the pointer finds the selected drawing\'s handles first, then the topmost stroke, then a zone\'s inside; hidden ones never', () => {
  const zone = newDrawing('zone', [at(1, 180), at(4, 160)], T), trend = newDrawing('trend', [at(0, 195), at(9, 125)], T);
  const list = [zone, trend];
  assert.deepEqual(hitDrawing({ x: 101, y: 101 }, list, pr, 6, zone.id, size), { id: zone.id, part: 'handle', index: 0 }, 'a corner of the selected zone');
  assert.deepEqual(hitDrawing({ x: 101, y: 101 }, list, pr, 6, null, size), { id: zone.id, part: 'stroke' }, 'not selected: its edge');
  assert.deepEqual(hitDrawing({ x: 250, y: 150 }, list, pr, 6, null, size), { id: zone.id, part: 'inside' });
  // The trend line crosses the zone: drawn last, it is on top.
  const y = pr.y(195 + (125 - 195) * (2.5 / 9));
  assert.deepEqual(hitDrawing({ x: 250, y }, list, pr, 6, null, size), { id: trend.id, part: 'stroke' });
  assert.equal(hitDrawing({ x: 250, y: 150 }, [{ ...zone, hidden: true }], pr, 6, null, size), null);
  const note = newDrawing('note', [at(6, 120)], T);
  assert.deepEqual(hitDrawing({ x: 640, y: 370 }, [note], pr, 6, null, size), { id: note.id, part: 'stroke' }, 'on its text box');
});

test('a pointer\'s move is the same time and price wherever it starts', () => {
  assert.deepEqual(deltaOf(pr, { x: 100, y: 100 }, { x: 150, y: 90 }), { dt: H / 2, dp: 2 });
  assert.deepEqual(deltaOf(pr, { x: 700, y: 400 }, { x: 750, y: 390 }), { dt: H / 2, dp: 2 });
});

test('left and right are by time: a line placed from right to left runs on to the right edge past its right-hand point', () => {
  const backwards = { ...newDrawing('trend', [at(6, 150), at(2, 130)], T), extendRight: true };
  const [s] = strokesOf(backwards, pr);
  assert.ok(Math.max(s!.a.x, s!.b.x) > 1000 && Math.min(s!.a.x, s!.b.x) === 200, 'from its left point at 2 h on past the right edge');
  const ch = { ...newDrawing('channel', [at(6, 170), at(2, 150), at(4, 140)], T), extendRight: true };
  const { base } = channelLines(ch, pr);
  assert.ok(Math.max(base!.a.x, base!.b.x) > 1000);
});
