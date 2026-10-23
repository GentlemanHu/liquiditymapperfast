import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow, type OiBar } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// Open-interest pushes as the hub takes them, against a source whose open-interest answers a test settles when it likes.

const MIN = 60_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The open-interest questions, in the order asked, each with whether it asked for USD. */
  asked: { usd: boolean; resolve(bars: OiBar[]): void }[] = [];
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  constructor(private readonly market: string) {}
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: this.market, markets: [{ instrumentId: this.market, marketType: 'perpetual' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(() => {}); }
  oi(_id: string, _tf: string, _from: number, _to: number, usd = false): Promise<OiBar[]> { return new Promise(resolve => { this.asked.push({ usd, resolve }); }); }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}

const now0 = Math.floor(Date.now() / MIN) * MIN;
/** Forty one-minute bars up to the minute under way, every one at `close`. */
const history = (close: number): OiBar[] => Array.from({ length: 40 }, (_, i): OiBar => [now0 - (39 - i) * MIN, close, close, close, close]);
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function rig(market: string, candles: CandleRow[] = []) {
  const store = new Store({ ...initialState(), marketId: market, timeframe: '1m', oiMarkets: 'chart', candles }), source = new FakeSource(market);
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  return { hub, store, source, push: (items: unknown[]) => source.handlers!.onOiPush!(items) };
}
/** Ask for open interest and answer it with `bars` once it is asked. */
async function load(r: Awaited<ReturnType<typeof rig>>, bars: OiBar[]): Promise<void> {
  const done = r.hub.loadOi(); await turn();
  r.source.asked.shift()!.resolve(bars); await done;
}

test('a pushed reading moves the newest bar, and one older than the last taken changes nothing', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 40_000, base: 130 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130]);
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 20_000, base: 90 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130], 'an older reading of the same minute is not the close');
  r.push([{ instrumentId: 'okx:BTC-USDT-SWAP', t: now0 + 50_000, base: 1 }]);
  assert.deepEqual(r.store.state.oi.at(-1), [now0, 100, 130, 100, 130], 'another market\'s reading is not this one\'s');
});

test('a load that was asked before a push and answers after it keeps the push', async () => {
  const r = await rig('binance:BTCUSDT');
  await load(r, history(100));
  const done = r.hub.loadOi(); await turn();
  r.push([{ instrumentId: 'binance:BTCUSDT', t: now0 + 30_000, base: 120 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 120, 'shown at once');
  r.source.asked.shift()!.resolve(history(100)); await done;
  assert.equal(r.store.state.oi.at(-1)![4], 120, 'the answer held what the source had when asked; the push is put on it again');
  await load(r, history(100));
  assert.equal(r.store.state.oi.at(-1)![4], 100, 'a load asked after the push is the reconciliation');
});

test('an inverse market\'s push goes in as its USD at the bars\' one price, never as its coins at its own mark', async () => {
  const candles: CandleRow[] = [[now0, 100, 100, 100, 100, 1]];
  const r = await rig('deribit:BTC-PERPETUAL', candles);
  const done = r.hub.loadOi(); await turn();
  const usd = r.source.asked.shift()!;
  assert.equal(usd.usd, true, 'an inverse market is asked for its USD');
  usd.resolve(history(1_000_000)); await done;
  assert.equal(r.store.state.oi.at(-1)![4], 10_000, '1,000,000 USD at 100');
  assert.equal(r.store.state.oiPrice, 100);
  // The price went to 110 and no contract opened: the coins at the mark fell, the USD did not.
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 10_000, base: 1_000_000 / 110, quote: 1_000_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_000, 'a price move alone changes nothing');
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 20_000, base: 1_010_000 / 110, quote: 1_010_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_100, '10,000 USD opened is 100 coins at the bars\' price');
  r.push([{ instrumentId: 'deribit:BTC-PERPETUAL', t: now0 + 30_000, base: 9_000 }]);
  assert.equal(r.store.state.oi.at(-1)![4], 10_100, 'without its USD a reading is left for the next load');
});
