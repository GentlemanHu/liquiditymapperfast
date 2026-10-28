import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, mergeLive, defaultMarket, prefetchOrder, rebaseLive, keepGrowth } from '../src/app/hub.ts';
import { Store, initialState, type CandleRow } from '../src/app/store.ts';
import type { BootstrapState, DataSource, LiveHandlers, TickMessage } from '../src/app/source.ts';
import type { FlowFrame } from '../src/shared/flow.ts';

// The hub as the page runs it, against a source and a worker that say what a test tells them to.

const MIN = 60_000, HOUR = 3_600_000;
class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; postMessage(): void {} }
(globalThis as { Worker?: unknown }).Worker = FakeWorker;

interface Rig { hub: Hub; store: Store; handlers: () => LiveHandlers; source: FakeSource }
class FakeSource {
  readonly kind = 'server' as const;
  handlers: LiveHandlers | null = null;
  /** The answers to candle requests, in the order they were asked: a test settles them in whatever order it likes. */
  asked: { resolve(rows: CandleRow[]): void }[] = [];
  flowCalls = 0;
  readonly venues = { catalog: async () => ({ venues: [], limit: null, recommendedKnown: true }), apply: async () => {} };
  async bootstrap(): Promise<BootstrapState> {
    return { asOf: 0, now: 0, dataMode: 'server', markPrice: 100, markInstrumentId: 'ref:BTC', markets: [{ instrumentId: 'ref:BTC' }, { instrumentId: 'sel:BTC' }], layers: {}, steps: {}, recorded: {}, columnMs: MIN, timeframes: [], oiReferences: [] };
  }
  connect(handlers: LiveHandlers): { close(): void; tape(on: boolean): void } { this.handlers = handlers; return { close() {}, tape() {} }; }
  candles(): Promise<CandleRow[]> { return new Promise(resolve => { this.asked.push({ resolve }); }); }
  async oi() { return []; }
  async prints() { return []; }
  async columns() { return { from: 0, to: 0, stepMs: MIN, instruments: [] } as never; }
  async flow(): Promise<FlowFrame> { this.flowCalls++; return { from: 0, to: 0, instruments: [] }; }
  async footprint() { return { step: 0, fine: 0, bars: [] }; }
}
async function rig(patch: Partial<ReturnType<typeof initialState>> = {}): Promise<Rig> {
  const store = new Store({ ...initialState(), ...patch }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  return { hub, store, source, handlers: () => source.handlers! };
}
const tick = (over: Partial<TickMessage> = {}): TickMessage => ({ t: 'tick', price: 100, instrumentId: 'ref:BTC', asOf: 10 * HOUR, candles: {}, ...over });
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('a market that is not the reference has its mark moved by its own live candle, while that is fresh', async () => {
  const { store, handlers } = await rig({ marketId: 'sel:BTC' });
  assert.equal(store.state.mark.price, 100, 'it starts at the price the server gave for the reference');
  handlers().onTick(tick({ candles: { 'sel:BTC': [10 * HOUR - 30_000, 10, 22, 9, 21, 5] } }));
  assert.equal(store.state.mark.price, 21, 'the market on screen traded to 21, and its mark stayed where it was');
  handlers().onTick(tick({ asOf: 10 * HOUR + 5 * MIN, candles: { 'sel:BTC': [10 * HOUR - 30_000, 10, 22, 9, 15, 5] } }));
  assert.equal(store.state.mark.price, 21, 'a candle that is minutes old is not a price of now');
});

test('a market with no history starts its series from the live candle', async () => {
  const { store, handlers } = await rig({ marketId: 'sel:BTC', timeframe: '1m', candles: [] });
  handlers().onTick(tick({ candles: { 'sel:BTC': [10 * HOUR, 10, 12, 9, 11, 3] } }));
  assert.deepEqual(store.state.candles.map(c => [c[0], c[4], c[5]]), [[10 * HOUR, 11, 3]]);
});

test('a live candle of a coarser timeframe is the sum of its minutes, not the biggest of them', () => {
  const track = { current: null };
  const open: CandleRow[] = [[10 * HOUR, 10, 10, 10, 10, 0, 1]];                         // the loaded five minute candle has nothing yet
  let candles = mergeLive(open, [10 * HOUR, 10, 11, 10, 11, 9], 5 * MIN, track);
  candles = mergeLive(candles, [10 * HOUR + MIN, 11, 12, 11, 12, 5], 5 * MIN, track);
  candles = mergeLive(candles, [10 * HOUR + 2 * MIN, 12, 12, 11, 11, 4], 5 * MIN, track);
  assert.equal(candles.length, 1); assert.equal(candles[0]![5], 18, 'nine, five and four (it showed 9)');
  candles = mergeLive(candles, [10 * HOUR + 2 * MIN, 12, 13, 11, 13, 6], 5 * MIN, track);
  assert.equal(candles[0]![5], 20, 'the minute still open grows by what it adds');
  assert.deepEqual([candles[0]![2], candles[0]![3], candles[0]![4]], [13, 10, 13]);
  // a candle that already held part of the first live minute is not counted twice for it
  const loaded: CandleRow[] = [[10 * HOUR, 10, 10, 10, 10, 14, 1]];                      // 8 from before, and 6 of the minute now live
  const again = { current: null };
  const first = mergeLive(loaded, [10 * HOUR + 3 * MIN, 10, 10, 10, 10, 6], 5 * MIN, again);
  assert.equal(first[0]![5], 14);
  assert.equal(mergeLive(first, [10 * HOUR + 3 * MIN, 10, 10, 10, 10, 9], 5 * MIN, again)[0]![5], 17, 'three more in the same minute');
  assert.equal(mergeLive(first, [10 * HOUR + 4 * MIN, 10, 10, 10, 10, 2], 5 * MIN, again)[0]![5], 19, 'and the next minute adds its own');
  // and a one minute candle goes on being replaced by its own later, bigger self
  assert.equal(mergeLive([[0, 1, 1, 1, 1, 5, 1]], [0, 1, 1, 1, 1, 7], MIN, { current: null })[0]![5], 7);
});

test('an older request for the series does not put its answer over a newer one, and a live candle that opens a candle the answer lacks is kept', async () => {
  const { hub, store, source, handlers } = await rig({ marketId: '', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });  // no market known before the start, so no read is started with it: the two loads read apart
  const row = (close: number): CandleRow => [10 * HOUR, 1, 1, 1, close, 1, 1];
  void hub.loadSeries(true);                                                              // asked first
  await turn();
  void hub.loadSeries(true);                                                              // asked again, by a forced reload
  await turn();
  assert.equal(source.asked.length, 2);
  handlers().onTick(tick({ candles: { 'ref:BTC': [11 * HOUR + 5 * MIN, 1, 1, 1, 300, 1] } }));          // the next hour has begun: the answer cannot have it
  source.asked[1]!.resolve([row(200)]); await turn();
  assert.deepEqual(store.state.candles.map(c => [c[0], c[4]]), [[10 * HOUR, 200], [11 * HOUR, 300]], 'the newer answer, with the candle the stream opened after it');
  source.asked[0]!.resolve([row(100)]); await turn();
  assert.equal(store.state.candles.at(-1)![4], 300, 'the older answer arrives last and rewinds nothing (it set the close back to 100)');
});

test('the candles say which timeframe they were loaded for, and those of the timeframe before do not stand under the new one while it loads', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  source.asked[0]!.resolve([[10 * HOUR, 1, 1, 1, 1, 1, 1]]); await turn();
  assert.equal(store.state.candlesTimeframe, '1h');
  store.set({ timeframe: '15m' });
  void hub.loadSeries(); await turn();
  assert.deepEqual([store.state.candles.length, store.state.candlesTimeframe], [0, '15m'], 'nothing kept of the quarter hours: no hourly candles under their label while they are on their way');
  source.asked[1]!.resolve([[10 * HOUR, 1, 1, 1, 1, 1, 1]]); await turn();
  assert.equal(store.state.candlesTimeframe, '15m');
});

test('when the live stream comes back after a break, the flow history is asked for again', async () => {
  const { hub, handlers, source } = await rig();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 1, 'once it is there it is not asked for again');
  handlers().onOpen();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 1, 'the first open has nothing to repair');
  handlers().onClose(1, 'host'); handlers().onOpen();
  await hub.ensureFlow(['ref:BTC'], 9 * HOUR);
  assert.equal(source.flowCalls, 2, 'the seconds missed while it was down come with the history');
});

test('the page starts on the Binance perpetual where it reads one, else the reference market, else the first', () => {
  const markets = [{ instrumentId: 'hyperliquid:BTC', venue: 'hyperliquid', marketType: 'perpetual' }, { instrumentId: 'binance-spot:BTCUSDT', venue: 'binance-spot', marketType: 'spot' }, { instrumentId: 'binance:BTCUSDT', venue: 'binance', marketType: 'perpetual' }];
  assert.equal(defaultMarket(markets, 'hyperliquid:BTC'), 'binance:BTCUSDT');
  assert.equal(defaultMarket(markets.slice(0, 2), 'hyperliquid:BTC'), 'hyperliquid:BTC', 'no Binance perpetual: the reference');
  assert.equal(defaultMarket(markets.slice(0, 2), ''), 'hyperliquid:BTC', 'no reference either: the first');
  assert.equal(defaultMarket([], ''), '');
});

test('a timeframe read before is shown the moment it is chosen, then brought up to date; the others are read nearest first', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  const row = (t: number, close: number): CandleRow => [t, 1, 1, 1, close, 1, 1], T = Math.floor(Date.now() / HOUR) * HOUR;
  void hub.loadSeries(true); await turn();
  source.asked[0]!.resolve([row(T, 100)]); await turn();
  store.set({ timeframe: '5m' });
  let shown = 0;
  void hub.loadSeries(true, () => shown++); await turn();
  assert.equal(shown, 0, 'nothing kept of 5m yet: it waits for its read');
  source.asked[1]!.resolve([row(T, 50)]); await turn();
  store.set({ timeframe: '1h' });
  void hub.loadSeries(true, () => shown++); await turn();
  assert.equal(shown, 1, 'the hour kept from before');
  assert.deepEqual(store.state.candles.map(c => c[4]), [100], 'shown before its read answers');
  source.asked[2]!.resolve([row(T, 120)]); await turn();
  assert.deepEqual(store.state.candles.map(c => c[4]), [120], 'then up to date');
  assert.deepEqual(prefetchOrder('1h'), ['30m', '4h', '15m', '1d', '5m', '1m']);
  assert.deepEqual(prefetchOrder('1m'), ['5m', '15m', '30m', '1h', '4h', '1d']);
});

test('a second switch before the first one answers leaves nothing of the one between, and the stream starts no series while its read is out', async () => {
  const { hub, store, source, handlers } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  source.asked[0]!.resolve([[10 * HOUR, 1, 1, 1, 1, 1, 1]]); await turn();
  store.set({ marketId: 'sel:BTC' });
  void hub.loadSeries(true); await turn();
  handlers().onTick(tick({ candles: { 'sel:BTC': [10 * HOUR, 5, 5, 5, 5, 2] } }));
  assert.equal(store.state.candles.length, 0, 'no candle of a minute stands for the one under way while the read is out');
  store.set({ timeframe: '5m' });
  void hub.loadSeries(true); await turn();
  assert.deepEqual([store.state.candles.length, store.state.candlesTimeframe, store.state.seriesInstrument], [0, '5m', 'sel:BTC']);
});

test('a series that came back empty before any reference market was known is read again, from the reference, the moment one is', async () => {
  // No bootstrap names a reference market (no venue has a price yet): the first tick does.
  class NoReferenceYet extends FakeSource {
    override async bootstrap(): Promise<BootstrapState> { return { ...await super.bootstrap(), markInstrumentId: '' }; }
  }
  const store = new Store({ ...initialState(), marketId: 'sel:BTC', timeframe: '1h', candles: [] }), source = new NoReferenceYet();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  let refilled = 0; hub.onSeriesRefilled = () => refilled++;
  void hub.loadSeries(true); await turn();
  source.asked[0]!.resolve([]); await turn();                                                              // the market's own: nothing
  assert.equal(store.state.candles.length, 0);
  source.handlers!.onTick(tick({ instrumentId: 'ref:BTC' })); await turn();                                // a reference market now
  source.asked.at(-1)!.resolve([]); await turn();                                                          // its own again: nothing
  source.asked.at(-1)!.resolve([[10 * HOUR, 1, 1, 1, 7, 1, 1]]); await turn();                             // then the reference's
  assert.deepEqual([store.state.candles.length, store.state.seriesInstrument], [1, 'ref:BTC']);
  assert.equal(refilled, 1, 'the page is told, to frame them');
});

test('an older read of the same series that answers first does not let the stream start the series while the newer one is out', async () => {
  const { hub, store, source, handlers } = await rig({ marketId: '', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });  // no market known before the start, so no read is started with it: the two loads read apart
  void hub.loadSeries(true); await turn();
  void hub.loadSeries(true); await turn();
  source.asked[0]!.resolve([[10 * HOUR, 1, 1, 1, 1, 1, 1]]); await turn();                                 // the older answers: not taken
  handlers().onTick(tick({ candles: { 'ref:BTC': [11 * HOUR, 5, 5, 5, 5, 2] } }));
  assert.equal(store.state.candles.length, 0, 'no candle of a minute while the newer read is out');
  source.asked[1]!.resolve([[11 * HOUR, 1, 1, 1, 1, 9, 1]]); await turn();
  assert.equal(store.state.candles.length, 1);
});

test('an empty answer leaves what was kept of the series', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  const T = Math.floor(Date.now() / HOUR) * HOUR;
  void hub.loadSeries(true); await turn(); source.asked[0]!.resolve([[T, 1, 1, 1, 5, 1, 1]]); await turn();
  void hub.loadSeries(true); await turn(); source.asked[1]!.resolve([]); await turn();                     // the minute's reload: nothing this time
  store.set({ timeframe: '5m' }); void hub.loadSeries(true); await turn(); source.asked[2]!.resolve([[T, 1, 1, 1, 6, 1, 1]]); await turn();
  let shown = 0;
  store.set({ timeframe: '1h' }); void hub.loadSeries(true, () => shown++); await turn();
  assert.deepEqual([shown, store.state.candles.at(-1)?.[4]], [1, 5], 'the hour kept from before the empty answer');
});

test('a read that ends before the candle the stream opened: that candle stays as shown, and the newest of the read is widened by what was shown of it', () => {
  const read: CandleRow[] = [[0, 1, 1, 1, 1, 105, 1]];
  const shown: CandleRow[] = [[0, 1, 2, 0.5, 1.5, 120, 1], [60_000, 1.5, 1.6, 1.4, 1.5, 7, 1]];
  const want: CandleRow[] = [[0, 1, 2, 0.5, 1, 120, 1], [60_000, 1.5, 1.6, 1.4, 1.5, 7, 1]];
  assert.deepEqual(rebaseLive(read, shown, { current: null }), want, 'a kept series brought up to date');
  assert.deepEqual(keepGrowth(read, shown, null, 60_000, 120_000), want, 'a reload of what is on screen');
});

test('a series whose answers came back empty is framed when a later load brings its candles, whichever load that is', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  let refilled = 0; hub.onSeriesRefilled = () => refilled++;
  void hub.loadSeries(true); await turn(); source.asked[0]!.resolve([]); await turn();
  void hub.loadSeries(true); await turn(); source.asked.at(-1)!.resolve([]); await turn();
  assert.equal(refilled, 0);
  const T = Math.floor(Date.now() / HOUR) * HOUR;
  void hub.loadSeries(true); await turn(); source.asked.at(-1)!.resolve([[T, 1, 1, 1, 1, 1, 1]]); await turn();
  assert.deepEqual([refilled, store.state.candles.length], [1, 1]);
  void hub.loadSeries(true); await turn(); source.asked.at(-1)!.resolve([[T, 1, 1, 1, 2, 1, 1]]); await turn();
  assert.equal(refilled, 1, 'once');
});

test('an empty reload of a series on screen does not frame it again when the next one is good (a zoom made meanwhile stays)', async () => {
  const { hub, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  let refilled = 0; hub.onSeriesRefilled = () => refilled++;
  const T = Math.floor(Date.now() / HOUR) * HOUR;
  void hub.loadSeries(true); await turn(); source.asked[0]!.resolve([[T, 1, 1, 1, 1, 1, 1]]); await turn();
  void hub.loadSeries(true); await turn(); source.asked.at(-1)!.resolve([]); await turn();
  void hub.loadSeries(true); await turn(); source.asked.at(-1)!.resolve([[T, 1, 1, 1, 2, 1, 1]]); await turn();
  assert.equal(refilled, 0);
});

test('the two loads a page starts (its market set, its own) take the one read it started with: one candle request, not two', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); void hub.loadSeries(true); await turn();
  assert.equal(source.asked.length, 1, 'the read the page started with, taken by both');
  const T = Math.floor(Date.now() / HOUR) * HOUR;
  source.asked[0]!.resolve([[T, 1, 1, 1, 3, 1, 1]]); await turn();
  assert.equal(store.state.candles.at(-1)?.[4], 3);
  void hub.loadSeries(true); await turn();
  assert.equal(source.asked.length, 2, 'once it has answered, a reload reads afresh');
});

test('a switch away from the read the page started with drops it: switching back while it is out reads afresh', async () => {
  const { hub, store, source } = await rig({ marketId: 'ref:BTC', timeframe: '1h', seriesInstrument: 'ref:BTC', candles: [] });
  void hub.loadSeries(true); await turn();
  assert.equal(source.asked.length, 1, 'the read the page started with');
  store.set({ timeframe: '5m' }); void hub.loadSeries(true); await turn();
  store.set({ timeframe: '1h' }); void hub.loadSeries(true); await turn();
  assert.equal(source.asked.length, 3, 'the hour asked again, not the early read taken twice');
});
