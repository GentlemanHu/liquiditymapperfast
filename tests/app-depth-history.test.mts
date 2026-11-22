import test from 'node:test';
import assert from 'node:assert/strict';
import { BandHistory, DepthHistory, RANK_MIN_COVER_MS, RANK_RECENT_MS, RANK_SPAN_MS, rankAt, rankKind, rankValue, SETTLE_MS, USUAL_SHARE } from '../src/app/depth-history.ts';
import type { ColumnsFrame } from '../src/shared/columns.ts';

const STEP = 16 * 60_000, HOUR = 3_600_000, DAY = 24 * HOUR, RADII = [0.01];
/** A frame of 16-minute windows from `from`: each book, in window x, one bid and one ask of `sizeAt(id, x)` USD at the touch (null: absent). */
function frame(ids: readonly string[], from: number, w: number, sizeAt: (id: string, x: number) => number | null): ColumnsFrame {
  const instruments = ids.map(id => {
    const times: number[] = [], counts: number[] = [], samples: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
    for (let x = 0; x < w; x++) {
      const s = sizeAt(id, x); if (s === null) continue;
      times.push(from + x * STEP); counts.push(2); samples.push(1);
      bins.push(999, 1001); bid.push(s, 0); ask.push(0, s);
    }
    return { id, step: 1, times, counts, samples, bins: Int32Array.from(bins), bid: Float32Array.from(bid), ask: Float32Array.from(ask) };
  });
  return { from, to: from + w * STEP, stepMs: STEP, instruments };
}
const T0 = 1_000 * STEP;   // on the grid
const at = (x: number): number => T0 + x * STEP + STEP / 2;

test('a moment is ranked by the closing minute of the window that closed last by then, against the closing minutes before it only', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0, w, (_, x) => 100 + x), T0, T0 + w * STEP);     // rising every window
  const r = rankAt(h, 'ask', 0, at(300))!;
  assert.equal(r.value, 399, 'window 299 closed last before a moment inside window 300');
  assert.equal(r.at, T0 + 300 * STEP);
  assert.equal(r.above, 0); assert.equal(r.equal, 0);
  assert.deepEqual(rankKind(r), { kind: 'highest', pct: 100, extreme: true });
  // A larger window later on changes nothing about an earlier moment: no look-ahead.
  h.put(frame(['a'], T0 + 350 * STEP, 1, () => 1e9), T0 + 350 * STEP, T0 + 351 * STEP);
  assert.deepEqual(rankAt(h, 'ask', 0, at(300)), r);
  assert.deepEqual(rankAt(h, 'ask', 0, T0 + 300 * STEP + 1), r, 'anywhere in the window, the same closing minute');
  // A value read finely (a column as shown) is ranked against the closing minutes that closed before its moment: windows 0..299.
  const v = rankValue(h, 'ask', 0, at(300), 250)!;
  assert.equal(v.n, 300); assert.equal(v.below, 150); assert.equal(v.equal, 1); assert.equal(v.at, null);
  assert.deepEqual(rankKind(v), { kind: 'above', pct: 50, extreme: false }, '150 of 300 strictly lower, 149 strictly higher');
});

test('ties never make a reading rarer than it is; a flat history reads as the middle; too little history gives no rank', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0, w, () => 500), T0, T0 + w * STEP);
  const r = rankAt(h, 'bid', 0, at(300))!;
  assert.equal(r.p, 0.5); assert.deepEqual(rankKind(r), { kind: 'middle', pct: 50, extreme: false });
  // Valid windows must cover the minimum, not only their first-to-last span.
  const need = Math.ceil(RANK_MIN_COVER_MS / STEP);
  assert.equal(rankAt(h, 'bid', 0, at(need)), null, `${need - 1} windows before it`);
  assert.ok(rankAt(h, 'bid', 0, at(need + 1)));
  const gappy = new BandHistory('k', ['a'], RADII);
  gappy.put(frame(['a'], T0, w, (_, x) => x < 5 || x > need + 100 ? 500 : null), T0, T0 + w * STEP);
  assert.equal(rankAt(gappy, 'bid', 0, at(need + 110)), null, 'a long gap does not count as covered');
});

test('a window missing a usual book is a gap; every book present is added up; a big newcomer makes a window a gap', () => {
  const w = 4 * 96, gaps = new Set([309, 200, 201, 202]);
  // b misses 4 of 384 windows (still usual at 90 %); c, small, is there one window in three; d, huge, once.
  const h = new BandHistory('k', ['a', 'b', 'c', 'd'], RADII);
  h.put(frame(['a', 'b', 'c', 'd'], T0, w, (id, x) => id === 'b' && gaps.has(x) ? null : id === 'c' ? (x % 3 ? null : 5) : id === 'd' ? (x === 100 ? 1e6 : null) : 100 + (x % 7)), T0, T0 + w * STEP);
  assert.deepEqual(h.usual(), [0, 1]);
  assert.ok(USUAL_SHARE > 0.5);
  assert.equal(rankAt(h, 'ask', 0, at(310)), null, 'the window b is missing from is not ranked');
  const n0 = h.n0;
  assert.equal(h.total('ask', 0, n0 + 318), 2 * (100 + 318 % 7) + 5, 'c is added where it is present');
  assert.ok(Number.isNaN(h.total('ask', 0, n0 + 100)), 'd holds more than a fifth of window 100: a gap');
  const r = rankAt(h, 'ask', 0, at(320))!;
  assert.equal(r.value, 2 * (100 + 319 % 7));
  assert.equal(r.n, 319 - 4 - 1, 'the windows before 319, less the four b is missing from (309 is one) and the one d swamps');
  // Asked of some books only, the others are left out.
  assert.equal(h.total('ask', 0, n0 + 318, ['a', 'b']), 2 * (100 + 318 % 7));
});

test('the grid grows both ways, a trim forgets the oldest windows, and a gap after a trim reads as not held', () => {
  const h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0 + 100 * STEP, 50, () => 7), T0 + 100 * STEP, T0 + 150 * STEP);
  h.put(frame(['a'], T0, 20, () => 3), T0, T0 + 20 * STEP);
  assert.equal(h.n0, Math.round(T0 / STEP)); assert.equal(h.count, 150);
  // (a is held in under 90 % of this grid, so it is not a usual book of it: the totals are asked with it named as usual)
  assert.deepEqual(h.usual(), []);
  assert.ok(Number.isNaN(h.total('ask', 0, h.n0 + 50, null, [0])), 'between the two puts nothing is held');
  assert.equal(h.total('ask', 0, h.n0 + 10, null, [0]), 3); assert.equal(h.total('ask', 0, h.n0 + 120, null, [0]), 7);
  h.trim(T0 + 110 * STEP);
  assert.equal(h.n0, Math.round(T0 / STEP) + 110); assert.equal(h.count, 40);
  assert.equal(h.total('ask', 0, h.n0), 7); assert.deepEqual(h.usual(), [0]);
  // A put past the end with a gap: the gap is not held, whatever the trim left behind in the buffer.
  h.put(frame(['a'], T0 + 200 * STEP, 5, () => 9), T0 + 200 * STEP, T0 + 205 * STEP);
  for (let n = Math.round(T0 / STEP) + 150; n < Math.round(T0 / STEP) + 200; n++) assert.ok(Number.isNaN(h.total('ask', 0, n, null, [0])), `window ${n} is not held`);
  assert.equal(h.total('ask', 0, Math.round(T0 / STEP) + 202, null, [0]), 9);
});

test('the words count the readings strictly lower or higher, rounded down, never 0 or 100 % unless past every one', () => {
  const r = (below: number, equal: number, above: number) => ({ p: (below + equal / 2) / (below + equal + above), n: below + equal + above, below, equal, above, coverMs: 3 * DAY, value: 1, at: null });
  assert.deepEqual(rankKind(r(990, 0, 10)), { kind: 'above', pct: 99, extreme: true });
  assert.deepEqual(rankKind(r(10, 0, 990)), { kind: 'below', pct: 99, extreme: true });
  assert.deepEqual(rankKind(r(0, 0, 50)), { kind: 'lowest', pct: 100, extreme: true });
  assert.deepEqual(rankKind(r(60, 0, 40)), { kind: 'above', pct: 60, extreme: false });
  assert.deepEqual(rankKind(r(30, 0, 70)), { kind: 'below', pct: 70, extreme: false });
  assert.equal(rankKind(r(999, 0, 1)).pct, 99, 'one reading above keeps it under 100');
  // Astra's tie (round 1): none lower, 7 equal, 193 higher. Below 96 %, not 98.
  assert.deepEqual(rankKind(r(0, 7, 193)), { kind: 'below', pct: 96, extreme: true });
  assert.deepEqual(rankKind(r(10, 90, 0)), { kind: 'middle', pct: 50, extreme: false });
});

test('the pane\'s history asks for a new book\'s recent hours first, then its older days, then each closed window; new books alone; new bands afresh', async () => {
  let now = T0 + 500 * STEP + 1000;
  const asked: { ids: string[]; from: number; to: number }[] = [];
  let release: (() => void) | null = null;
  const ask = (ids: string[], from: number, to: number): Promise<ColumnsFrame> => {
    asked.push({ ids, from, to });
    return new Promise(resolve => { release = () => resolve(frame(ids, from, Math.round((to - from) / STEP), () => 10)); });
  };
  let changes = 0;
  const hist = new DepthHistory(ask, () => { changes++; }, () => now);
  const settle = async () => { release!(); await new Promise(r => setTimeout(r, 0)); };
  assert.equal(hist.get(['a', 'b'], RADII), null, 'nothing held yet');
  assert.equal(asked.length, 0, 'the list of books has not stood long enough yet');
  now += SETTLE_MS;
  const closed = Math.floor((now - 60_000) / STEP) * STEP, recent = Math.ceil(RANK_RECENT_MS / STEP) * STEP;
  assert.equal(hist.get(['a', 'b'], RADII), null);
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b'], from: closed - recent, to: closed }, 'its recent hours, on the grid');
  hist.get(['a', 'b'], RADII); assert.equal(asked.length, 1, 'one question at a time');
  await settle();
  assert.ok(hist.get(['a', 'b'], RADII), 'the recent hours are enough to answer');
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b'], from: closed - RANK_SPAN_MS, to: closed - recent }, 'then the older days');
  await settle(); assert.equal(changes, 2); assert.ok(hist.wholeFor(['a', 'b']));
  hist.get(['a', 'b'], RADII); assert.equal(asked.length, 2, 'nothing more until a window closes');
  // A book joins: only it is asked for (its recent hours, then its older days); the others keep what they hold.
  assert.equal(hist.get(['a', 'b', 'c'], RADII), null, 'c has nothing yet');
  assert.deepEqual(asked.at(-1), { ids: ['c'], from: closed - recent, to: closed }, 'a book joining later is asked for at once');
  await settle();
  const h = hist.get(['a', 'b', 'c'], RADII)!;
  assert.ok(h);
  assert.deepEqual(asked.at(-1), { ids: ['c'], from: closed - RANK_SPAN_MS, to: closed - recent });
  assert.equal(h.total('ask', 0, Math.floor(closed / STEP) - 10, ['a'], [0]), 10, 'a was not asked for again and still holds its windows');
  await settle();
  // A window closes (and a minute's grace passes): the books held are asked for from the last window held again to the newest closed one.
  now += STEP + 1;
  hist.get(['a', 'b', 'c'], RADII);
  const closed2 = Math.floor((now - 60_000) / STEP) * STEP;
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b', 'c'], from: closed - STEP, to: closed2 });
  await settle();
  // Other bands start afresh (once the list of books has stood).
  assert.equal(hist.get(['a'], [0.02]), null);
  now += SETTLE_MS; hist.get(['a'], [0.02]);
  assert.deepEqual(asked.at(-1)!.ids, ['a']);
});

test('a window with no price the books agree on is not held; membership comes from the windows before the moment; a reading short of books is not ranked', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a', 'b'], RADII);
  // b stops after window 300 for good: it is still a usual book for moments before then, whatever came after.
  h.put(frame(['a', 'b'], T0, w, (id, x) => id === 'b' && x > 300 ? null : 100 + (x % 5)), T0, T0 + w * STEP);
  const before = rankAt(h, 'ask', 0, at(290))!;
  assert.ok(before);
  assert.deepEqual(h.usualIn(null, h.n0, h.n0 + 289), [0, 1]);
  assert.equal(rankValue(h, 'ask', 0, at(290), 205, null, null, 1), null, 'a reading that counted one book where the history usually had two');
  assert.ok(rankValue(h, 'ask', 0, at(290), 205, null, null, 2));
  // A one-sided answer (only asks, no bid to agree a price on) leaves the window not held.
  const one = new BandHistory('k', ['a'], RADII);
  const f = frame(['a'], T0, 3, () => 50);
  f.instruments[0]!.bid.fill(0);
  one.put(f, T0, T0 + 3 * STEP);
  assert.ok(Number.isNaN(one.total('ask', 0, one.n0, null, [0])), 'no centre: not held');
  // A put off the grid is refused.
  const off = new BandHistory('k', ['a'], RADII);
  off.put(frame(['a'], T0 + STEP / 2, 4, () => 5), T0 + STEP / 2, T0 + 4.5 * STEP);
  assert.equal(off.count, 0);
});
