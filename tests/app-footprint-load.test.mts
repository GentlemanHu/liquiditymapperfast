import test from 'node:test';
import assert from 'node:assert/strict';
import { FOOTPRINT_BUDGET, FOOTPRINT_REFRESH_MS, FootprintData, FootprintLod, SUMS_ROW_STEP, footprintWant, readBar, rowCellAt, rowCellLines, venueOrderOf } from '../src/app/panes/footprint.ts';
import type { FootprintResponse } from '../src/app/source.ts';

const H = 3_600_000;
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A source holding one bar an hour that answers at most `per` bars a question, newest first, and says where it started; every question logged. */
function source(per: number) {
  const asked: { from: number; to: number; budget: number }[] = [], answered: number[] = [];
  const load = async (_inst: string, _tf: string, from: number, to: number, _rows: number, _cuts: readonly number[], budget: number): Promise<FootprintResponse> => {
    asked.push({ from, to, budget });
    const bars = [];
    for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < per; t -= H) bars.unshift({ t, rows: [[100, t / H, 1]] as [number, number, number][], buyUsd: t / H, sellUsd: 1, minutes: 60 });
    answered.push(...bars.map(bar => bar.t));
    return { step: 5, fine: 5, bars, from: bars.length ? bars[0]!.t : from };
  };
  return { asked, answered, load };
}

/** performance.now as the test says, for the refresh interval. */
function clock(start: number) {
  let now = start; const real = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  return { advance: (ms: number) => { now += ms; }, restore: () => Object.defineProperty(performance, 'now', { value: real, configurable: true, writable: true }) };
}

test('a long view comes in slices, newest first, each bar asked for once; then only the bars that can still change, every refresh', async () => {
  const time = clock(1_000_000);
  try {
    const { asked, answered, load } = source(5), data = new FootprintData(), view = { t0: 10 * H, t1: 20 * H, p0: 0, p1: 1 };
    const sourceNow = 20 * H + 30 * 60_000;
    const step = async () => { data.ensure('a,b', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    assert.deepEqual(asked[0], { from: 9 * H, to: 21 * H, budget: 5_000 }, 'the whole view with its margin, within the budget');
    assert.deepEqual([...data.bars.keys()], [16, 17, 18, 19, 20].map(h => h * H), 'the newest part first');
    await step(); await step(); await step();
    assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H]), [[9, 16], [9, 11]], 'then older slices until the view is covered, and nothing more');
    assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    assert.equal(new Set(answered).size, answered.length, 'no bar is merged twice: each slice starts where the last one reached');

    time.advance(FOOTPRINT_REFRESH_MS);
    await step();
    assert.deepEqual([asked.at(-1)!.from / H, asked.at(-1)!.to / H], [20, 21], 'the refresh asks for the open bar alone: the ones before it are settled');
    assert.equal(data.bars.size, 12);
    await step();
    assert.equal(asked.length, 4, 'and not again before the next refresh');

    // A view wholly in the past asks nothing on the clock once it is held.
    const past = { t0: 2 * H, t1: 6 * H, p0: 0, p1: 1 }, before = asked.length;
    for (let i = 0; i < 3; i++) { data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn(); }
    time.advance(FOOTPRINT_REFRESH_MS * 3);
    data.ensure('a,b', '1h', past, 5, load, () => {}, [], sourceNow); await turn();
    assert.deepEqual(asked.slice(before).map(a => [a.from / H, a.to / H]), [[1, 7], [1, 2]], 'its bars in two slices, then nothing');
  } finally { time.restore(); }
});

test('before the markets\' step is known it is asked alone, and the view is then asked on the drawn rows, never on the finest', async () => {
  const asked: { from: number; to: number; rows: number; cuts: number; budget: number; venues: boolean }[] = [];
  const load = async (_i: string, _tf: string, from: number, to: number, rows: number, cuts: readonly number[], budget: number, venues: boolean): Promise<FootprintResponse> => {
    asked.push({ from, to, rows, cuts: cuts.length, budget, venues });
    const bars = []; for (let t = Math.ceil(from / H) * H; t + H <= to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
    return { step: rows > 0 ? rows : 0.5, fine: 0.5, bars };
  };
  // As the heat pane does: the row size from the step known before the look (rows 128 times the recorded step at this zoom).
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  const look = async (tf = '1h') => { data.ensure('a,b', tf, view, data.fine > 0 ? data.fine * 128 : 0, load, () => {}, [100_000], 20 * H); await turn(); };
  await look();
  assert.deepEqual(asked, [{ from: 0, to: 1, rows: 0, cuts: 0, budget: 0, venues: false }], 'the step first, from a window that holds nothing');
  assert.equal(data.fine, 0.5);
  assert.equal(data.bars.size, 0, 'and no bars from it');
  await look();
  assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H, a.rows, a.venues]), [[9, 13, 64, true]], 'then the view once, on the rows drawn');
  assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12]);
  await look('4h');
  assert.deepEqual(asked.slice(2).map(a => a.rows), [64], 'another timeframe of the same markets is asked on the rows at once');

  // Markets with nothing recorded have no step: asked it once, then as before (an empty answer), and not again on every look.
  const none: number[][] = [];
  const empty = async (_i: string, _tf: string, from: number, to: number, rows: number): Promise<FootprintResponse> => { none.push([from, to, rows]); return { step: 0, fine: 0, bars: [] }; };
  const fresh = new FootprintData();
  for (let i = 0; i < 4; i++) { fresh.ensure('c', '1h', view, 0, empty, () => {}, [], 20 * H); await turn(); }
  assert.deepEqual(none, [[0, 1, 0], [9 * H, 13 * H, 0]]);
});

test('another row size asks again from the view, and an old source that answers the whole window is taken whole', async () => {
  const asked: number[][] = [];
  const whole = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
    asked.push([from / H, to / H]);
    const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
    return { step: 5, fine: 5, bars };
  };
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  data.ensure('a', '1h', view, 5, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked, [[9, 13]], 'no `from` in the answer: the whole window was answered');
  data.ensure('a', '1h', view, 10, whole, () => {}, [], 0); await turn();
  assert.deepEqual(asked.at(-1), [9, 13]);
  assert.equal(asked.length, 2);
});

test('a view with more bars than are held for long is not asked for again on every look, and panning right through the past asks from the held end', async () => {
  const time = clock(5_000_000);
  try {
    const M = 60_000, asked: number[][] = [];
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push([from, to]);
      const bars = []; for (let t = from; t < to; t += M) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 1 });
      return { step: 5, fine: 5, bars };
    };
    const data = new FootprintData(), wide = { t0: 0, t1: 4_000 * M, p0: 0, p1: 1 };
    for (let i = 0; i < 4; i++) { data.ensure('a', '1m', wide, 5, load, () => {}, [], 10 * 86_400_000); await turn(); }
    assert.equal(asked.length, 1, 'more than 3 000 bars in view, all past: one question, then none');
    assert.equal(data.bars.size, 4_002);

    // Hourly bars held for [9h, 13h) with the source at 30h; the view moves to [12h, 15h).
    const hourly: number[][] = [];
    const loadH = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      hourly.push([from / H, to / H]);
      const bars = []; for (let t = from; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 });
      return { step: 5, fine: 5, bars };
    };
    const past = new FootprintData();
    past.ensure('a', '1h', { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    past.ensure('a', '1h', { t0: 12 * H, t1: 14 * H, p0: 0, p1: 1 }, 5, loadH, () => {}, [], 30 * H); await turn();
    assert.deepEqual(hourly, [[9, 13], [13, 15]], 'the bars after the held ones, not from the settled time far beyond them');
    assert.deepEqual([...past.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14]);

    past.clear();
    assert.equal(past.bars.size, 0, 'no markets to count: no bars');
  } finally { time.restore(); }
});

test('the bars held are said to be those of the markets and timeframe asked last, or of none once cleared', () => {
  const data = new FootprintData(), { load } = source(100), view = { t0: 10 * H, t1: 20 * H, p0: 0, p1: 1 };
  assert.equal(data.holds([], '1h'), true, 'nothing asked yet: no markets');
  assert.equal(data.holds(['a', 'b'], '1h'), false);
  data.ensure('a,b', '1h', view, 5, load, () => {}, [], 30 * H);
  assert.equal(data.holds(['a', 'b'], '1h'), true);
  assert.equal(data.holds(['a'], '1h'), false, 'other markets: the bars are not theirs yet');
  assert.equal(data.holds(['a', 'b'], '5m'), false, 'another timeframe');
  data.clear();
  assert.deepEqual([data.holds([], '1h'), data.holds(['a', 'b'], '1h')], [true, false], 'every venue off: the cleared bars are the none counted');
});

test('venue rows read as ids whatever each answer\'s order, a malformed one is left out whole, and the order follows the volume held', () => {
  const row = [[100, 30, 5], [105, 2, 9]] as [number, number, number][];
  const a = readBar({ t: 0, rows: row, buyUsd: 32, sellUsd: 14, venueRows: [[0, 20, 5, 1, 10, 0], [1, 2, 9]] }, 0, ['binance:BTCUSDT', 'bybit:BTCUSDT']);
  const b = readBar({ t: H, rows: row, buyUsd: 32, sellUsd: 14, venueRows: [[1, 20, 5, 0, 10, 0], [0, 2, 9]] }, 0, ['okx:BTC-USDT-SWAP', 'binance:BTCUSDT']);
  assert.deepEqual(a.parts, [[['binance:BTCUSDT', 20, 5], ['bybit:BTCUSDT', 10, 0]], [['bybit:BTCUSDT', 2, 9]]]);
  assert.deepEqual(b.parts?.[0]?.[0], ['binance:BTCUSDT', 20, 5], 'the place in its own answer\'s list');
  assert.equal('venueRows' in a, false, 'held as ids only');
  for (const bad of [[[5, 1, 1], []], [[0, 1], []], [[0, -1, 1], []], [[0, 1, 1]]])
    assert.equal(readBar({ t: 0, rows: row, buyUsd: 0, sellUsd: 0, venueRows: bad as number[][] }, 0, ['binance:BTCUSDT']).parts, undefined, JSON.stringify(bad));
  assert.deepEqual(venueOrderOf([a, b]), ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP']);
});

test('a row\'s popup names its venues, the most volume first, with what each sold, bought and its delta', () => {
  const bar = readBar({ t: 0, rows: [[100, 31, 15]], buyUsd: 31, sellUsd: 15, venueRows: [[0, 20e3, 5e3, 1, 10e3, 0, 2, 1e3, 10e3]] }, 0, ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP']);
  const cell = rowCellAt(bar, 5, 102)!;
  const lines = rowCellLines(cell, bar, 5, '1h', undefined, 3).filter(l => l.mark);
  assert.deepEqual(lines.map(l => l.mark), ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bybit:BTCUSDT']);
  assert.deepEqual(lines.map(l => l.color), ['buy', 'sell', 'buy']);
});

test('a row only one market traded still says whose it is, and a short pane names fewer venues and puts the rest together', () => {
  const one = readBar({ t: 0, rows: [[100, 5e3, 0]], buyUsd: 5e3, sellUsd: 0, venueRows: [[0, 5e3, 0]] }, 0, ['bybit:BTCUSDT']);
  assert.deepEqual(rowCellLines(rowCellAt(one, 5, 101)!, one, 5, '1h', undefined, 3).filter(l => l.mark).map(l => l.mark), ['bybit:BTCUSDT']);
  const many = readBar({ t: 0, rows: [[100, 30e3, 6e3]], buyUsd: 30e3, sellUsd: 6e3, venueRows: [[0, 10e3, 1e3, 1, 9e3, 2e3, 2, 8e3, 3e3, 3, 3e3, 0]] }, 0, ['a:X', 'b:X', 'c:X', 'd:X']);
  const short = rowCellLines(rowCellAt(many, 5, 101)!, many, 5, '1h', undefined, 4, 1);
  assert.deepEqual(short.filter(l => l.mark).map(l => l.mark), ['a:X']);
  assert.ok(short.some(l => l.label === '3 more venues'), 'the rest together');
  const none = rowCellLines(rowCellAt(many, 5, 101)!, many, 5, '1h', undefined, 4, -1);
  assert.equal(none.length, rowCellLines({ ...rowCellAt(many, 5, 101)!, parts: undefined }, many, 5, '1h', undefined, 4).length, 'too short even for that: the box as it was before venues');
});

test('settled bars still without the sums of the size lines asked are asked again once a minute, a few times, until the sums come', async () => {
  const time = clock(5_000_000);
  try {
    let filled = false;
    const asked: { from: number; to: number }[] = [];
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push({ from, to });
      const bars = [];
      for (let t = Math.floor(from / H) * H; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60, stats: { buyN: 1, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0] }, ...(filled ? { over: [5, 6] } : {}) });
      return { step: 5, fine: 5, bars: bars as never, from };
    };
    const data = new FootprintData(), view = { t0: 10 * H, t1: 14 * H, p0: 0, p1: 1 }, sourceNow = 14 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow); await turn(); };
    await step();
    assert.ok([...data.bars.values()].every(b => !b.over), 'the server has not filled in the lists yet');
    const before = asked.length;
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.ok(asked.slice(before).every(a => a.from >= 14 * H), 'within the minute only the bars that can still change');
    filled = true; time.advance(60_000); await step(); await step();
    assert.ok(asked.some(a => a.from <= 10 * H && a.to <= 14 * H), 'the settled bars asked again');
    assert.ok([...data.bars.values()].filter(b => b.t < 14 * H).every(b => b.over?.[0] === 5), 'and now with their sums');
  } finally { time.restore(); }
});

test('a size-sum retry that comes back in slices goes on through the older slices', async () => {
  const time = clock(9_000_000);
  try {
    let filled = false;
    const asked: { from: number; to: number }[] = [];
    // Answers at most three bars, newest first, and says where it starts.
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push({ from, to });
      const bars = [];
      for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < 3; t -= H) bars.unshift({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60, stats: { buyN: 1, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0] }, ...(filled ? { over: [5, 6] } : {}) });
      return { step: 5, fine: 5, bars: bars as never, from: bars.length ? bars[0]!.t : from };
    };
    const data = new FootprintData(), view = { t0: 10 * H, t1: 18 * H, p0: 0, p1: 1 }, sourceNow = 18 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow); await turn(); };
    for (let i = 0; i < 6; i++) await step();
    filled = true; time.advance(60_000);
    for (let i = 0; i < 6; i++) await step();
    assert.ok([...data.bars.values()].filter(b => b.t < 18 * H).every(b => b.over?.[0] === 5), 'every settled bar has its sums, not only the newest slice');
  } finally { time.restore(); }
});

test('every few minutes the refresh reaches back an hour into the settled bars, for trades a venue sent late', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 10 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.at(-1)!.from, 10 * H, 'a refresh: the open bar');
    time.advance(5 * 60_000); await step();
    assert.equal(asked.at(-1)!.from, 9 * H, 'five minutes on: the hour before it too');
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.at(-1)!.from, 10 * H);
  } finally { time.restore(); }
});

test('a view a little behind the live edge, with no bar still under way, is rechecked for late trades too', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 8.5 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    const first = asked.length;
    time.advance(FOOTPRINT_REFRESH_MS); await step();
    assert.equal(asked.length, first, 'every bar of the view is settled: nothing to refresh');
    time.advance(5 * 60_000); await step();
    assert.deepEqual([asked.at(-1)!.from, asked.at(-1)!.to], [9 * H, 10 * H], 'five minutes on: the last hour of settled bars');
  } finally { time.restore(); }
});

test('on bars longer than the hour, the late-trade recheck starts on a bar\x27s own start', async () => {
  const time = clock(20_000_000);
  try {
    const { asked, load } = source(50), data = new FootprintData(), view = { t0: 0, t1: 10 * H, p0: 0, p1: 1 };
    const sourceNow = 10 * H + 30 * 60_000;
    const step = async () => { data.ensure('a', '4h', view, 5, load, () => {}, [], sourceNow); await turn(); };
    await step();
    time.advance(5 * 60_000); await step();
    // The bar under way starts at 8 h; an hour before it is inside the bar from 4 h, which is asked whole.
    assert.equal(asked.at(-1)!.from, 4 * H);
  } finally { time.restore(); }
});

// The Flow history's warm-up (2026-11-22, size-history/warm.ts): before any pane shows the bars, the view is asked for once, in its slices,
// and nothing on the clock; the first pane to show them draws what is held and asks only for what changed since.
test('warmed before any pane shows: the view once, in its slices, nothing on the clock; the first pane then asks for the bars still changing', async () => {
  const time = clock(1_000_000);
  try {
    const { asked, load } = source(5), data = new FootprintData(), view = { t0: 10 * H, t1: 20 * H, p0: 0, p1: 1 };
    const sourceNow = 20 * H + 30 * 60_000;
    const warm = async () => { data.ensure('a,b', '1h', view, 5, load, () => {}, [], sourceNow, true); await turn(); };
    await warm(); await warm(); await warm();
    assert.deepEqual(asked.map(a => [a.from / H, a.to / H]), [[9, 21], [9, 16], [9, 11]], 'the view with its margin, then older slices, newest first');
    assert.ok(data.covers(9 * H, 21 * H), 'the whole window is held');
    assert.equal(data.busy, false);
    time.advance(FOOTPRINT_REFRESH_MS * 3);
    await warm(); await warm();
    assert.equal(asked.length, 3, 'no refresh of the bars still changing while only the warm-up looks');
    // The first pane to show the bars: the open bar alone, as a refresh asks it (the ones before it are settled).
    data.ensure('a,b', '1h', view, 5, load, () => {}, [], sourceNow); await turn();
    assert.deepEqual(asked.slice(3).map(a => [a.from / H, a.to / H]), [[20, 21]]);
    assert.equal(data.bars.size, 12);
  } finally { time.restore(); }
});

test('the warm-up never rechecks settled bars for late trades nor retries missing size sums: those wait for a pane', async () => {
  const time = clock(1_000_000);
  try {
    const asked: number[][] = [];
    // Every bar answered without the sums of the size line asked (no `over`): a pane asks those again once a minute (the test above).
    const load = async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
      asked.push([from / H, to / H]);
      const bars = [];
      for (let t = Math.floor(from / H) * H; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60, stats: { buyN: 1, sellN: 1, buy: [0, 0, 0, 0, 0, 0, 0, 0], sell: [0, 0, 0, 0, 0, 0, 0, 0] } });
      return { step: 5, fine: 5, bars: bars as never, from };
    };
    const data = new FootprintData(), view = { t0: 10 * H, t1: 14 * H, p0: 0, p1: 1 }, sourceNow = 14 * H + 30 * 60_000;
    data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow, true); await turn();
    assert.equal(asked.length, 1);
    assert.ok([...data.bars.values()].every(b => !b.over), 'the bars came without their sums');
    time.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) { data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow, true); await turn(); }
    assert.equal(asked.length, 1, 'ten minutes on (past the recheck and the retries\x27 minute), the warm-up has asked nothing more');
    // A pane asks: the bars still changing, the hour back for late trades and the settled bars without their sums, as before.
    data.ensure('a', '1h', view, 5, load as never, () => {}, [50_000], sourceNow); await turn();
    assert.ok(asked.length > 1, 'the pane asks again where the warm-up did not');
  } finally { time.restore(); }
});

test('a pane that opens while a warm question is out waits for its answer rather than asking again, and holds its bars', async () => {
  const asked: number[][] = [];
  let release: (() => void) | null = null;
  const load = (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
    asked.push([from / H, to / H]);
    return new Promise(resolve => {
      release = () => { const bars = []; for (let t = Math.ceil(from / H) * H; t < to; t += H) bars.push({ t, rows: [[100, 1, 1]] as [number, number, number][], buyUsd: 1, sellUsd: 1, minutes: 60 }); resolve({ step: 5, fine: 5, bars }); };
    });
  };
  const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 }, sourceNow = 12 * H + 30 * 60_000;
  assert.equal(data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow, true), true, 'a question went out');
  assert.equal(data.busy, true, 'the warm question is out');
  assert.equal(data.answered, null, 'and nothing is answered yet (the pane says it is loading)');
  assert.equal(data.ensure('a', '1h', view, 5, load, () => {}, [], sourceNow), false, 'none goes out while one is');
  assert.equal(asked.length, 1, 'the pane does not ask again');
  release!(); await turn();
  assert.equal(data.busy, false);
  assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12], 'the warm answer is the pane\x27s');
  assert.ok(data.holds(['a'], '1h'));
});

test('a view that moved past the bars the warm-up holds is asked from their end, so the warm-up finishes rather than waiting on a refresh', async () => {
  const time = clock(1_000_000);
  try {
    // The source's clock half an hour into the 15h bar: the bars from 15h on can still change.
    const { asked, load } = source(50), data = new FootprintData(), sourceNow = 15.5 * H;
    data.ensure('a', '1h', { t0: 10 * H, t1: 14 * H, p0: 0, p1: 1 }, 5, load, () => {}, [], sourceNow, true); await turn();
    assert.deepEqual(asked.map(a => [a.from / H, a.to / H]), [[9, 15]]);
    // Past the late-trade recheck's five minutes, the view moved on past the end of what is held, still overlapping it (panned, or the
    // page hidden while the live edge moved on).
    time.advance(5 * 60_000 + 1);
    const moved = { t0: 13 * H, t1: 18 * H, p0: 0, p1: 1 };
    data.ensure('a', '1h', moved, 5, load, () => {}, [], sourceNow, true); await turn();
    assert.deepEqual(asked.slice(1).map(a => [a.from / H, a.to / H]), [[15, 19]], 'the warm-up asks from the end of what is held, not an hour back for late trades');
    const w = footprintWant(moved, H);
    assert.ok(data.covers(w.from, w.to), 'and the moved view is covered');
  } finally { time.restore(); }
});

test('a failed question is asked again after its pause and not before, ensure says whether one went out, and the answers and failures of the markets asked are counted', async () => {
  const time = clock(1_000_000);
  try {
    const { load: good } = source(50);
    let fail = true;
    const load = (...args: Parameters<typeof good>): Promise<FootprintResponse> => fail ? Promise.reject(new Error('down')) : good(...args);
    const data = new FootprintData(), view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 }, sourceNow = 12 * H + 30 * 60_000;
    const ask = (rowStep: number, inst = 'a', with_ = load): boolean => data.ensure(inst, '1h', view, rowStep, with_, () => {}, [], sourceNow, true);
    // No row size yet: the markets\x27 step is asked first, alone.
    assert.equal(ask(0), true, 'the step went out');
    await turn();
    assert.deepEqual(data.tally, { answers: 0, failures: 1 });
    assert.equal(ask(0), false, 'in its pause: none goes out');
    time.advance(FOOTPRINT_REFRESH_MS - 1);
    assert.equal(ask(0), false, 'still in its pause');
    time.advance(1); fail = false;
    assert.equal(ask(0), true, 'after it, asked again');
    await turn();
    assert.deepEqual(data.tally, { answers: 1, failures: 1 });
    // The view, on rows: failed, paused, then answered.
    fail = true;
    assert.equal(ask(5), true); await turn();
    assert.deepEqual(data.tally, { answers: 1, failures: 2 });
    assert.equal(ask(5), false, 'its pause');
    time.advance(FOOTPRINT_REFRESH_MS); fail = false;
    // Another list while a question is out: the old answer is dropped, and not counted.
    let release = (): void => {};
    const held = (...args: Parameters<typeof good>): Promise<FootprintResponse> => new Promise(resolve => { release = () => resolve(good(...args)); });
    assert.equal(ask(5, 'a', held), true);
    const old = release;
    assert.equal(ask(5, 'b', held), true, 'another list asks at once');
    old(); await turn();
    assert.deepEqual(data.tally, { answers: 1, failures: 2 }, 'the old list\x27s answer goes uncounted');
    release(); await turn();
    assert.deepEqual(data.tally, { answers: 2, failures: 2 });
    // Nor is a failure for the old list.
    let reject = (): void => {};
    const failing = (): Promise<FootprintResponse> => new Promise((_, no) => { reject = () => no(new Error('down')); });
    assert.equal(ask(5, 'c', failing), true);
    const oldReject = reject;
    assert.equal(ask(5, 'd', held), true);
    oldReject(); await turn();
    assert.deepEqual(data.tally, { answers: 2, failures: 2 }, 'nor its failure');
  } finally { time.restore(); }
});

test('the bars a view asks for: its candles with one each side, on whole candles', () => {
  assert.deepEqual(footprintWant({ t0: 10.5 * H, t1: 12.2 * H, p0: 0, p1: 1 }, H), { from: 9 * H, to: 14 * H });
});

test('bars without rows (the Flow history\x27s): no step asked first, sums asked on coarse rows and no venues, sliced as a source answers', async () => {
  const asked: { from: number; to: number; rows: number; cuts: number; budget: number; venues: boolean; sums: boolean }[] = [];
  const load = async (_i: string, _tf: string, from: number, to: number, rows: number, cuts: readonly number[], budget: number, venues: boolean, sums: boolean): Promise<FootprintResponse> => {
    asked.push({ from, to, rows, cuts: cuts.length, budget, venues, sums });
    // Three bars an answer, newest first, without rows.
    const bars = [];
    for (let t = Math.floor((to - 1) / H) * H; t >= from && bars.length < 3; t -= H) bars.unshift({ t, rows: [] as [number, number, number][], buyUsd: 0, sellUsd: 0, minutes: 60 });
    return { step: 5, fine: 5, bars, from: bars.length ? bars[0]!.t : from };
  };
  const data = new FootprintData(true), view = { t0: 10 * H, t1: 14 * H, p0: 0, p1: 1 };
  assert.equal(data.sumsOnly, true);
  // The row size given (0: the markets' step not known yet) asks no step question: the first question is for the bars.
  for (let i = 0; i < 3; i++) { data.ensure('a,b', '1h', view, 0, load, () => {}, [], 14 * H); await turn(); }
  assert.deepEqual(asked, [
    { from: 9 * H, to: 15 * H, rows: SUMS_ROW_STEP, cuts: 0, budget: FOOTPRINT_BUDGET, venues: false, sums: true },
    { from: 9 * H, to: 12 * H, rows: SUMS_ROW_STEP, cuts: 0, budget: FOOTPRINT_BUDGET, venues: false, sums: true },
  ], 'the view in two slices, never a step question, never venues for several markets');
  assert.deepEqual([...data.bars.keys()].map(t => t / H), [9, 10, 11, 12, 13, 14]);
  assert.equal(data.covers(9 * H, 15 * H), true);
  // Another row size asked (the zoom moved) is the same question for bars without rows: nothing is asked again.
  data.ensure('a,b', '1h', view, 40, load, () => {}, [], 14 * H); await turn();
  assert.equal(asked.length, 2, 'a row size means nothing to bars without rows');
  // Bars with rows ask the step first as before, and say sums false.
  const rows = new FootprintData();
  rows.ensure('a,b', '1h', view, 0, load, () => {}, [], 14 * H); await turn();
  assert.deepEqual([asked.at(-1)!.from, asked.at(-1)!.to, asked.at(-1)!.sums], [0, 1, false], 'the step question, alone');
});

test('bars without rows say whether they carry their dollars: an answer that says so, or one of merged rows; never an older source zeros', async () => {
  const view = { t0: 10 * H, t1: 12 * H, p0: 0, p1: 1 };
  /** A source answering the view's bars one way: with `totals`, without (a sums answer from before 2026-11-25), or as one merged row each (before `sums`). */
  const answering = (kind: 'totals' | 'zeros' | 'merged') => async (_i: string, _tf: string, from: number, to: number): Promise<FootprintResponse> => {
    const bars = [];
    for (let t = Math.floor(from / H) * H; t < to; t += H) bars.push({ t, rows: kind === 'merged' ? [[0, 7, 3]] as [number, number, number][] : [], buyUsd: kind === 'zeros' ? 0 : 7, sellUsd: kind === 'zeros' ? 0 : 3, minutes: 60 });
    return { step: 5, fine: 5, bars, from, ...(kind === 'totals' ? { totals: true } : {}) };
  };
  for (const [kind, want] of [['totals', true], ['zeros', false], ['merged', true]] as const) {
    const data = new FootprintData(true);
    assert.equal(data.totals, null, 'not known before an answer');
    data.ensure('a,b', '1h', view, 0, answering(kind), () => {}, [], 12 * H); await turn();
    assert.equal(data.totals, want, kind);
    // Bars without rows keep none: a merged row at price 0 would be priced in coins as if it traded there (review 2026-11-27); the dollars stay.
    assert.ok([...data.bars.values()].every(b => b.rows.length === 0 && b.buyUsd === (kind === 'zeros' ? 0 : 7) && b.sellUsd === (kind === 'zeros' ? 0 : 3)), kind);
  }
  // A later answer without them takes them from all the bars held, until the whole view is asked again (another market or timeframe).
  const data = new FootprintData(true);
  data.ensure('a', '1h', view, 0, answering('totals'), () => {}, [], 12 * H); await turn();
  data.ensure('a', '1h', { ...view, t0: 6 * H }, 0, answering('zeros'), () => {}, [], 12 * H); await turn();
  assert.equal(data.totals, false, 'one older answer among them');
  data.ensure('b', '1h', view, 0, answering('totals'), () => {}, [], 12 * H);
  assert.equal(data.totals, null, 'another market: not known again');
  await turn();
  assert.equal(data.totals, true);
  data.clear();
  assert.equal(data.totals, null, 'cleared');
  // Bars with rows always carry them.
  assert.equal(new FootprintData().totals, true);
});

test('a peek at the level leaves the hysteresis of the footprint as it is; the level itself moves it', () => {
  const fresh = new FootprintLod();
  assert.equal(fresh.peek(7), 1, 'rows of 7 px grouped by two');
  assert.equal(fresh.level(14), 0, 'the peek left the level at 0: rows of 14 px need no grouping (from level 1 they would stay grouped)');
  const lod = new FootprintLod();
  assert.equal(lod.level(1), 4, 'rows of 1 px grouped by 16 to reach 12 px');
  assert.equal(lod.peek(7), 2, 'from level 4, rows of 7 px refine to 2 (from level 0 they would coarsen to 1)');
  assert.equal(lod.peek(1.6), 4, 'and that peek left level 4 in place: rows of 1.6 px stay at 4 from there (from level 2 they would come to 3)');
});
