import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, OI_RECENT_BARS, atPrice } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import { pickOptions } from '../src/app/market-choice.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// The OI pane's view reaching further back than the recent candles (Karl, 2026-11-22: the NL/NS bars stopped at the 500-candle load while
// the server held a month): older bars are read once for the markets and timeframe, kept, and the refreshes keep to the recent candles.

const MIN = 60_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

const MARKETS = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
const level = (id: string): number => 100 * (MARKETS.indexOf(id) + 1);
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The open-interest questions, in the order asked, each answered by the test. */
  asked: { id: string; from: number; to: number; resolve(bars: OiBar[]): void }[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: MARKETS[0]!, markets: MARKETS.map(instrumentId => ({ instrumentId, marketType: 'perpetual' })), layers: {}, steps: {}, recorded: {}, columnMs: MIN } as unknown as BootstrapState;
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(() => {}); }
  oi(id: string, _tf: string, from: number, to: number): Promise<OiBar[]> { return new Promise(resolve => { this.asked.push({ id, from, to, resolve }); }); }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 450));
/** A market's one-minute bars over [from, to) (each minute's level its market's own, so the sum tells them apart). */
const bars = (id: string, from: number, to: number): OiBar[] => {
  const out: OiBar[] = [];
  for (let t = Math.ceil(from / MIN) * MIN; t < to; t += MIN) out.push([t, level(id), level(id), level(id), level(id)]);
  return out;
};

async function rig() {
  const store = new Store({ ...initialState(), marketId: MARKETS[0]!, timeframe: '1m', oiMarkets: 'chart' }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  const pick = (id: string): string => pickOptions(store.state, null, [], true).find(option => option.id === id)!.pick;
  store.set({ oiMarkets: 'custom', customMarkets: { ...store.state.customMarkets, oi: MARKETS.map(pick) } });
  /** Answer every question out with bars over the window it asked for; returns the windows asked. */
  const answer = (): { id: string; from: number; to: number }[] => {
    const out = source.asked.splice(0);
    for (const q of out) q.resolve(bars(q.id, q.from, q.to));
    return out.map(({ id, from, to }) => ({ id, from, to }));
  };
  const first = (): number[] => store.state.oiParts.map(p => p.bars[0]![0]);
  return { hub, store, source, answer, first };
}

test('a view reaching before the recent candles reads the older bars once, and keeps them through the refreshes', async () => {
  const r = await rig(), now = Date.now(), recent = (Math.floor(now / MIN) - OI_RECENT_BARS) * MIN;
  const whole = r.hub.loadOi(); await turn();
  const asked = r.answer(); await whole;
  assert.deepEqual(asked.map(q => q.id), MARKETS);
  assert.ok(asked.every(q => q.from <= recent + MIN && q.from >= recent - MIN), 'the whole read asks the recent candles');
  assert.ok(r.first().every(t => t >= recent - MIN));

  // The pane's view starts 800 minutes back: once it has stayed, the older stretch is read, each market from a candle before the view.
  const t0 = now - 800 * MIN;
  r.hub.oiReach(t0); r.hub.oiReach(t0); await turn();
  assert.equal(r.source.asked.length, 0, 'nothing asked while the view may still be moving');
  await settle();
  const older = r.answer();
  assert.deepEqual(older.map(q => q.id), MARKETS);
  assert.ok(older.every(q => q.from === (Math.floor(t0 / MIN) - 1) * MIN && Math.abs(q.to - recent) <= MIN), 'from a candle before the view to where the recent candles begin');
  await turn();
  assert.ok(r.first().every(t => t === older[0]!.from), 'the bars on screen now start there');
  const sum = r.store.state.oi;
  assert.ok(sum.length > 700 && sum.every(b => b[4] === 300), 'the sum over every bar, older ones included');

  // A view inside what is held, or a repeat, asks nothing; further back asks only for what is not held.
  r.hub.oiReach(now - 600 * MIN); r.hub.oiReach(t0); await settle();
  assert.equal(r.source.asked.length, 0);
  r.hub.oiReach(now - 900 * MIN); await settle();
  const more = r.answer(); await turn();
  assert.ok(more.every(q => q.to === older[0]!.from && q.from === (Math.floor((now - 900 * MIN) / MIN) - 1) * MIN), 'only the stretch before the one held');
  const start = r.first()[0]!;

  // The 20-second refresh reads the newest bars only and leaves the older ones.
  const tail = r.hub.loadOi(); await turn();
  const tails = r.answer(); await tail;
  assert.ok(tails.every(q => q.from >= now - 10 * MIN), 'a tail read');
  assert.deepEqual(r.first(), [start, start], 'nothing trimmed');

  // The next whole read (ten minutes on) asks from where the older stretch ends, never the older stretch again.
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * MIN;
  try {
    const again = r.hub.loadOi(); await turn();
    const read = r.answer(); await again;
    assert.ok(read.every(q => q.from === Math.min((Math.floor(Date.now() / MIN) - OI_RECENT_BARS) * MIN, older[0]!.to)), 'from the older stretch\'s end');
    assert.deepEqual(r.first(), [start, start], 'and the older bars are put back before the answer');
  } finally { Date.now = realNow; }
});

test('older bars belong to their markets and timeframe: another choice does not show them', async () => {
  const r = await rig(), now = Date.now(), recent = (Math.floor(now / MIN) - OI_RECENT_BARS) * MIN;
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  r.hub.oiReach(now - 800 * MIN); await settle(); r.answer(); await turn();
  assert.ok(r.first().every(t => t < recent - 200 * MIN), 'the older bars are on screen');
  // The chart market alone: another key, so the bars are its own read's, the recent candles only.
  r.store.set({ oiMarkets: 'chart' });
  const other = r.hub.loadOi(); await turn(); r.answer(); await other;
  assert.equal(r.store.state.oiInstrument, MARKETS[0]);
  assert.ok(r.store.state.oi[0]![0] >= recent - MIN, 'its bars start with the recent candles');
});

test('an inverse market\'s older bars are put at the one price of the bars they join', () => {
  const held = { usdAt: 50_000, bars: [[0, 2, 2, 2, 2]] as OiBar[] };
  assert.deepEqual(atPrice(held, 40_000), [[0, 2.5, 2.5, 2.5, 2.5]], 'the same USD over the other price');
  assert.deepEqual(atPrice(held, undefined), held.bars, 'a price unknown leaves them');
  assert.deepEqual(atPrice({ bars: held.bars }, 40_000), held.bars, 'a market in coins as it is');
});
