import test from 'node:test';
import assert from 'node:assert/strict';
import { quietMs, resetQuiet, track, trackedFetch } from '../src/app/quiet.ts';
import { WARM_IDLE, WARM_LOOK_MS, WARM_MAX_FAILURES, WARM_MAX_TRIES, WARM_QUIET_MS, WARM_SETTLE_MS, warmAfter, warmLiquidationSpan, warmNext, type WarmLook, type WarmState } from '../src/app/size-history/warm.ts';
import { historyLoading } from '../src/app/size-history/model.ts';
import { liquidationCover } from '../src/app/liq-days.ts';
import { LIQUIDATION_RETENTION_MS } from '../src/shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../src/shared/recorder.ts';

// The Flow history's warm-up (2026-11-22): it asks only once the page's own requests have drained (quiet.ts) and the map's own first load is
// in, a market list and timeframe settled, the page shown, one question at a time: the bars, then the liquidation days (size-history/warm.ts).

/** performance.now as the test says. */
function clock(start: number) {
  let now = start; const real = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  return { set: (ms: number) => { now = ms; }, restore: () => Object.defineProperty(performance, 'now', { value: real, configurable: true, writable: true }) };
}

test('quiet: zero while any of the page\x27s own requests is out, then the time since the last one settled, failed ones too', async () => {
  const time = clock(10_000);
  try {
    resetQuiet();
    assert.equal(quietMs(10_000), 10_000, 'nothing asked yet: quiet since the clock\x27s start');
    let done!: () => void, fail!: (e: Error) => void;
    const a = track(new Promise<void>(resolve => { done = resolve; })), b = track(new Promise<void>((_, reject) => { fail = reject; }));
    assert.equal(quietMs(11_000), 0, 'two out');
    time.set(12_000); done(); await a;
    assert.equal(quietMs(12_500), 0, 'one still out');
    time.set(13_000); fail(new Error('x')); await b.catch(() => undefined);
    assert.equal(quietMs(13_400), 400, 'both settled: quiet since the failed one did');
  } finally { time.restore(); resetQuiet(); }
});

test('the counted fetch is the page\x27s fetch with its options, counted until its answer comes', async () => {
  const time = clock(20_000), real = globalThis.fetch;
  try {
    resetQuiet();
    let answer!: (r: Response) => void;
    const seen: [string, RequestInit | undefined][] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => { seen.push([url, init]); return new Promise<Response>(resolve => { answer = resolve; }); }) as typeof fetch;
    const init = { cache: 'no-store', priority: 'low' } as RequestInit;
    const out = trackedFetch('/api/v2/state', init);
    assert.deepEqual(seen, [['/api/v2/state', init]], 'the url and its options reach the page\x27s fetch');
    assert.equal(quietMs(20_100), 0, 'out');
    time.set(20_500); answer(new Response('{}')); const r = await out;
    assert.equal(await r.text(), '{}');
    assert.equal(quietMs(21_000), 500);
  } finally { globalThis.fetch = real; time.restore(); resetQuiet(); }
});

/** A look at which the warm-up may ask, `ms` after the market list became the one drawn at 0. */
const look = (ms: number, over: Partial<WarmLook> = {}): WarmLook => ({ now: ms, key: 'a,b|1h', hidden: false, mapFirst: false, quietMs: WARM_QUIET_MS, barsBusy: false, barsCovered: false, days: true, answers: 0, failures: 0, ...over });
/** The warm-up's state once its market list has been seen at 0. */
const seen = (): WarmState => warmNext(WARM_IDLE, look(0)).state;

test('the warm-up waits for the market list to settle, the page shown, its own first map load in and a second of quiet', () => {
  const s = seen();
  assert.deepEqual([s.key, s.since, s.tries, s.done], ['a,b|1h', 0, 0, false], 'the list is seen');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS - 1)).act, 'none', 'a switch\x27s own loads come first');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS)).act, 'bars');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { hidden: true })).act, 'none', 'a hidden page');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { mapFirst: true })).act, 'none', 'the map\x27s own first load');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { quietMs: WARM_QUIET_MS - 1 })).act, 'none', 'the page\x27s own requests not drained');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { barsBusy: true })).act, 'none', 'one question at a time');
  const none = warmNext({ ...s, done: true }, look(WARM_SETTLE_MS, { key: '' }));
  assert.deepEqual([none.act, none.state.key, none.state.done], ['none', 'a,b|1h', true], 'no market counted: nothing asked, and what was warmed is not forgotten');
});

test('the warm-up looks four times a second, starts again on another list, asks the bars until covered, then the days, then is done', () => {
  let s = seen();
  const r1 = warmNext(s, look(WARM_SETTLE_MS)); s = r1.state;
  assert.deepEqual([r1.act, s.tries], ['bars', 1]);
  assert.equal(warmNext(s, look(WARM_SETTLE_MS + WARM_LOOK_MS - 1)).act, 'none', 'not again within its look');
  const r2 = warmNext(s, look(WARM_SETTLE_MS + WARM_LOOK_MS, { barsCovered: true })); s = r2.state;
  assert.deepEqual([r2.act, s.tries], ['days', 2], 'the bars covered: the liquidation days, a question counted too');
  // The caller sets done once every day is held; with no days to warm it is done at once.
  const none = warmNext(seen(), look(WARM_SETTLE_MS, { barsCovered: true, days: false }));
  assert.deepEqual([none.act, none.state.done], ['none', true], 'no perpetual counted: nothing more to warm');
  const after = warmNext({ ...s, done: true }, look(WARM_SETTLE_MS + 2 * WARM_LOOK_MS));
  assert.equal(after.act, 'none', 'done: nothing more for this list');
  const other = warmNext({ ...s, done: true }, look(WARM_SETTLE_MS + 2 * WARM_LOOK_MS, { key: 'a,b|15m' }));
  assert.deepEqual([other.act, other.state.done, other.state.since, other.state.tries], ['none', false, WARM_SETTLE_MS + 2 * WARM_LOOK_MS, 0], 'another timeframe: counted from nothing, settling again');
});

test('the warm-up gives up after its questions run out, in the bars or the days, and time spent waiting costs it nothing', () => {
  let s = seen(), t = WARM_SETTLE_MS;
  for (let i = 0; i < WARM_MAX_TRIES; i++, t += WARM_LOOK_MS) { const r = warmNext(s, look(t)); assert.equal(r.act, 'bars'); s = r.state; }
  const gaveUp = warmNext(s, look(t));
  assert.deepEqual([gaveUp.act, gaveUp.state.done], ['none', true], 'a source that keeps failing is not asked forever');
  // The days count too: the bars covered at once, the days never all held.
  let d = seen(); t = WARM_SETTLE_MS;
  for (let i = 0; i < WARM_MAX_TRIES; i++, t += WARM_LOOK_MS) { const r = warmNext(d, look(t, { barsCovered: true })); assert.equal(r.act, 'days'); d = r.state; }
  assert.equal(warmNext(d, look(t, { barsCovered: true })).state.done, true, 'nor are days that never come');
  // One question, then an hour hidden: it goes on where it was.
  let w = warmNext(seen(), look(WARM_SETTLE_MS)).state;
  for (let m = 1; m <= 60; m++) w = warmNext(w, look(WARM_SETTLE_MS + m * 60_000, { hidden: true })).state;
  const back = warmNext(w, look(WARM_SETTLE_MS + 61 * 60_000));
  assert.deepEqual([back.act, back.state.done, back.state.tries], ['bars', false, 2], 'shown again an hour later, it asks its second question');
  // A list first seen more than three minutes into the page gives up no sooner for that.
  const late = warmNext(warmNext(WARM_IDLE, look(10 * 60_000)).state, look(10 * 60_000 + WARM_SETTLE_MS));
  assert.deepEqual([late.act, late.state.tries], ['bars', 1]);
});

test('a look that waits for any of its five reasons counts no question, however many there are', () => {
  const gates: Partial<WarmLook>[] = [{ hidden: true }, { mapFirst: true }, { quietMs: WARM_QUIET_MS - 1 }, { barsBusy: true }];
  for (const gate of gates) {
    let s = seen();
    for (let i = 0; i < 200; i++) s = warmNext(s, look(WARM_SETTLE_MS + i * WARM_LOOK_MS, gate)).state;
    assert.equal(s.tries, 0, `waiting on ${JSON.stringify(gate)}`);
  }
  let settling = seen();
  for (let i = 0; i < 11; i++) settling = warmNext(settling, look(i * WARM_LOOK_MS + 1)).state;
  assert.equal(settling.tries, 0, 'a list still settling');
});

test('after its act: every day held is done, and a look whose act sent no question gives back the one it counted', () => {
  const s: WarmState = { ...seen(), tries: 5 };
  assert.equal(warmAfter(s, true).tries, 5, 'the bars asked');
  assert.equal(warmAfter(s, 'asked').tries, 5, 'a day asked');
  assert.equal(warmAfter(s, false).tries, 4, 'the bars not asked: in their pause after a failure');
  assert.equal(warmAfter(s, 'waiting').tries, 4, 'a day still loading, or every one missing in its pause');
  assert.deepEqual([warmAfter(s, 'done').done, warmAfter(s, 'done').tries], [true, 5], 'every day held');
  assert.equal(warmAfter(s, true).done, false);
  assert.equal(warmAfter({ ...s, tries: 0 }, false).tries, 0, 'never below none');
  assert.deepEqual({ ...warmAfter(s, 'waiting'), tries: 5 }, s, 'nothing else changes');
});

test('six failures in a row let the warm-up go, in the bars or the days; an answer between them starts the count again', () => {
  for (const barsCovered of [false, true]) {
    let s = seen(), t = WARM_SETTLE_MS;
    const step = (over: Partial<WarmLook>): string => { const r = warmNext(s, look(t, { barsCovered, ...over })); s = r.state; t += WARM_LOOK_MS; return r.act; };
    const act = barsCovered ? 'days' : 'bars';
    assert.equal(step({}), act);
    for (let f = 1; f < WARM_MAX_FAILURES; f++) assert.equal(step({ failures: f }), act, `${f} failed in a row`);
    assert.equal(step({ failures: WARM_MAX_FAILURES - 1, answers: 1 }), act, 'an answer: the count starts again');
    for (let f = 1; f < WARM_MAX_FAILURES; f++) assert.equal(step({ failures: WARM_MAX_FAILURES - 1 + f, answers: 1 }), act);
    assert.equal(step({ failures: 2 * WARM_MAX_FAILURES - 1, answers: 1 }), 'none', `six in a row since the answer (${act})`);
    assert.equal(s.done, true);
  }
});

test('a healthy start of some 65 questions is never let go for a failure now and then, each followed by an answer', () => {
  let s = seen(), t = WARM_SETTLE_MS, answers = 0, failures = 0;
  for (let i = 0; i < 65; i++, t += 5 * WARM_LOOK_MS) {
    const r = warmNext(s, look(t, { answers, failures })); s = r.state;
    assert.equal(r.act, 'bars', `question ${i + 1}`);
    // Every seventh question fails, and is answered when it is asked again (sent, so counted).
    if (i % 7 === 6) failures++; else answers++;
  }
  assert.deepEqual([s.done, s.tries], [false, 65]);
});

test('failures counted before the warm-up of this market list and timeframe began do not count toward its six', () => {
  // The loaders still count five failures from earlier (another timeframe's warm-up, or a pane during an outage).
  let s = warmNext(WARM_IDLE, look(0, { failures: 5 })).state;
  assert.equal(s.streak, 0, 'a list first seen starts from none');
  s = warmNext(s, look(WARM_SETTLE_MS, { failures: 5 })).state;
  const own = warmNext(s, look(WARM_SETTLE_MS + WARM_LOOK_MS, { failures: 6 }));
  assert.deepEqual([own.act, own.state.streak], ['bars', 1], 'its own first failure is its first');
  const other = warmNext({ ...own.state, streak: 5 }, look(WARM_SETTLE_MS + 2 * WARM_LOOK_MS, { key: 'a,b|15m', failures: 7 }));
  assert.equal(other.state.streak, 0, 'another timeframe starts from none, whatever the last one counted');
  const next = warmNext(other.state, look(WARM_SETTLE_MS + 3 * WARM_LOOK_MS, { key: 'a,b|15m', failures: 8 }));
  assert.equal(next.state.streak, 1);
});

test('the pane says Loading only while a question is out for candles not yet answered for', () => {
  const H = 3_600_000, times = [10 * H, 11 * H, 12 * H];
  const answered = (from: number, to: number) => (f: number, t: number) => f >= from && t <= to;
  assert.equal(historyLoading(true, times, H, answered(0, 0)), true, 'the first look');
  assert.equal(historyLoading(true, times, H, answered(5 * H, 11 * H)), true, 'a pan into the past, past what was answered');
  assert.equal(historyLoading(true, times, H, answered(5 * H, 13 * H)), false, 'answered and empty, a refresh out: empty, never Loading');
  assert.equal(historyLoading(false, times, H, answered(0, 0)), false, 'nothing out: empty');
  assert.equal(historyLoading(true, [], H, answered(0, 0)), true, 'no candles yet, a question out');
});

test('the liquidations counted begin where the record does, a week on a server and a day in the page\x27s engine, never before the recording', () => {
  const now = 100 * 86_400_000 + 30_000;
  assert.equal(liquidationCover('server', 0, now), Math.ceil((now - LIQUIDATION_RETENTION_MS) / 60_000) * 60_000);
  assert.equal(liquidationCover('browser', 0, now), Math.ceil((now - BROWSER_RETENTION_MS) / 60_000) * 60_000);
  assert.equal(liquidationCover('browser', now - 3_600_000, now), now - 3_600_000, 'the recording began an hour ago');
});

test('the warm liquidation stretch: from the first candle or where the record begins, to the candle after the view\x27s last, never past now', () => {
  const H = 3_600_000;
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 30 * H, 0), { from: 10 * H, to: 22 * H });
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 21.5 * H, 0), { from: 10 * H, to: 21.5 * H }, 'the live edge');
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 30 * H, 15 * H), { from: 15 * H, to: 22 * H }, 'the record reaches back to 15h only');
  assert.equal(warmLiquidationSpan(10 * H, 12 * H, H, 30 * H, 25 * H), null, 'nothing the record holds');
});
