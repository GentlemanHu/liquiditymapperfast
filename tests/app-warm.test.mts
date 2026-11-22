import test from 'node:test';
import assert from 'node:assert/strict';
import { quietMs, resetQuiet, track, trackedFetch } from '../src/app/quiet.ts';
import { WARM_GIVE_UP_MS, WARM_IDLE, WARM_LOOK_MS, WARM_QUIET_MS, WARM_SETTLE_MS, liquidationCover, warmLiquidationSpan, warmNext, type WarmLook, type WarmState } from '../src/app/size-history/warm.ts';
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

test('the counted fetch is the page\x27s fetch, counted until its answer comes', async () => {
  const time = clock(20_000), real = globalThis.fetch;
  try {
    resetQuiet();
    let answer!: (r: Response) => void;
    globalThis.fetch = ((_url: string) => new Promise<Response>(resolve => { answer = resolve; })) as typeof fetch;
    const out = trackedFetch('/api/v2/state');
    assert.equal(quietMs(20_100), 0, 'out');
    time.set(20_500); answer(new Response('{}')); const r = await out;
    assert.equal(await r.text(), '{}');
    assert.equal(quietMs(21_000), 500);
  } finally { globalThis.fetch = real; time.restore(); resetQuiet(); }
});

/** A look at which the warm-up may ask, `ms` after the market list became the one drawn at 0. */
const look = (ms: number, over: Partial<WarmLook> = {}): WarmLook => ({ now: ms, key: 'a,b|1h', hidden: false, mapFirst: false, quietMs: WARM_QUIET_MS, barsBusy: false, barsCovered: false, days: true, ...over });
/** The warm-up's state once its market list has been seen at 0. */
const seen = (): WarmState => warmNext(WARM_IDLE, look(0)).state;

test('the warm-up waits for the market list to settle, the page shown, its own first map load in and a second of quiet', () => {
  const s = seen();
  assert.deepEqual([s.key, s.since, s.done], ['a,b|1h', 0, false], 'the list is seen');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS - 1)).act, 'none', 'a switch\x27s own loads come first');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS)).act, 'bars');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { hidden: true })).act, 'none', 'a hidden page');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { mapFirst: true })).act, 'none', 'the map\x27s own first load');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { quietMs: WARM_QUIET_MS - 1 })).act, 'none', 'the page\x27s own requests not drained');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { barsBusy: true })).act, 'none', 'one question at a time');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS, { key: '' })).act, 'none', 'no market counted');
});

test('the warm-up looks four times a second, starts again on another list, asks the bars until covered, then the days, then is done', () => {
  let s = seen();
  const r1 = warmNext(s, look(WARM_SETTLE_MS)); s = r1.state;
  assert.equal(r1.act, 'bars');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS + WARM_LOOK_MS - 1)).act, 'none', 'not again within its look');
  const r2 = warmNext(s, look(WARM_SETTLE_MS + WARM_LOOK_MS, { barsCovered: true })); s = r2.state;
  assert.equal(r2.act, 'days', 'the bars covered: the liquidation days');
  // The caller sets done once every day is held; with no days to warm it is done at once.
  const none = warmNext(seen(), look(WARM_SETTLE_MS, { barsCovered: true, days: false }));
  assert.deepEqual([none.act, none.state.done], ['none', true], 'no perpetual counted: nothing more to warm');
  const after = warmNext({ ...s, done: true }, look(WARM_SETTLE_MS + 2 * WARM_LOOK_MS));
  assert.equal(after.act, 'none', 'done: nothing more for this list');
  const other = warmNext({ ...s, done: true }, look(WARM_SETTLE_MS + 2 * WARM_LOOK_MS, { key: 'a,b|15m' }));
  assert.deepEqual([other.act, other.state.done, other.state.since], ['none', false, WARM_SETTLE_MS + 2 * WARM_LOOK_MS], 'another timeframe settles again before it is warmed');
});

test('a warm-up still not done three minutes after its first question gives up, and a page that never let it ask does not count', () => {
  let s = seen();
  s = warmNext(s, look(WARM_SETTLE_MS)).state;
  assert.equal(s.asked, WARM_SETTLE_MS, 'its first question');
  assert.equal(warmNext(s, look(WARM_SETTLE_MS + WARM_GIVE_UP_MS)).act, 'bars', 'still asking at three minutes');
  const gaveUp = warmNext(s, look(WARM_SETTLE_MS + WARM_GIVE_UP_MS + 1));
  assert.deepEqual([gaveUp.act, gaveUp.state.done], ['none', true], 'a source that keeps failing is not asked forever');
  // Never quiet for an hour: it has not asked, so it has not given up.
  const busy = warmNext(seen(), look(60 * 60_000, { quietMs: 0 }));
  assert.deepEqual([busy.act, busy.state.done, busy.state.asked], ['none', false, 0]);
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
