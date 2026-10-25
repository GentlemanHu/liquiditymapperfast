import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DepthRecorder, COLUMN_MS, type Column, type ColumnStore } from '../src/server/v2/recorder.mts';
import type { SideLevels } from '../src/server/v2/levels.mts';
import { SqliteColumnStore } from '../src/server/v2/store.mts';
import { encodeLt } from '../src/server/v2/wire.mts';
import { packLt } from '../src/shared/columns.ts';
import { LT_FIELDS, LT_HALF_LIVES, LT_LENGTH } from '../src/shared/lt-sample.ts';
import { ltWindows, validHalf, type LtMinute } from '../src/shared/lt-windows.ts';
import { decodeLt, type LtFrame } from '../src/app/wire.ts';
import { LT_BUSY_MS, LT_FORGET_MS, LT_REFRESH_MS, LT_RETRY_MS, LtLane, laneStepMs, mergeWindows, type LaneInstrument } from '../src/app/lt-lane.ts';
import { ltSeries, type LtStore } from '../src/app/lt.ts';

/**
 * The Liquidity Tracker lane: the tracker alone, asked for by the pane (`app/lt-lane.ts`), answered by the recorder from the minutes'
 * trackers without their books (`recorder.queryLt`). Its windows must be the numbers the columns path holds.
 */

const MIN = COLUMN_MS, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Math.floor(Date.UTC(2026, 9, 1, 0, 0) / DAY) * DAY;

let seed = 11;
const rnd = (): number => { seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff; return seed / 0x7fffffff; };

/** A minute with a random book and, for most, a tracker over every sample; some have one over part of them, some none. */
const columnAt = (t: number, base: number): Column => {
  const count = 3 + Math.floor(rnd() * 20), bins = new Int32Array(count), bid = new Float32Array(count), ask = new Float32Array(count);
  for (let i = 0, bin = base + Math.floor(rnd() * 10); i < count; i++, bin += 1 + Math.floor(rnd() * 3)) { bins[i] = bin; bid[i] = Math.round(rnd() * 5e5); ask[i] = Math.round(rnd() * 5e5); }
  const column: Column = { t, n: 1 + Math.floor(rnd() * 12), bins, bid, ask };
  const kind = rnd();
  if (kind < 0.75) { column.lt = Float32Array.from({ length: LT_LENGTH }, () => rnd() * 1e6); column.ltN = column.n; }
  else if (kind < 0.88 && column.n > 1) { column.lt = Float32Array.from({ length: LT_LENGTH }, () => Math.round(rnd() * 1e6)); column.ltN = 1 + Math.floor(rnd() * (column.n - 1)); }
  return column;
};

/** A store in memory that reads back; `lite`: it has `rangeLt` too, and counts what each kind of read took. */
class MemoryColumnStore implements ColumnStore {
  readonly rows = new Map<string, { id: string; column: Column; step: number }>();
  rangeReads = 0; rangeLtReads = 0;
  load(since: number) { return [...this.rows.values()].filter(r => r.column.t >= since).sort((a, b) => a.id.localeCompare(b.id) || a.column.t - b.column.t).map(r => ({ instrumentId: r.id, column: r.column, step: r.step })); }
  save(id: string, column: Column, step: number): void { this.rows.set(`${id}|${column.t}`, { id, column, step }); }
  prune(before: number): void { for (const [key, r] of this.rows) if (r.column.t < before) this.rows.delete(key); }
  range(id: string, from: number, to: number): Column[] {
    this.rangeReads++;
    return [...this.rows.values()].filter(r => r.id === id && r.column.t >= from && r.column.t < to).map(r => r.column).sort((a, b) => a.t - b.t);
  }
  extent(since: number) {
    const out = new Map<string, { first: number; last: number; step: number }>();
    for (const r of [...this.rows.values()].sort((a, b) => a.column.t - b.column.t)) {
      if (r.column.t < since) continue;
      const e = out.get(r.id); if (e) e.last = r.column.t; else out.set(r.id, { first: r.column.t, last: r.column.t, step: r.step });
    }
    return out;
  }
}
class LiteStore extends MemoryColumnStore {
  rangeLt(id: string, from: number, to: number): LtMinute[] {
    this.rangeLtReads++;
    return this.range(id, from, to).map(c => ({ t: c.t, n: c.n, ...(c.lt ? { lt: c.lt, ltN: c.ltN! } : {}) }));
  }
}
const holdingOnly = (store: MemoryColumnStore): ColumnStore => ({ load: s => store.load(s), save: (i, c, s) => store.save(i, c, s), prune: b => store.prune(b) });

/** What the columns path holds for the same windows: each merged column's start and its tracker's numbers for one half-life (NaN where `packLt` leaves it). */
function fromColumns(columns: Column[], half: number): { times: number[]; values: number[] } {
  const lt = packLt(columns), times: number[] = [], values: number[] = [];
  columns.forEach((c, k) => {
    times.push(c.t);
    for (let f = 0; f < LT_FIELDS; f++) values.push(lt ? lt[k * LT_LENGTH + half * LT_FIELDS + f]! : NaN);
  });
  return { times, values };
}

test('the tracker windows are the numbers the columns path holds: at every step and half-life, across what memory holds, with a minute open', () => {
  seed = 11;
  const NOW = T0 + 3 * DAY + 17 * MIN;
  for (const Lite of [false, true]) {
    const store = Lite ? new LiteStore() : new MemoryColumnStore();
    for (let t = T0; t < NOW - MIN; t += MIN) {
      if (!(t >= T0 + 30 * HOUR && t < T0 + 31 * HOUR)) store.save('a:BTC', columnAt(t, 4_000), 20);
      if (Math.floor(t / MIN) % 5 === 0) store.save('b:BTC', columnAt(t, 4_100), 20);
    }
    const now = () => NOW;
    const all = new DepthRecorder({ store: holdingOnly(store), now, retentionMs: 7 * DAY });
    const back = new DepthRecorder({ store, now, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
    const levels = (usd: number): SideLevels => ({ lo: Float64Array.of(85_000), hi: Float64Array.of(85_000), usd: Float64Array.of(usd) });
    for (const recorder of [all, back]) recorder.sample([{ instrumentId: 'a:BTC', venue: 'a', timestamp: NOW, coarse: false, bids: levels(70_000), asks: levels(40_000) }], NOW);
    const windows: [number, number, number][] = [
      [NOW - 2 * HOUR, NOW + MIN, MIN], [NOW - 9 * HOUR, NOW - 3 * HOUR, MIN], [T0 + 29 * HOUR + 13 * MIN, T0 + 33 * HOUR, 2 * MIN],
      [T0, NOW + MIN, 16 * MIN], [T0 - DAY, NOW + 2 * DAY, 64 * MIN], [T0 + 5 * HOUR + 7 * MIN, NOW - 7 * MIN, 4 * MIN], [NOW + HOUR, NOW + 2 * HOUR, 8 * MIN],
    ];
    let checked = 0, gaps = 0;
    for (const half of [0, 2, LT_HALF_LIVES.length - 1]) for (const [from, to, step] of windows) for (const id of ['a:BTC', 'b:BTC', 'none:X']) {
      const expected = fromColumns(all.query(id, from, to, step), half);
      for (const [name, recorder] of [['memory', all], ['read back', back]] as const) {
        const got = recorder.queryLt(id, from, to, step, half);
        assert.deepEqual(got.times, expected.times, `${Lite ? 'lite' : 'range'} ${name} ${id} ${(from - T0) / MIN}..${(to - T0) / MIN} at ${step / MIN}: starts`);
        assert.deepEqual(Array.from(got.values), expected.values, `${Lite ? 'lite' : 'range'} ${name} ${id} ${(from - T0) / MIN}..${(to - T0) / MIN} at ${step / MIN}: numbers`);
        checked += got.times.length; gaps += expected.values.filter(Number.isNaN).length / LT_FIELDS;
      }
    }
    assert.ok(checked > 500, `many windows compared, got ${checked}`);
    assert.ok(gaps > 0, 'some windows have no whole tracker, and are NaN as the columns leave them');
    if (Lite) assert.ok((store as LiteStore).rangeLtReads > 0, 'the store with rangeLt was read through it');
    else assert.equal((store as LiteStore).rangeLtReads, 0);
  }
});

test('read back again, the trackers of an hour already read are not read from the store', () => {
  seed = 12;
  const NOW = T0 + 2 * DAY, store = new LiteStore();
  for (let t = T0; t < NOW; t += MIN) store.save('a:BTC', columnAt(t, 4_000), 20);
  const recorder = new DepthRecorder({ store, now: () => NOW, retentionMs: 7 * DAY, memoryMs: 6 * HOUR });
  const first = recorder.queryLt('a:BTC', T0, T0 + DAY, 16 * MIN, 2);
  const reads = store.rangeLtReads;
  assert.ok(reads > 0 && reads <= 24 + 1, `a day is read hour by hour at most, got ${reads}`);
  const again = recorder.queryLt('a:BTC', T0, T0 + DAY, 64 * MIN, 5), third = recorder.queryLt('a:BTC', T0, T0 + DAY, 16 * MIN, 2);
  assert.equal(store.rangeLtReads, reads, 'another step and half-life, and the same again: from what is kept');
  assert.deepEqual(third, first);
  assert.ok(again.times.length < first.times.length);
});

test('the SQLite store reads the trackers alone as it reads the columns: the same minutes, the same trackers, a broken row left out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-lane-'));
  const file = path.join(dir, 'depth.sqlite');
  let store: SqliteColumnStore | null = null;
  try {
    store = new SqliteColumnStore(file);
    seed = 13;
    for (let i = 0; i < 70; i++) store.save('a:BTC', columnAt(T0 + i * MIN, 4_000), 20);
    // A row whose books are not whole (neither `range` nor `rangeLt` takes it), and a tracker of another length (taken as no tracker).
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO depth_columns (inst, t, n, step, data) VALUES (?, ?, ?, ?, ?)').run('a:BTC', T0 + 70 * MIN, 3, 20, new Uint8Array(13));
    raw.prepare('INSERT INTO depth_columns (inst, t, n, step, data) VALUES (?, ?, ?, ?, ?)').run('a:BTC', T0 + 71 * MIN, 3, 20, new Uint8Array(12));
    raw.prepare('INSERT INTO depth_lt (inst, t, n, data) VALUES (?, ?, ?, ?)').run('a:BTC', T0 + 71 * MIN, 3, new Uint8Array(8));
    raw.close();
    const columns = store.range('a:BTC', T0, T0 + 80 * MIN), minutes = store.rangeLt('a:BTC', T0, T0 + 80 * MIN);
    assert.equal(minutes.length, columns.length);
    assert.equal(minutes.length, 71, 'the broken row is not among them');
    // The trackers of an hour share a buffer of their own: an hour let go of lets go of its bytes, whichever of the others is kept.
    const inHour = (h: number) => minutes.filter(m => m.lt && Math.floor((m.t - T0) / HOUR) === h);
    assert.ok(inHour(0).length > 10 && inHour(1).length > 3);
    assert.equal(new Set(inHour(0).map(m => m.lt!.buffer)).size, 1);
    assert.equal(new Set(inHour(1).map(m => m.lt!.buffer)).size, 1);
    assert.notEqual(inHour(0)[0]!.lt!.buffer, inHour(1)[0]!.lt!.buffer);
    assert.equal(inHour(0)[0]!.lt!.buffer.byteLength, inHour(0).length * LT_LENGTH * 4, 'the buffer holds that hour and no more');
    columns.forEach((c, k) => {
      const m = minutes[k]!;
      assert.deepEqual([m.t, m.n, m.ltN], [c.t, c.n, c.ltN], `minute ${k}`);
      assert.deepEqual(m.lt ? Array.from(m.lt) : undefined, c.lt ? Array.from(c.lt) : undefined, `tracker ${k}`);
    });
    assert.deepEqual(store.rangeLt('a:BTC', T0 + 10 * MIN, T0 + 10 * MIN), []);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a window is NaN unless its tracker covers every sample of its minutes, and the half-life picks its four numbers', () => {
  const lt = (base: number): Float32Array => Float32Array.from({ length: LT_LENGTH }, (_, i) => base + i);
  const minutes: LtMinute[] = [
    { t: 0, n: 4, lt: lt(100), ltN: 4 }, { t: MIN, n: 2, lt: lt(200), ltN: 2 },
    { t: 4 * MIN, n: 3, lt: lt(300), ltN: 2 },
    { t: 8 * MIN, n: 3, lt: lt(400), ltN: 3 }, { t: 9 * MIN, n: 3 },
  ];
  const out = ltWindows(minutes, 4 * MIN, 1);
  assert.deepEqual(out.times, [0, 4 * MIN, 8 * MIN]);
  const at = LT_FIELDS * 1;
  const whole = [0, 1, 2, 3].map(k => (lt(100)[at + k]! * 4 + lt(200)[at + k]! * 2) / 6);
  assert.deepEqual(Array.from(out.values.slice(0, 4)), Array.from(Float32Array.from(whole)), 'the minutes of a window weighed by their samples');
  assert.ok(Array.from(out.values.slice(4, 8)).every(Number.isNaN), 'a tracker over two of three samples');
  assert.ok(Array.from(out.values.slice(8, 12)).every(Number.isNaN), 'a minute with none');
  assert.deepEqual(ltWindows([], MIN, 0), { times: [], values: new Float32Array(0) });
  assert.equal(validHalf(0) && validHalf(LT_HALF_LIVES.length - 1), true);
  assert.deepEqual([validHalf(-1), validHalf(LT_HALF_LIVES.length), validHalf(1.5), validHalf('2')], [false, false, false, false]);
});

test('a part of a tracker answer goes through its frame whole: starts, numbers, NaN, and the last marked done', () => {
  const windows = { times: [0, 4 * MIN, 8 * MIN], values: Float32Array.of(1, 2, 3, 4, NaN, NaN, NaN, NaN, 5, 6, 7, 8) };
  const buffer = encodeLt(7, 0, 12 * MIN, 4 * MIN, 2, true, [{ instrumentId: 'a:BTC', windows }, { instrumentId: 'b:BTC', windows: { times: [], values: new Float32Array(0) } }]);
  const frame = decodeLt(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
  assert.deepEqual([frame.id, frame.from, frame.to, frame.stepMs, frame.half, frame.done], [7, 0, 12 * MIN, 4 * MIN, 2, true]);
  assert.deepEqual(frame.instruments.map(i => i.id), ['a:BTC', 'b:BTC']);
  assert.deepEqual(Array.from(frame.instruments[0]!.times), windows.times);
  assert.deepEqual(Array.from(frame.instruments[0]!.values), Array.from(windows.values));
  assert.equal(frame.instruments[1]!.times.length, 0);
  const notDone = encodeLt(8, 0, MIN, MIN, 0, false, []);
  assert.equal(decodeLt(notDone.buffer.slice(notDone.byteOffset, notDone.byteOffset + notDone.byteLength) as ArrayBuffer).done, false);
  assert.throws(() => decodeLt(new ArrayBuffer(8)), /Malformed|header/);
});

test('windows held are replaced over the span of a part and kept outside it, in order', () => {
  const held = { times: [0, 1, 2, 3], values: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3] };
  const out = mergeWindows(held, 1, 3, [1, 2], [9, 9, 9, 9, 8, 8, 8, 8]);
  assert.deepEqual(out.times, [0, 1, 2, 3]);
  assert.deepEqual(out.values, [0, 0, 0, 0, 9, 9, 9, 9, 8, 8, 8, 8, 3, 3, 3, 3]);
  assert.deepEqual(mergeWindows(held, 1, 3, [], []).times, [0, 3], 'a part that holds nothing for its span empties it');
  assert.deepEqual(mergeWindows(undefined, 0, 9, [5], [1, 2, 3, 4]), { times: [5], values: [1, 2, 3, 4] });
});

test('the lane takes about two pixels a window, in steps that double', () => {
  assert.equal(laneStepMs(HOUR, 1500), MIN, 'an hour is a window a minute');
  assert.equal(laneStepMs(DAY, 1500), 2 * MIN);
  assert.equal(laneStepMs(7 * DAY, 1500), 16 * MIN);
  assert.equal(laneStepMs(7 * DAY, 750), 32 * MIN);
  assert.equal(laneStepMs(10, 1500), MIN, 'never finer than a minute');
});

/** The lane against a source that answers when told to. */
function laneRig(startClock = T0 + 10 * DAY) {
  const rig = {
    clock: startClock,
    calls: [] as { ids: string[]; from: number; to: number; stepMs: number; half: number; signal: AbortSignal | undefined; onFrame(frame: LtFrame): void; resolve(): void; reject(error: Error): void }[],
    published: [] as { stepMs: number; half: number; instruments: LaneInstrument[] }[], changed: 0,
    lane: undefined as unknown as LtLane,
  };
  rig.lane = new LtLane((ids, from, to, stepMs, half, onFrame, signal) => new Promise<void>((resolve, reject) => rig.calls.push({ ids, from, to, stepMs, half, signal, onFrame, resolve, reject })),
    (stepMs, half, instruments) => rig.published.push({ stepMs, half, instruments }), () => rig.clock, () => { rig.changed++; });
  return rig;
}
/** A frame with one window a step over [from, to) for each id. */
const frameOf = (call: { from: number; to: number; stepMs: number; half: number }, ids: string[], done = true): LtFrame => {
  const times: number[] = []; for (let t = Math.ceil(call.from / call.stepMs) * call.stepMs; t < call.to; t += call.stepMs) times.push(t);
  return { id: 1, from: call.from, to: call.to, stepMs: call.stepMs, half: call.half, done, instruments: ids.map(id => ({ id, times: Float64Array.from(times), values: Float32Array.from(times.flatMap(t => [t, t, 1, 1])) })) };
};
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('the lane asks once for what is missing, once at a time, and not again for what it holds', async () => {
  const rig = laneRig(), view = { t0: T0 + 4 * DAY, t1: T0 + 6 * DAY };
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  assert.equal(rig.calls.length, 1);
  const first = rig.calls[0]!;
  assert.deepEqual(first.ids, ['a', 'b']);
  assert.equal(first.stepMs, laneStepMs(2 * DAY, 1500));
  assert.equal(first.half, LT_HALF_LIVES.indexOf(10));
  assert.ok(first.from <= view.t0 - 2 * DAY + first.stepMs && first.from % first.stepMs === 0, 'a view of margin on the left');
  assert.ok(first.to >= view.t1 + DAY - first.stepMs && first.to <= rig.clock + MIN, 'half a view on the right');
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  assert.equal(rig.calls.length, 1, 'one question at a time');
  assert.equal(rig.lane.holds, false);
  first.onFrame(frameOf(first, ['a', 'b']));
  assert.equal(rig.lane.holds, true);
  assert.equal(rig.published.at(-1)!.instruments.length, 2, 'what came is handed to the worker as it comes');
  first.resolve(); await settle();
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  assert.equal(rig.calls.length, 1, 'held: nothing asked');
  // A venue that comes and goes: only a new one is asked, and one that came back is held still.
  rig.lane.ensure(['a', 'b', 'c'], view, 1500, 10);
  assert.deepEqual(rig.calls[1]!.ids, ['c']);
  rig.calls[1]!.onFrame(frameOf(rig.calls[1]!, ['c'])); rig.calls[1]!.resolve(); await settle();
  rig.lane.ensure(['a', 'b'], view, 1500, 10); rig.lane.ensure(['a', 'b', 'c'], view, 1500, 10); rig.lane.ensure(['b', 'c'], view, 1500, 10);
  assert.equal(rig.calls.length, 2, 'a venue away and back costs nothing');
  assert.deepEqual(rig.published.at(-1)!.instruments.map(i => i.id).sort(), ['a', 'b', 'c']);
});

test('a pan asks for the stretch it uncovers; another step or half-life gives up the question under way and starts again', async () => {
  const rig = laneRig(), view = { t0: T0 + 4 * DAY, t1: T0 + 5 * DAY };
  rig.lane.ensure(['a'], view, 1500, 10);
  const first = rig.calls[0]!; first.onFrame(frameOf(first, ['a'])); first.resolve(); await settle();
  const moved = { t0: view.t0 - 2 * DAY, t1: view.t1 - 2 * DAY };
  rig.lane.ensure(['a'], moved, 1500, 10);
  const pan = rig.calls[1]!;
  assert.equal(pan.to, first.from, 'to where what is held begins');
  assert.ok(pan.from < first.from && pan.from % pan.stepMs === 0);
  pan.resolve(); await settle();
  // A zoom that changes the step: what is held means something else; the question under way is told to stop.
  rig.lane.ensure(['a'], { t0: view.t0, t1: view.t0 + 6 * DAY }, 1500, 10);
  const zoom = rig.calls[2]!;
  assert.notEqual(zoom.stepMs, first.stepMs);
  assert.equal(rig.lane.holds, false, 'held windows of another step are let go');
  assert.equal(rig.published.at(-1)!.instruments.length, 0, 'and the worker is told');
  rig.lane.ensure(['a'], { t0: view.t0, t1: view.t0 + 6 * DAY }, 1500, 25);
  assert.equal(zoom.signal!.aborted, true, 'another half-life: the question under way is given up');
  assert.equal(rig.calls[3]!.half, LT_HALF_LIVES.indexOf(25));
  zoom.reject(new Error('cancelled')); await settle();
  assert.equal(rig.lane.usable, true, 'a question it gave up itself is not a failure');
});

test('while the view reaches the present the newest windows are asked again, from where they were final', async () => {
  const rig = laneRig(), view = () => ({ t0: rig.clock - DAY, t1: rig.clock + HOUR });
  rig.lane.ensure(['a'], view(), 1500, 10);
  const first = rig.calls[0]!; first.onFrame(frameOf(first, ['a'])); first.resolve(); await settle();
  rig.clock += LT_REFRESH_MS - 1; rig.lane.ensure(['a'], view(), 1500, 10);
  assert.equal(rig.calls.length, 1, 'not yet');
  rig.clock += 2; rig.lane.ensure(['a'], view(), 1500, 10);
  const tail = rig.calls[1]!;
  assert.deepEqual(tail.ids, ['a']);
  assert.ok(tail.from > first.from + HOUR && tail.from <= rig.clock - 2 * MIN, `the tail only, from ${(tail.from - first.from) / MIN} min after the start`);
  tail.resolve(); await settle();
  // A view in the past is final: it is never asked again.
  const past = laneRig(), old = { t0: T0, t1: T0 + 2 * HOUR };
  past.lane.ensure(['a'], old, 1500, 10); past.calls[0]!.onFrame(frameOf(past.calls[0]!, ['a'])); past.calls[0]!.resolve(); await settle();
  past.clock += 10 * 60_000; past.lane.ensure(['a'], old, 1500, 10);
  assert.equal(past.calls.length, 1);
});

test('a lane that failed is not read until it holds something, and asks again a little later; one that holds something goes on drawing it', async () => {
  const rig = laneRig(), view = { t0: T0 + 5 * DAY, t1: T0 + 6 * DAY };
  rig.lane.ensure(['a'], view, 1500, 10);
  rig.calls[0]!.reject(new Error('unsupported')); await settle();
  assert.equal(rig.lane.usable, false, 'nothing held and a failure: the pane reads the columns');
  rig.lane.ensure(['a'], view, 1500, 10);
  assert.equal(rig.calls.length, 1, 'not at once');
  rig.clock += LT_RETRY_MS + 1; rig.lane.ensure(['a'], view, 1500, 10);
  assert.equal(rig.calls.length, 2);
  const retry = rig.calls[1]!; retry.onFrame(frameOf(retry, ['a'], false));
  assert.equal(rig.lane.usable, true, 'a part came');
  retry.reject(new Error('live-closed')); await settle();
  assert.equal(rig.lane.usable, true, 'it holds something: it is drawn, and asked again later');
  assert.equal(new LtLane(undefined, () => {}, () => 0, () => {}).available, false, 'a source with no lane has none');
  assert.equal(new LtLane(undefined, () => {}, () => 0, () => {}).usable, false);
});

test('a part for another step than the one on screen is let go', async () => {
  const rig = laneRig(), view = { t0: T0 + 5 * DAY, t1: T0 + 6 * DAY };
  rig.lane.ensure(['a'], view, 1500, 10);
  const call = rig.calls[0]!;
  call.onFrame({ ...frameOf(call, ['a']), stepMs: call.stepMs * 2 });
  call.onFrame({ ...frameOf(call, ['a']), half: call.half + 1 });
  assert.equal(rig.lane.holds, false);
  call.onFrame(frameOf(call, ['a']));
  assert.equal(rig.lane.holds, true);
});

test('the tracker alone adds up as the columns do, a gap draws nothing, and a venue with no whole window leaves the others', () => {
  const half = LT_HALF_LIVES.indexOf(10), at = half * LT_FIELDS;
  const lt = (bid: number, ask: number, wb: number, wa: number): Float32Array => { const v = new Float32Array(LT_LENGTH); v.set([bid, ask, wb, wa], at); return v; };
  const columns: LtStore = { step: 1, times: [0, MIN], counts: [0, 0], bins: [], bid: [], ask: [], lt: Float32Array.from([...lt(100, 50, 2, 1), ...lt(300, 70, 3, 2)]) };
  const lane = (values: number[]): LtStore => ({ step: 0, times: [0, MIN], counts: new Uint32Array(2), bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0), lt: Float32Array.from(values), ltStride: LT_FIELDS });
  const params = { halfLifeBp: 10, minUsd: 0, maxUsd: 0, average: false };
  const viaColumns = ltSeries([columns], 0, 2 * MIN, MIN, params);
  const viaLane = ltSeries([lane([100, 50, 2, 1, 300, 70, 3, 2])], 0, 2 * MIN, MIN, params);
  assert.deepEqual(Array.from(viaLane.times), Array.from(viaColumns.times));
  assert.deepEqual(Array.from(viaLane.bid), Array.from(viaColumns.bid));
  assert.deepEqual(Array.from(viaLane.ask), Array.from(viaColumns.ask));
  assert.equal(viaLane.estimated, false);
  const two = ltSeries([lane([100, 50, 2, 1, NaN, NaN, NaN, NaN]), lane([10, 5, 1, 1, 30, 7, 3, 2])], 0, 2 * MIN, MIN, params);
  assert.deepEqual(Array.from(two.bid), [110, 30], 'a venue with a gap adds nothing at that window');
  const gapOnly = ltSeries([lane([NaN, NaN, NaN, NaN, 300, 70, 3, 2])], 0, 2 * MIN, MIN, params);
  assert.deepEqual(Array.from(gapOnly.times), [MIN], 'a window nobody covers is not a zero');
  const averaged = ltSeries([lane([100, 50, 2, 1, 300, 70, 3, 2])], 0, 2 * MIN, MIN, { ...params, average: true });
  assert.deepEqual(Array.from(averaged.bid), [50, 100]);
});

test('a frame whose parts are not the kinds its header promises is refused, not read as other numbers', () => {
  const good = encodeLt(1, 0, MIN, MIN, 0, true, [{ instrumentId: 'a:BTC', windows: { times: [0], values: Float32Array.of(1, 2, 3, 4) } }]);
  const view = new DataView(good.buffer, good.byteOffset, good.byteLength);
  const json = new TextDecoder().decode(good.subarray(4, 4 + view.getUint32(0, true)));
  assert.match(json, /"kind":"f64"/);
  // The same bytes with the times declared f32 (twice the length of numbers) and the same header length: a decoder that trusts lengths alone reads garbage.
  const swapped = Buffer.from(good); const at = 4 + json.indexOf('"kind":"f64"') + '"kind":"'.length;
  swapped.write('f32', at);
  assert.throws(() => decodeLt(swapped.buffer.slice(swapped.byteOffset, swapped.byteOffset + swapped.byteLength) as ArrayBuffer), /Malformed tracker frame/);
});

test('the pane reads the lane unless it cannot, and a lane that failed holding nothing is asked again when its wait is over, without anyone reading it', async () => {
  // The pane's own call (`serve`) is what runs at every frame: a lane read only where it was usable could never be tried again (reviewed 2026-10-24).
  const rig = laneRig(), view = { t0: T0 + 5 * DAY, t1: T0 + 6 * DAY };
  assert.equal(rig.lane.serve(['a'], view, 1500, 10, true), false, 'a size filter: the columns');
  assert.equal(rig.lane.serve(['a'], view, 1500, 7, false), false, 'a half-life the tracker is not kept for: the columns');
  assert.equal(rig.calls.length, 0, 'and nothing is asked for either');
  assert.equal(new LtLane(undefined, () => {}, () => 0, () => {}).serve(['a'], view, 1500, 10, false), false, 'a source with no lane');
  assert.equal(rig.lane.serve(['a'], view, 1500, 10, false), true, 'asked: the lane, while it has not failed');
  rig.calls[0]!.reject(new Error('unsupported')); await settle();
  assert.equal(rig.lane.serve(['a'], view, 1500, 10, false), false, 'failed with nothing held: the columns');
  assert.equal(rig.calls.length, 1, 'its wait is not over');
  rig.clock += LT_RETRY_MS + 1;
  assert.equal(rig.lane.serve(['a'], view, 1500, 10, false), false, 'asked again at once, not yet answered: still the columns');
  assert.equal(rig.calls.length, 2, 'the pane asked it again, though it was not being read');
  rig.calls[1]!.onFrame(frameOf(rig.calls[1]!, ['a'], false));
  assert.equal(rig.lane.serve(['a'], view, 1500, 10, false), true, 'it holds something: the lane');
  // A failure is known across a zoom: the pane does not show an empty lane at every step on a server that cannot answer.
  const old = laneRig();
  old.lane.serve(['a'], view, 1500, 10, false); old.calls[0]!.reject(new Error('unsupported')); await settle();
  const zoomed = { t0: view.t0, t1: view.t0 + 6 * DAY };
  assert.equal(old.lane.serve(['a'], zoomed, 1500, 10, false), false, 'another step: the columns still, and it is asked at once');
  assert.equal(old.calls.length, 2);
});

test('the server limit is a short wait and no failure; a wait that ends is announced, so a view that stands still tries again', async () => {
  const rig = laneRig(), view = { t0: T0 + 5 * DAY, t1: T0 + 6 * DAY };
  rig.lane.serve(['a'], view, 1500, 10, false);
  const before = rig.changed;
  rig.calls[0]!.reject(new Error('too many tracker questions at once')); await settle();
  assert.equal(rig.lane.usable, true, 'not a failure');
  rig.clock += LT_BUSY_MS - 1; rig.lane.serve(['a'], view, 1500, 10, false);
  assert.equal(rig.calls.length, 1, 'a short wait');
  rig.clock += 2; rig.lane.serve(['a'], view, 1500, 10, false);
  assert.equal(rig.calls.length, 2);
  assert.ok(rig.changed > before, 'the pane was told');
});

test('filling a gap on the left leaves the newest windows as final, and as fresh, as they were: the next refresh asks for the tail only', async () => {
  const rig = laneRig(), view = () => ({ t0: rig.clock - DAY, t1: rig.clock + HOUR });
  rig.lane.serve(['a'], view(), 1500, 10, false);
  const first = rig.calls[0]!; first.onFrame(frameOf(first, ['a'])); first.resolve(); await settle();
  rig.clock += 5_000;
  // A pan left within the same step: only the gap is asked.
  const left = { t0: view().t0 - DAY / 2, t1: view().t1 - DAY / 2 };
  rig.lane.serve(['a'], left, 1500, 10, false);
  const gap = rig.calls[1]!;
  assert.equal(gap.to, first.from, 'the gap on the left only');
  gap.resolve(); await settle();
  rig.clock += LT_REFRESH_MS;
  rig.lane.serve(['a'], view(), 1500, 10, false);
  const tail = rig.calls[2]!;
  assert.ok(tail.from > rig.clock - 3 * HOUR, `the refresh asks for the newest windows, not the whole held span: from ${(rig.clock - tail.from) / MIN} min ago`);
});

test('markets the pane has not asked about for a long while are let go, and a venue that comes back soon costs nothing', async () => {
  const rig = laneRig(), view = { t0: T0 + 5 * DAY, t1: T0 + 6 * DAY };
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  rig.calls[0]!.onFrame(frameOf(rig.calls[0]!, ['a', 'b'])); rig.calls[0]!.resolve(); await settle();
  rig.clock += LT_FORGET_MS - 1_000; rig.lane.ensure(['a'], view, 1500, 10);
  assert.deepEqual(rig.published.at(-1)!.instruments.map(i => i.id).sort(), ['a', 'b'], 'b is held still');
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  assert.equal(rig.calls.length, 1, 'b back within the time: not asked again');
  rig.clock += LT_FORGET_MS + 1_000; rig.lane.ensure(['a'], view, 1500, 10);
  rig.lane.ensure(['a', 'b'], view, 1500, 10);
  assert.deepEqual(rig.calls[1]!.ids, ['b'], 'b was let go and is asked for again');
});
