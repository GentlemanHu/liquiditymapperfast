import test from 'node:test';
import assert from 'node:assert/strict';
import { TAPE_BATCH_MAX, checkTape, packTape, type TapeBatch } from '../src/shared/tape.ts';
import type { MarketOrder } from '../src/shared/orders.ts';
import { BLOCK, STRIDE, TapeRing } from '../src/app/tape/ring.ts';
import { TRACE_GAP_MS, TraceIndex, gapMarks, secondsPath, traceGapColumns } from '../src/app/tape/trace.ts';
import { readBubbles } from '../src/app/prints.ts';

const T0 = 1_800_000_000_000;
const order = (id: string, t: number, price: number, usd: number, side: 'buy' | 'sell' = 'buy', lo = price, hi = price): MarketOrder => ({ instrumentId: id, tradeId: `${id}-${t}-${usd}`, side, t, price, lo, hi, usd, fills: 1 });
/** A batch of orders in one market, `n` of them a millisecond apart from `t`, at `price` + i. */
const batch = (seq: number, t: number, n: number, price = 80_000, id = 'binance:BTCUSDT'): TapeBatch => packTape(Array.from({ length: n }, (_, i) => order(id, t + i, price + i, 1_000 + i, i % 2 ? 'sell' : 'buy')), seq);

test('a batch carries every order as columns, a sell as negative USD, and the market ids once each', () => {
  const b = packTape([order('a:X', T0, 100, 5_000), order('b:Y', T0 + 1, 101, 7_000, 'sell', 100.5, 101.5), order('a:X', T0 + 2, 102, 9_000)], 4);
  assert.deepEqual(b.ids, ['a:X', 'b:Y']);
  assert.deepEqual([...b.inst], [0, 1, 0]);
  assert.deepEqual([...b.usd], [5_000, -7_000, 9_000]);
  assert.deepEqual([...b.lo], [100, 100.5, 102]); assert.deepEqual([...b.hi], [100, 101.5, 102]);
  assert.equal(b.seq, 4); assert.equal(b.dropped, 0);
});

test('past the batch limit the largest orders stay, ties to the earliest, and the batch says how many it left out', () => {
  const orders = [order('a:X', T0, 1, 10), order('a:X', T0 + 1, 1, 50), order('a:X', T0 + 2, 1, 30), order('a:X', T0 + 3, 1, 30), order('a:X', T0 + 4, 1, 20)];
  const b = packTape(orders, 0, 3);
  assert.deepEqual([...b.usd], [50, 30, 30]); assert.equal(b.dropped, 2);
  assert.ok(TAPE_BATCH_MAX >= 10_000);
});

test('a checked batch keeps good rows and drops bad ones; a malformed one is refused whole', () => {
  const b = packTape([order('a:X', T0, 100, 5_000), order('a:X', T0 + 1, 100, 6_000)], 1);
  assert.equal(checkTape(b)?.inst.length, 2);
  const bad = { ...b, price: Float64Array.from([100, Number.NaN]) };
  assert.deepEqual([...checkTape(bad)!.usd], [5_000]);
  const outside = { ...b, lo: Float64Array.from([101, 100]) };
  assert.equal(checkTape(outside)!.inst.length, 1, 'a span that does not hold the price is dropped');
  assert.equal(checkTape({ ...b, inst: Int32Array.from([0, 3]) })!.inst.length, 1, 'an index outside the ids is dropped');
  assert.equal(checkTape({ ...b, t: new Float64Array(1) }), null, 'columns of different lengths');
  assert.equal(checkTape({ ...b, ids: [1] }), null);
  assert.equal(checkTape({ ...b, seq: 1.5 }), null);
  assert.equal(checkTape({ ...b, usd: [1, 2] }), null, 'plain arrays are not taken for typed ones');
});

test('the ring keeps times and prices relative to its bases and gives them back exactly enough to draw', () => {
  const ring = new TapeRing(BLOCK * 2);
  ring.add(batch(0, T0, 3, 81_234.5), 1, 0);
  assert.equal(ring.size, 3); assert.equal(ring.t0, T0); assert.equal(ring.p0, 81_234.5);
  const r = ring.at(2);
  assert.equal(r.t, T0 + 2); assert.equal(r.price, 81_236.5); assert.equal(r.id, 'binance:BTCUSDT'); assert.equal(r.usd, 1_002);
  assert.equal(ring.data.length, BLOCK * 2 * STRIDE);
});

test('markets get one index across batches whatever order each batch names them in', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(packTape([order('a:X', T0, 1, 1), order('b:Y', T0, 1, 1)], 0), 1, 0);
  ring.add(packTape([order('b:Y', T0 + 1, 1, 1), order('c:Z', T0 + 1, 1, 1), order('a:X', T0 + 1, 1, 1)], 1), 1, 0);
  assert.deepEqual(ring.ids, ['a:X', 'b:Y', 'c:Z']);
  assert.deepEqual([2, 3, 4].map(k => ring.at(k).id), ['b:Y', 'c:Z', 'a:X']);
});

test('a full ring lets the oldest go, and says from when it holds everything', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(0, T0, BLOCK), 1, 0);
  assert.equal(ring.heldFrom, T0);
  ring.add(batch(1, T0 + 10_000, 10), 1, 0);
  assert.equal(ring.size, BLOCK); assert.equal(ring.first, 10);
  assert.equal(ring.heldFrom, T0 + 10, 'the oldest still held');
  assert.equal(ring.at(BLOCK + 9).t, T0 + 10_009);
});

test('a reconnect, a skipped batch or a trimmed one starts a new segment: the dust never hides a gap', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(5, T0, 2), 1, 0);
  ring.add(batch(6, T0 + 1_000, 2), 1, 0);
  assert.equal(ring.segments.length, 1); assert.equal(ring.segments[0]!.to, T0 + 1_001);
  ring.add(batch(8, T0 + 2_000, 2), 1, 0);
  assert.equal(ring.segments.length, 2, 'seq 7 never came');
  ring.add(batch(9, T0 + 3_000, 2), 2, 0);
  assert.equal(ring.segments.length, 3, 'a new connection');
  ring.add({ ...batch(10, T0 + 4_000, 2), dropped: 5 }, 2, 0);
  assert.equal(ring.segments.length, 4, 'a trimmed batch');
  assert.equal(ring.segments[3]!.from, T0 + 4_000);
});

test('the map marks only the gaps the price line breaks at: a skipped batch is a new segment but no hole', () => {
  const seg = (from: number, to: number) => ({ from, to });
  assert.equal(TRACE_GAP_MS, 10_000);
  assert.deepEqual([traceGapColumns(100), traceGapColumns(1_000), traceGapColumns(5_000)], [100, 10, 3], 'ten seconds, never fewer than three columns');
  // A page that was skipped for a pass or two: segments a fraction of a second apart.
  const skipped = [seg(T0, T0 + 60_000), seg(T0 + 60_300, T0 + 120_000), seg(T0 + 120_900, T0 + 180_000)];
  assert.deepEqual(gapMarks(skipped, T0, 1_000), [], 'holes of under a second are not marked at any zoom');
  assert.deepEqual(gapMarks(skipped, T0, 0.1), [], 'nor zoomed far in');
  // A reconnect that took a minute, and one that took 12 seconds.
  const outage = [seg(T0, T0 + 60_000), seg(T0 + 120_000, T0 + 180_000), seg(T0 + 192_000, T0 + 200_000)];
  assert.deepEqual(gapMarks(outage, T0, 100), [T0 + 120_000, T0 + 192_000]);
  assert.deepEqual(gapMarks(outage, T0, 5_000), [T0 + 120_000], 'at 5 s a pixel the 12 s hole is under four columns');
  assert.deepEqual(gapMarks(outage, T0, 30_000), [], 'at half a minute a pixel the one-minute hole is too');
  assert.deepEqual(gapMarks(outage, T0 + 150_000, 100), [T0 + 192_000], 'nothing at or before the start the ring still holds');
  // The line breaks across `gap` empty columns, so orders `gap + 1` columns apart: at 1 s a column, 11 s.
  assert.deepEqual(gapMarks([seg(T0, T0 + 1_000), seg(T0 + 12_000, T0 + 13_000)], T0, 1_000), [T0 + 12_000]);
  assert.deepEqual(gapMarks([seg(T0, T0 + 1_000), seg(T0 + 11_999, T0 + 13_000)], T0, 1_000), [], 'a millisecond short');
  assert.deepEqual(gapMarks([seg(T0, T0 + 5_000), seg(T0 + 4_000, T0 + 9_000)], T0, 1), [], 'a source whose clock runs back leaves no hole');
  for (const ms of [0, -1, Number.NaN, Infinity]) assert.deepEqual(gapMarks(outage, T0, ms), [], `a view with ${ms} ms a pixel marks nothing`);
  assert.deepEqual(gapMarks([], T0, 1), []); assert.deepEqual(gapMarks([seg(T0, T0 + 1)], T0, 1), []);
  // Segments overlap or come out of order (orders are stamped by their exchanges): their ranges merge before a hole is measured.
  assert.deepEqual(gapMarks([seg(T0, T0 + 60_000), seg(T0 + 50_000, T0 + 51_000), seg(T0 + 65_000, T0 + 66_000)], T0, 1_000), [], 'the order at 60 s keeps the line joined to 65 s');
  assert.deepEqual(gapMarks([seg(T0, T0 + 10_000), seg(T0 + 100_000, T0 + 110_000), seg(T0 + 20_000, T0 + 30_000)], T0, 1_000), [T0 + 100_000], 'a later segment inside the hole narrows it');
});

test('a marked gap is a break in the price line, and a hole the line bridges is not marked', () => {
  const ms = 1_000, c = Math.floor(T0 / ms);
  const rings = [12_000, 10_500].map(later => {
    const ring = new TapeRing(BLOCK), trace = new TraceIndex();
    ring.add(batch(1, T0, 2), 1, 0); ring.add(batch(2, T0 + later, 2), 2, 0);   // a new connection, `later` ms on
    trace.update(ring, T0, T0 + 20_000, ms);
    return { marks: gapMarks(ring.segments, T0, ms), runs: trace.path(0, c, c + 19, traceGapColumns(ms)).length };
  });
  assert.deepEqual(rings[0], { marks: [T0 + 12_000], runs: 2 });
  assert.deepEqual(rings[1], { marks: [], runs: 1 }, 'nine empty columns do not break it');
});

test('a segment keeps the earliest and the latest order it holds, whatever order the batches stamp them', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, T0 + 5_000, 2), 1, 0); ring.add(batch(2, T0 + 1_000, 2), 1, 0);
  assert.deepEqual(ring.segments, [{ from: T0 + 1_000, to: T0 + 5_001 }]);
});

test('the time base moves forward before offsets outgrow a float32, without moving any order', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(0, T0, 2), 1, 0);
  const epoch = ring.epoch, later = T0 + (1 << 24) + 5_000;
  ring.add(batch(1, later, 2), 1, 0);
  assert.ok(ring.epoch > epoch, 'the card copies it again whole');
  assert.equal(ring.t0, later);
  assert.equal(ring.at(0).t, T0); assert.equal(ring.at(3).t, later + 1);
});

test('runs find the orders of a window by blocks, oldest first, and skip blocks outside it', () => {
  const ring = new TapeRing(BLOCK * 4);
  ring.add(batch(0, T0, BLOCK), 1, 0);                  // block 0: T0 .. T0+4095
  ring.add(batch(1, T0 + 100_000, BLOCK), 1, 0);        // block 1
  ring.add(batch(2, T0 + 200_000, BLOCK), 1, 0);        // block 2
  assert.deepEqual(ring.runs(T0 + 100_000, T0 + 100_010), [[BLOCK, 2 * BLOCK]]);
  assert.deepEqual(ring.runs(T0, T0 + 300_000), [[0, 3 * BLOCK]], 'touching runs are joined');
  assert.deepEqual(ring.runs(T0 + 50_000, T0 + 60_000), []);
  ring.add(batch(3, T0 + 300_000, BLOCK + 5), 1, 0);    // wraps: block 0 now holds the newest five
  assert.deepEqual(ring.runs(T0 + 300_000 + BLOCK, T0 + 300_000 + BLOCK + 4), [[4 * BLOCK, 4 * BLOCK + 5]]);
  assert.deepEqual(ring.runs(T0, T0 + 10), [[5, BLOCK]], 'the oldest orders still held are found until they are overwritten');
});

test('the price line keeps each column\'s first, extremes and last price, by exchange time, whatever order they arrive in', () => {
  const ring = new TapeRing(BLOCK), trace = new TraceIndex();
  ring.add(packTape([order('a:X', T0 + 500, 100, 1), order('a:X', T0 + 100, 98, 1), order('a:X', T0 + 900, 99, 1, 'buy', 99, 103)], 0), 1, 0);
  trace.update(ring, T0, T0 + 10_000, 1_000);
  const runs = trace.path(0, Math.floor(T0 / 1_000), Math.floor(T0 / 1_000) + 9, 3), c = Math.floor(T0 / 1_000);
  // Open 98 (the earliest), close 99 (the latest): rising, so the low (98) comes before the high (103).
  assert.deepEqual(runs, [[c, 98, c, 98, c, 103, c, 99]]);
});

test('the price line breaks where a market traded nothing for the gap, and new orders are added without starting again', () => {
  const ring = new TapeRing(BLOCK), trace = new TraceIndex(), c = Math.floor(T0 / 1_000);
  ring.add(packTape([order('a:X', T0, 100, 1), order('a:X', T0 + 1_000, 101, 1), order('a:X', T0 + 6_000, 102, 1)], 0), 1, 0);
  trace.update(ring, T0, T0 + 20_000, 1_000);
  assert.equal(trace.path(0, c, c + 19, 3).length, 2, 'four empty columns break it');
  assert.equal(trace.path(0, c, c + 19, 5).length, 1);
  ring.add(packTape([order('a:X', T0 + 7_000, 103, 1)], 1), 1, 0);
  trace.update(ring, T0 + 50, T0 + 20_050, 1_000);
  assert.deepEqual(trace.path(0, c + 7, c + 7, 3), [[c + 7, 103, c + 7, 103]]);
});

test('the line from prices a second never carries a price over an empty second', () => {
  const prices = new Map([[10, 5], [11, 6], [15, 7]]), runs = secondsPath(s => prices.get(s) ?? 0, 10, 16, 1_000, 3);
  assert.deepEqual(runs, [[10, 5, 10, 5, 11, 6, 11, 6], [15, 7, 15, 7]]);
});

test('with the clock given, an order timed hours away from it is left out (one bad stamp must not move the time base every batch)', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(packTape([order('a:X', T0, 1, 1), order('a:X', 1_000, 1, 1), order('a:X', T0 + 7 * 3_600_000, 1, 1), order('a:X', T0 + 5, 1, 1)], 0), 1, 0, T0);
  assert.equal(ring.size, 2); assert.equal(ring.t0, T0); assert.deepEqual([ring.at(0).t, ring.at(1).t], [T0, T0 + 5]);
});

test('Live trades are on by default and read field by field from a saved page', () => {
  const d = readBubbles(undefined);
  assert.equal(d.live, true); assert.equal(d.venueLines, false); assert.equal(d.liveOpacity, 0.75);
  assert.deepEqual([readBubbles({ live: false }).live, readBubbles({ live: 'no' }).live], [false, true]);
  assert.equal(readBubbles({ liveOpacity: 5 }).liveOpacity, 1); assert.equal(readBubbles({ liveOpacity: 0.43 }).liveOpacity, 0.45);
  assert.equal(readBubbles({ venueLines: true }).venueLines, true);
});
