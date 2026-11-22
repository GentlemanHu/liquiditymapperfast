import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub, OI_RECENT_BARS, atPrice, byTime } from '../src/app/hub.ts';
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
/** A market's one-minute bars over [from, to), at most the newest `limit` (a page's Binance read answers its newest 500 readings). */
const bars = (id: string, from: number, to: number, limit = Infinity): OiBar[] => {
  const out: OiBar[] = [];
  // Never a minute that has not begun (a venue answers no reading from the future).
  for (let t = Math.ceil(from / MIN) * MIN; t < to && t <= Date.now(); t += MIN) out.push([t, level(id), level(id), level(id), level(id)]);
  return out.slice(Math.max(0, out.length - limit));
};
/** The largest step between a market's bars on screen (a hole shows as a step much longer than a minute). */
const widestStep = (b: readonly OiBar[]): number => b.slice(1).reduce((w, x, i) => Math.max(w, x[0] - b[i]![0]), 0);
const where = (b: readonly OiBar[]): string => { const i = b.slice(1).findIndex((x, k) => x[0] - b[k]![0] > MIN); return i < 0 ? '' : `step at ${(b[i + 1]![0] - Date.now()) / MIN} min from now (bars from ${(b[0]![0] - Date.now()) / MIN})`; };

async function rig(limit = Infinity) {
  const store = new Store({ ...initialState(), marketId: MARKETS[0]!, timeframe: '1m', oiMarkets: 'chart' }), source = new FakeSource();
  const hub = new Hub(store, source as unknown as DataSource);
  (hub.worker as unknown as FakeWorker).onmessage!({ data: { type: 'ready' } });
  await hub.start();
  const pick = (id: string): string => pickOptions(store.state, null, [], true).find(option => option.id === id)!.pick;
  store.set({ oiMarkets: 'custom', customMarkets: { ...store.state.customMarkets, oi: MARKETS.map(pick) } });
  /** Answer every question out with bars over the window it asked for; `empty` answers nothing. Returns the windows asked. */
  const answer = (empty = false): { id: string; from: number; to: number }[] => {
    const out = source.asked.splice(0);
    for (const q of out) q.resolve(empty ? [] : bars(q.id, q.from, q.to, q.id.startsWith('binance') ? limit : Infinity));
    return out.map(({ id, from, to }) => ({ id, from, to }));
  };
  const first = (): number[] => store.state.oiParts.map(p => p.bars[0]![0]);
  return { hub, store, source, answer, first };
}

/** Moves the hub's clock on (`Date.now`), the test's own timers left alone; returns the undo. */
function clockAhead(ms: number): () => void { const real = Date.now; Date.now = () => real() + ms; return () => { Date.now = real; }; }

test('a view reaching before the recent candles reads the older bars once, and keeps them through the refreshes', async () => {
  const r = await rig(), now = Date.now(), recent = (Math.floor(now / MIN) - OI_RECENT_BARS) * MIN;
  const whole = r.hub.loadOi(); await turn();
  const asked = r.answer(); await whole;
  assert.deepEqual(asked.map(q => q.id), MARKETS);
  assert.ok(asked.every(q => Math.abs(q.from - recent) <= MIN), 'the whole read asks the recent candles');

  const t0 = now - 800 * MIN;
  r.hub.oiReach(t0); r.hub.oiReach(t0); await turn();
  assert.equal(r.source.asked.length, 0, 'nothing asked while the view may still be moving');
  await settle();
  const older = r.answer();
  assert.deepEqual(older.map(q => q.id), MARKETS);
  assert.ok(older.every(q => q.from === (Math.floor(t0 / MIN) - 1) * MIN && Math.abs(q.to - recent) <= MIN), 'from a candle before the view to where the recent candles begin');
  await turn();
  assert.ok(r.first().every(t => t === older[0]!.from), 'the bars on screen now start there');
  assert.ok(r.store.state.oi.length > 700 && r.store.state.oi.every(b => b[4] === 300), 'the sum over every bar, older ones included');

  r.hub.oiReach(now - 600 * MIN); r.hub.oiReach(t0); await settle();
  assert.equal(r.source.asked.length, 0, 'a view inside what is held, or a repeat, asks nothing');
  r.hub.oiReach(now - 900 * MIN); await settle();
  const more = r.answer(); await turn();
  assert.ok(more.every(q => q.to === older[0]!.from && q.from === (Math.floor((now - 900 * MIN) / MIN) - 1) * MIN), 'only the stretch before the one held');
  const start = r.first()[0]!;

  const tail = r.hub.loadOi(); await turn();
  const tails = r.answer(); await tail;
  assert.ok(tails.every(q => q.from >= now - 10 * MIN), 'the 20-second refresh reads the newest bars only');
  assert.deepEqual(r.first(), [start, start], 'and trims nothing');
  r.store.state.oiParts.forEach(p => assert.equal(widestStep(p.bars), MIN, 'no hole'));
});

test('the bars that leave the recent candles go to the older ones: no hole however long the tab stays, though a read answers only its newest 500', async () => {
  // A page's Binance read answers the newest 500 readings of a window (`limit=500`); asked from where the older bars ended, the bars between
  // them and the recent candles were in neither read, a hole that grew with the tab's age (review, 2026-11-22).
  const r = await rig(500), now = Date.now();
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  r.hub.oiReach(now - 900 * MIN); await settle(); r.answer(); await turn();
  const start = r.first()[0]!;
  r.store.state.oiParts.forEach(p => assert.equal(widestStep(p.bars), MIN, `after the older read: no hole in ${p.id} ${where(p.bars)}`));
  for (const minutes of [11, 22, 33, 120]) {
    const undo = clockAhead(minutes * MIN);
    try {
      const again = r.hub.loadOi(); await turn();
      const read = r.answer(); await again;
      const recent = (Math.floor(Date.now() / MIN) - OI_RECENT_BARS) * MIN;
      assert.ok(read.every(q => q.from === recent), `${minutes} min on: the whole read asks the recent candles only`);
    } finally { undo(); }
    assert.deepEqual(r.first(), [start, start], `${minutes} min on: the older bars stay`);
    r.store.state.oiParts.forEach(p => assert.equal(widestStep(p.bars), MIN, `${minutes} min on: no hole in ${p.id} ${where(p.bars)}`));
  }
});

test('a tail read under way when the older bars land does not trim them', async () => {
  const r = await rig(), now = Date.now();
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  const tail = r.hub.loadOi(); await turn();
  const tails = r.source.asked.splice(0);
  r.hub.oiReach(now - 800 * MIN); await settle(); r.answer(); await turn();
  const start = r.first()[0]!;
  assert.ok(start < now - 700 * MIN, 'the older bars are on screen');
  for (const q of tails) q.resolve(bars(q.id, q.from, q.to));
  await tail;
  assert.deepEqual(r.first(), [start, start], 'the tail kept them');
});

test('an older read that comes back empty where history is expected is asked again a minute later, three times at most', async () => {
  const r = await rig(), now = Date.now(), t0 = now - 800 * MIN;
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  r.hub.oiReach(t0); await settle();
  assert.equal(r.answer(true).length, 2, 'asked, and nothing came back (a page\'s source answers a failure so)');
  await turn();
  r.hub.oiReach(t0); await settle();
  assert.equal(r.source.asked.length, 0, 'not again within the minute');
  for (const tries of [2, 3]) {
    const undo = clockAhead((tries - 1) * 61_000);
    try { r.hub.oiReach(t0); await settle(); } finally { undo(); }
    assert.equal(r.answer(true).length, 2, `asked again (${tries})`); await turn();
  }
  const undo = clockAhead(3 * 61_000);
  try { r.hub.oiReach(t0); await settle(); } finally { undo(); }
  assert.equal(r.source.asked.length, 0, 'after three empty answers the stretch is taken as having none');
});

test('runs of bars put together by time, and an inverse market\'s at the one price of the bars they join', () => {
  assert.deepEqual(byTime([[1, 1, 1, 1, 1], [2, 2, 2, 2, 2]], [[2, 9, 9, 9, 9], [3, 3, 3, 3, 3]]).map(b => [b[0], b[4]]), [[1, 1], [2, 9], [3, 3]]);
  const held = { usdAt: 50_000, bars: [[0, 2, 2, 2, 2]] as OiBar[] };
  assert.deepEqual(atPrice(held, 40_000), [[0, 2.5, 2.5, 2.5, 2.5]], 'the same USD over the other price');
  assert.deepEqual(atPrice(held, undefined), held.bars, 'a price unknown leaves them');
  assert.deepEqual(atPrice({ bars: held.bars }, 40_000), held.bars, 'a market in coins as it is');
});

test('older bars belong to their markets and timeframe: another choice does not show them', async () => {
  const r = await rig(), now = Date.now(), recent = (Math.floor(now / MIN) - OI_RECENT_BARS) * MIN;
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  r.hub.oiReach(now - 800 * MIN); await settle(); r.answer(); await turn();
  assert.ok(r.first().every(t => t < recent - 200 * MIN), 'the older bars are on screen');
  r.store.set({ oiMarkets: 'chart' });
  const other = r.hub.loadOi(); await turn(); r.answer(); await other;
  assert.equal(r.store.state.oiInstrument, MARKETS[0]);
  assert.ok(r.store.state.oi[0]![0] >= recent - MIN, 'its bars start with the recent candles');
});

test('back to a choice after its bars left the screen, or after a tab slept past its window: the older bars are read again, no hole', async () => {
  for (const how of ['switch', 'sleep'] as const) {
    const r = await rig(), now = Date.now();
    const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
    r.hub.oiReach(now - 900 * MIN); await settle(); r.answer(); await turn();
    if (how === 'switch') {
      // Another choice for a while (its bars replace these on screen), then back once the bars read lately are too old to show at once.
      r.store.set({ oiMarkets: 'chart' }); const b = r.hub.loadOi(); await turn(); r.answer(); await b;
    }
    const undo = clockAhead((how === 'switch' ? 30 : 12 * 60) * MIN);
    try {
      if (how === 'switch') r.store.set({ oiMarkets: 'custom' });
      const back = r.hub.loadOi(); await turn(); r.answer(); await back;
      r.store.state.oiParts.forEach(p => assert.equal(widestStep(p.bars), MIN, `${how}: no hole in ${p.id} ${where(p.bars)}`));
      r.hub.oiReach(Date.now() - 900 * MIN); await settle();
      assert.ok(r.answer().length > 0, `${how}: the older stretch is asked again`); await turn();
      r.store.state.oiParts.forEach(p => assert.equal(widestStep(p.bars), MIN, `${how}: after it, no hole in ${p.id} ${where(p.bars)}`));
      assert.ok(r.first().every(t => t < Date.now() - 800 * MIN), `${how}: and the bars reach back again`);
    } finally { undo(); }
  }
});

test('an empty older read is asked again three times a key, however the view moves meanwhile', async () => {
  const r = await rig(), now = Date.now();
  const whole = r.hub.loadOi(); await turn(); r.answer(); await whole;
  let asked = 0;
  // The view's left edge a candle further back each minute: each step asks the window it adds, empty every time.
  for (let k = 0; k < 6; k++) {
    const undo = clockAhead(k * 61_000);
    try { r.hub.oiReach(now - (800 + k) * MIN); await settle(); } finally { undo(); }
    if (r.answer(true).length) asked++; await turn();
  }
  assert.equal(asked, 6, 'each new window asked once');
  // The view stops: its window was taken as having none after the third empty answer of the key, so it is not asked again every minute.
  let again = 0;
  for (const k of [7, 8]) {
    const undo = clockAhead(k * 61_000);
    try { r.hub.oiReach(now - 805 * MIN); await settle(); } finally { undo(); }
    if (r.answer(true).length) again++; await turn();
  }
  assert.equal(again, 0, 'a view that stays asks nothing more');
});
