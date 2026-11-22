import test from 'node:test';
import assert from 'node:assert/strict';
import { quietMs, resetQuiet, track } from '../src/app/quiet.ts';
import { WARM_QUIET_MS, WARM_SETTLE_MS, warmLiquidationSpan, warmMayAsk } from '../src/app/size-history/warm.ts';

// The Flow history's warm-up (2026-11-22): it asks only once the page's own requests have drained (quiet.ts), a market list and timeframe
// settled, nothing showing the bars and the page shown (size-history/warm.ts); its liquidation stretch is the one the pane asks for first.

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

test('the warm-up asks only with the page shown, nothing showing the bars, not done, quiet and settled long enough', () => {
  const ready = { hidden: false, shown: false, done: false, quietMs: WARM_QUIET_MS, settledMs: WARM_SETTLE_MS };
  assert.equal(warmMayAsk(ready), true);
  assert.equal(warmMayAsk({ ...ready, hidden: true }), false, 'a hidden page');
  assert.equal(warmMayAsk({ ...ready, shown: true }), false, 'a pane shows the bars: it loads them itself');
  assert.equal(warmMayAsk({ ...ready, done: true }), false, 'warmed already');
  assert.equal(warmMayAsk({ ...ready, quietMs: WARM_QUIET_MS - 1 }), false, 'the page\x27s own loads not drained');
  assert.equal(warmMayAsk({ ...ready, settledMs: WARM_SETTLE_MS - 1 }), false, 'a switch\x27s own loads come first');
});

test('the warm liquidation stretch: from the first candle or where the record begins, to the candle after the view\x27s last, never past now', () => {
  const H = 3_600_000;
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 30 * H, 0), { from: 10 * H, to: 22 * H });
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 21.5 * H, 0), { from: 10 * H, to: 21.5 * H }, 'the live edge');
  assert.deepEqual(warmLiquidationSpan(10.5 * H, 20.2 * H, H, 30 * H, 15 * H), { from: 15 * H, to: 22 * H }, 'the record reaches back to 15h only');
  assert.equal(warmLiquidationSpan(10 * H, 12 * H, H, 30 * H, 25 * H), null, 'nothing the record holds');
});
