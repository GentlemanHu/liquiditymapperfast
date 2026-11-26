import test from 'node:test';
import assert from 'node:assert/strict';
import { setUnits } from '../src/app/units.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { Ranker } from '../src/app/cvd/rank.ts';
import { buildModel } from '../src/app/cvd/model.ts';
import { CVD_DEFAULTS } from '../src/app/cvd/settings.ts';
import { laneNet, laneRange, sharedRange } from '../src/app/cvd/hero.ts';
import { aggregateLabel, divergence, rowHover, rowLabel } from '../src/app/cvd/text.ts';
import { buildStrip, pulseRows, rowLines, sizeBands, sizeRows, windowCoins } from '../src/app/cvd/strip.ts';
import { BLOCK, TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { SecondTally } from '../src/app/trades/tally.ts';
import { BlockReader, OrderScan, coincidences, emptyBlock, repeats, type FlowLike, type NoteOrder } from '../src/app/trades/blocks.ts';
import { buildLiqRows, liqCoins, summarizeLiqsIn } from '../src/app/trades/liquidations.ts';
import { TapeTally } from '../src/app/candle/model.ts';
import { alertText, windowCoinDelta, type AlertEntry } from '../src/app/sound/alerts.ts';
import { inspectorModel } from '../src/app/panes/trades-inspector.ts';
import { deltaRow } from '../src/app/panes/delta-pane.ts';
import type { Liquidation } from '../src/shared/liquidations.ts';
import type { SizesWindow } from '../src/shared/footprint.ts';

const close = (a: number, b: number, msg = ''): void => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);
/** Run `body` with the page writing coins, and back to dollars whatever happens. */
function inCoinMode(body: () => void): void { setUnits('coin'); try { body(); } finally { setUnits('usd'); } }

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0), SEC = NOW / 1000;
const P = 'binance:BTCUSDT', S = 'binancespot:BTCUSDT';
const kinds: Record<string, 'spot' | 'perp'> = { [P]: 'perp', [S]: 'spot' };

/**
 * Sixty seconds ending at NOW: the perpetual buys $1,000 a second and the spot sells $600, the first thirty at a price of 100, the last thirty
 * at 200. In coins the perpetual bought 30 × 10 + 30 × 5 = 450 and the spot sold 30 × 6 + 30 × 3 = 270, each second over its own price.
 */
function flow(): FlowBook {
  const book = new FlowBook();
  for (let i = 59; i >= 0; i--) {
    const sec = SEC - i, px = i >= 30 ? 100 : 200;
    book.apply([[P, sec * 1000, 1_000, 0, px], [S, sec * 1000, 0, 600, px]]);
  }
  return book;
}

test('the flow column in coins: lines and labels from the coin series, ranking and the divergence note still on the dollars', () => {
  const book = flow(), ids = [P, S];
  const build = (coins: boolean) => buildModel({ flow: book, ids, kindOf: id => kinds[id] ?? null, t0: NOW - 60_000, t1: NOW + 1_000, columns: 61, now: NOW, settings: { ...CVD_DEFAULTS, span: '1h', rank: '1h' }, ranker: new Ranker(), coins });
  const usd = build(false);
  assert.equal(usd.perp!.coins, undefined, 'a model in dollars carries no coins');
  close(usd.perp!.delta, 60_000); close(laneNet(usd.perp, true)!, 60_000, 'dollars: the line ends at the dollars');
  book.setCoins(true);
  const coins = build(true);
  close(coins.perp!.delta, 60_000, 'the figures stay the dollars'); close(coins.perp!.coins!.delta, 450); close(coins.spot!.coins!.delta, -270);
  close(coins.perp!.coins!.buy, 450); close(coins.spot!.coins!.sell, 270);
  close(laneNet(coins.perp, true)!, 450, 'the line is drawn in coins'); close(laneNet(coins.spot, true)!, -270);
  close(coins.rows[0]!.lanes[1]!.coins!.delta, 450, 'a venue row\'s perpetual lane'); close(coins.rows[0]!.coins!.gross, 450 + 270, 'the row\'s coins traded');
  assert.deepEqual(coins.rows.map(r => [r.key, r.share]), usd.rows.map(r => [r.key, r.share]), 'ranked and shared by the dollars');
  // The note is judged on the dollars: 36K sold against 60K bought passes a 10K line though neither side has 10K coins.
  assert.ok(divergence(coins, 10_000));
  inCoinMode(() => {
    const label = aggregateLabel(coins, 120).map(l => l.text).join(' | ');
    assert.match(label, /\+450 BTC/); assert.match(label, /−270 BTC/); assert.match(label, /\+180 BTC/);
    const row = rowLabel(coins.rows[0]!, '1H', 120, false).map(l => l.text).join(' | ');
    assert.match(row, /720 BTC/); assert.doesNotMatch(row, /\$/);
    const hover = rowHover(coins.rows[0]!, 60, NOW, '1H');
    assert.ok(hover.some(l => l.label === 'Perp buys / sells' && l.text === '450 BTC / 0 BTC'));
  });
  assert.match(aggregateLabel(usd, 120).map(l => l.text).join(' | '), /\+\$60K/, 'dollars as they were');
});

test('a nearly flat line is padded by a dollar in its own units: the same picture in coins as in dollars', () => {
  const price = 90_000;
  const usd = laneRange({ min: 1_000, max: 1_000.4 }, false)!, coins = laneRange({ min: 1_000 / price, max: 1_000.4 / price }, false, 1 / price)!;
  close(coins.lo * price, usd.lo); close(coins.hi * price, usd.hi);
  const both = sharedRange([{ min: -0.2, max: 0.2 }, null], true)!, bothCoins = sharedRange([{ min: -0.2 / price, max: 0.2 / price }, null], true, 1 / price)!;
  close(bothCoins.lo * price, both.lo); close(bothCoins.hi * price, both.hi);
  const flatCoins = laneRange({ min: 1_000 / price, max: 1_000.4 / price }, false)!;
  assert.ok(flatCoins.hi - flatCoins.lo > 2, 'a dollar floor read as coins would squash the line flat');
});

test('the dot rows in coins: the flow rows from the coin series, the size rows at the flow\'s own price over their window', () => {
  const book = flow(); book.setCoins(true);
  const pulse = pulseRows(book, [P, S], SEC, () => null, true);
  close(pulse[3]!.coins!.buy, 450); close(pulse[3]!.coins!.sell, 270); close(pulse[3]!.buy, 60_000, 'the dollars stay');
  assert.equal(pulseRows(book, [P, S], SEC, () => null)[3]!.coins, undefined);
  const perUsd = windowCoins(book, [P, S], SEC, 60);
  close(perUsd, (450 + 270) / (60_000 + 36_000), 'coins traded over dollars traded');
  const window: SizesWindow = { minutes: 60, seen: 60, stats: 60, buyN: 3, sellN: 3, buy: [10_000, 0, 0, 0, 0, 0, 0, 0], sell: [5_000, 0, 0, 0, 0, 0, 0, 0] };
  const rows = sizeRows(sizeBands(CVD_DEFAULTS), window, 60, [], perUsd);
  for (const r of rows) { close(r.coins!.buy, r.buy * perUsd); close(r.coins!.sell, r.sell * perUsd); }
  const data = buildStrip({ flow: book, counted: [P, S], nowSec: SEC, settings: { ...CVD_DEFAULTS }, scope: 'all', sizes: null, state: 'loading', coins: true });
  inCoinMode(() => {
    const lines = rowLines(data.pulse[3]!, data);
    assert.ok(lines.some(l => l.label === 'Buys / sells' && l.text === '450 BTC / 270 BTC')); assert.ok(lines.some(l => l.label === 'Net' && l.text === '+180 BTC'));
    assert.ok(lines.some(l => l.label === 'Buy share' && l.text === '63%'), 'the share stays the dollars\' (60K of 96K)');
  });
});

/** A batch of orders: [market, exchange time, price, signed usd]. */
function batch(seq: number, rows: [string, number, number, number][]): TapeBatch {
  const ids = [...new Set(rows.map(r => r[0]))], n = rows.length;
  const b: TapeBatch = { seq, dropped: 0, ids, inst: new Int32Array(n), t: new Float64Array(n), price: new Float64Array(n), usd: new Float32Array(n), lo: new Float64Array(n), hi: new Float64Array(n) };
  rows.forEach(([id, t, price, usd], i) => { b.inst[i] = ids.indexOf(id); b.t[i] = t; b.price[i] = price; b.usd[i] = usd; b.lo[i] = price - 1; b.hi[i] = price + 1; });
  return b;
}
const T0 = 1_800_000_000_000;

/** How many typed arrays of a kind `body` makes (the class is swapped for a counting one while it runs). */
function arraysMade(kind: 'Float32Array' | 'Float64Array', body: () => void): number {
  const real = globalThis[kind] as unknown as new (...a: unknown[]) => object;
  let made = 0;
  (globalThis as Record<string, unknown>)[kind] = class extends real { constructor(...a: unknown[]) { super(...a); made++; } };
  try { body(); } finally { (globalThis as Record<string, unknown>)[kind] = real; }
  return made;
}

test('the per-second tally keeps no coins: a second\'s are its dollars over that second\'s own price, worked out when read', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[P, T0 + 100, 50_000, 100_000], [P, T0 + 200, 40_000, 80_000], [P, T0 + 300, 50_000, -25_000], [S, T0 + 400, 50_000, 500]]), 1, 0);
  const tally = new SecondTally(60);
  tally.reset(ring, { minUsd: 1_000, side: 'both', shown: () => true });
  // A market met makes its dollars' arrays and no more (bought, sold and volume in Float32, the price sums in Float64), as it always did.
  assert.equal(arraysMade('Float32Array', () => { while (tally.filling) tally.fill(); }), 2 * 3, 'two markets, three Float32 arrays each');
  const sl = tally.slot(T0 / 1000), m = ring.ids.indexOf(P), s = ring.ids.indexOf(S);
  // The second's own volume-weighted price is every order of the market in it, filtered or not: 205K at 46,098.
  close(tally.vwap(m, sl), (50_000 * 100_000 + 40_000 * 80_000 + 50_000 * 25_000) / 205_000);
  close(tally.buy(m, sl), 180_000); close(tally.buyCoins(m, sl), 180_000 / tally.vwap(m, sl), 'to within the second\'s range of prices (exactly 4 order by order)');
  close(tally.sellCoins(m, sl), 25_000 / tally.vwap(m, sl));
  assert.equal(tally.buyCoins(s, sl), 0, 'under the size floor: no dollars, no coins');
  // Dollars with no price: not known.
  const free = new TapeRing(BLOCK);
  free.add(batch(1, [[P, T0 + 100, 0, 5_000]]), 1, 0);
  const none = new SecondTally(60); none.reset(free, { minUsd: 0, side: 'both', shown: () => true }); while (none.filling) none.fill();
  assert.ok(Number.isNaN(none.buyCoins(0, none.slot(T0 / 1000))));
});

test('a block read in coins adds each part at its own price: the tape\'s orders, the flow\'s coin series, the recording, liquidations', () => {
  const ring = new TapeRing(BLOCK);
  ring.add(batch(1, [[P, T0 + 30_000, 50_000, 100_000], [P, T0 + 31_000, 40_000, -80_000]]), 1, 0);
  const tally = new SecondTally(3600); tally.reset(ring, { minUsd: 0, side: 'both', shown: () => true }); while (tally.filling) tally.fill();
  // Before the tape's covered start, the flow: $30K bought, in coins 0.6.
  const series = (buy: number, sell: number): FlowLike => ({ buy: () => buy, sell: () => sell, ownPrice: () => 50_000, span: { first: T0 / 1000 - 100, last: T0 / 1000 + 100 } });
  const f: FlowLike = { ...series(30_000, 0), coins: series(0.6, 0) };
  const r = new BlockReader(); r.tally = tally; r.markets = [P]; r.ref = P; r.setVenues(1, () => 0); r.flowOf = () => f;
  const out = emptyBlock(1), now = T0 + 3_600_000;
  r.read(T0 / 1000, 60, out, now);
  close(out.buy, 130_000); assert.equal(out.cBuy, 0, 'a reader in dollars adds no coins');
  assert.equal(out.topBuy.coins, 0, 'nor works out a named order\'s'); assert.equal(r.marketRows(T0 / 1000, 60)[0]!.cBuy, undefined);
  const key = r.dataKey();
  r.coinsOn = () => true;
  assert.notEqual(r.dataKey(), key, 'another units is another key: kept blocks are read again');
  r.read(T0 / 1000, 60, out, now);
  close(out.buy, 130_000); close(out.cBuy, 2 + 0.6); close(out.cSell, 2);
  close(out.topBuy.coins, 2, 'a named order\'s coins, its dollars over its own price'); close(out.topSell.coins, 2);
  const rows = r.marketRows(T0 / 1000, 60);
  close(rows[0]!.cBuy!, 2.6); close(rows[0]!.cSell!, 2); close(rows[0]!.buy, 130_000);
  // Liquidations: each over its reported price, never the market price it is drawn at.
  const liq = (t: number, side: 'long' | 'short', usd: number, price: number, reported: number): Liquidation => ({ t, id: P, side, price, usd, reported, kind: 'bankruptcy' });
  r.mode = 'liquidations'; r.liqItems = [liq(T0 + 1_000, 'short', 12_000, 60_100, 60_000), liq(T0 + 2_000, 'long', 25_000, 49_900, 50_000)]; r.liqMinUsd = 1_000; r.liqSince = T0;
  r.read(T0 / 1000, 60, out, now);
  close(out.cBuy, 0.2); close(out.cSell, 0.5); close(out.cLiqBuy, 0.2); close(out.topSell.coins, 0.5);
  close(r.marketRows(T0 / 1000, 60)[0]!.cSell!, 0.5);
});

test('liquidation rows and windows count coins over the reported price, grouped rows added up', () => {
  const mk = (t: number, usd: number, reported: number, price = 70_000): Liquidation => ({ t, id: P, side: 'long', price, usd, reported, kind: 'fill' });
  const items = [mk(1_000, 7_000, 70_000), mk(1_100, 13_800, 69_000, 69_900)];
  const [row] = buildLiqRows(items, { minUsd: 0, side: 'both', shown: () => true }, true, undefined, true);
  close(row!.coins, 0.1 + 0.2); close(liqCoins(items[1]!), 0.2);
  assert.equal(buildLiqRows(items, { minUsd: 0, side: 'both', shown: () => true }, true)[0]!.coins, 0, 'rows built in dollars do none of the coins\' work');
  const sum = summarizeLiqsIn(items, 0, 2_000, { minUsd: 0, side: 'both', shown: () => true }, true);
  close(sum.coins!.sell, 0.3); assert.equal(summarizeLiqsIn(items, 0, 2_000, { minUsd: 0, side: 'both', shown: () => true }).coins, undefined);
});

test('the inspector\'s scan in coins: each order\'s coins (its own price, or the one given), the coincidences and the repeated sizes too', () => {
  const scan = new OrderScan(id => id.split(':')[0]!);
  scan.reset(9, 0, 100_000, true);
  const orders: [string, number, number, number][] = [[P, 0, 150_000, 50_000], ['okx:BTC-USDT-SWAP', 2, 200_000, 50_000]];
  for (const [id, t, usd, price] of orders) scan.add(id.startsWith('binance') ? 0 : 1, id, t, usd, price, price, price);
  for (let i = 0; i < 5; i++) scan.add(0, P, 1_000 + i, 800, 40_000 + i * 100, 0, 0);
  scan.add(1, 'okx:BTC-USDT-SWAP', 5_000, -50_000, 1, 1, 1, 0.7);
  close(scan.largest[0]!.coins!, 4); close(scan.largest.find(o => o.usd === -50_000)!.coins!, 0.7, 'the coins given (a liquidation\'s)');
  const [c] = coincidences(scan.big, 100_000);
  close(c!.coins!, 3 + 4);
  const [run] = scan.repeats();
  close(run!.coins!, (800 / 40_400 + 800 / 40_000) / 2, 'the middle of the run\'s smallest and largest coins');
  // The standalone forms agree, and give no coins for orders that carry none (nor does a scan in dollars).
  assert.deepEqual(coincidences(scan.big, 100_000), coincidences(scan.big.map(o => ({ ...o })), 100_000));
  const plain: NoteOrder[] = scan.big.map(({ coins: _, ...o }) => o);
  assert.equal(coincidences(plain, 100_000)[0]!.coins, undefined);
  assert.equal(repeats(plain).length, 0);
  // A scan in dollars keeps no coins anywhere, its repeats included, even after one in coins (out-of-order orders take its sort).
  const dollars = new OrderScan(id => id); dollars.reset(9, 0, 100_000);
  dollars.add(0, P, 0, 150_000, 50_000, 0, 0);
  assert.equal(dollars.largest[0]!.coins, undefined); assert.equal(dollars.big[0]!.coins, undefined);
  scan.reset(9, 0, 100_000);
  for (const i of [4, 2, 0, 3, 1]) scan.add(0, P, 1_000 + i, 800, 40_000, 0, 0);
  const [plainRun] = scan.repeats();
  assert.equal(plainRun!.n, 5); assert.equal(plainRun!.coins, undefined); assert.deepEqual(scan.repeats(), repeats([4, 2, 0, 3, 1].map(i => ({ t: 1_000 + i, id: P, venue: 'binance', usd: 800 }))));
  scan.reset(9, 0, 100_000, true);
  for (const i of [4, 2, 0, 3, 1]) scan.add(0, P, 1_000 + i, 800, 40_000 + i * 100, 0, 0);
  close(scan.repeats()[0]!.coins!, (800 / 40_400 + 800 / 40_000) / 2, 'a scan in coins again: the coins sorted with the times');
});

test('the inspector writes coins in coin mode: markets, largest orders, notes in their own sentences, liquidations', () => {
  const block = { ...emptyBlock(1), unknown: false, from: 1, n: 3, s: T0 / 1000, B: 60 };
  const input = {
    block, state: 'held' as const, time: '12:00', marketCount: 1, ref: P, minUsd: 0, recordedFloor: 25_000,
    rows: [{ id: P, buy: 130_000, sell: 80_000, move: Number.NaN, cBuy: 2.6, cSell: 2 }],
    coincidences: [{ side: 1 as const, t: 0, usd: 350_000, venues: ['binance', 'okx'], coins: 7 }],
    repeats: [{ id: P, side: 1 as const, n: 5, lo: 800, hi: 801, ms: 4, coins: 0.02 }],
    largest: [{ t: T0, id: P, usd: 100_000, price: 50_000, lo: 50_000, hi: 50_000, coins: 2 }],
    liquidations: { buy: 12_000, sell: 0, n: 1, largest: [{ id: P, side: 'short' as const, usd: 12_000, t: T0, price: 60_100, coins: 0.2 }], coins: { buy: 0.2, sell: 0 } },
  };
  const usd = inspectorModel(input);
  assert.equal(usd.markets[0]!.buy, '$130K'); assert.match(usd.notes[0]!.text, /\$350K within 5 ms/); assert.match(usd.notes[1]!.text, /about \$801/);
  inCoinMode(() => {
    const m = inspectorModel(input);
    assert.equal(m.markets[0]!.buy, '2.6 BTC'); assert.equal(m.markets[0]!.sell, '2 BTC');
    assert.equal(m.notes[0]!.text, '▲ 7 BTC within 5 ms on 2 venues (Binance, OKX)'); assert.match(m.notes[1]!.text, /5 × about 0\.02 BTC in 4 ms/);
    assert.equal(m.largest[0]!.usd, '▲ 2 BTC'); assert.equal(m.liquidations!.items[0]!.usd, '◆ 0.2 BTC'); assert.match(m.liquidations!.summary, /Shorts liquidated 0\.2 BTC/);
    assert.equal(inspectorModel({ ...input, rows: [{ id: P, buy: 1, sell: 0, move: Number.NaN }] }).markets[0]!.buy, '–', 'no coins read: none written');
  });
});

test('the phone Tape keeps no coins: a row\'s are its bins\' dollars each over the price in the bin\'s middle, worked out when read', () => {
  const tape = new TapeTally(0);
  // Its first market makes its dollars' array; another market, one more; an order on a market met, none: no coins are kept.
  assert.equal(arraysMade('Float64Array', () => tape.add(P, 81_001, 81_001)), 1);
  assert.equal(arraysMade('Float64Array', () => tape.add(S, 81_008, 162_016)), 1);
  assert.equal(arraysMade('Float64Array', () => tape.add(P, 81_002, -40_501)), 0);
  // The fine step is 2 (a tenth of the grid's 20): 81,001 is in [81,000, 81,002), 81,002 in [81,002, 81,004), 81,008 in [81,008, 81,010).
  assert.equal(tape.fine, 2);
  const rows = tape.rows(8, null), coins = tape.coinRows(8, null);
  assert.deepEqual(coins.map(r => r[0]), rows.map(r => r[0]), 'the rows the dollars list, one for one');
  close(coins[0]![1], 81_001 / 81_001); close(coins[0]![2], 40_501 / 81_003); close(coins[1]![1], 162_016 / 81_009); assert.equal(coins[1]![2], 0);
  close(tape.coinRows(8, [S])[0]![1], 162_016 / 81_009, 'only the markets asked for');
  assert.equal(tape.coinRows(8, null), tape.coinRows(8, null), 'kept while no order came');
  assert.deepEqual(tape.rows(8, null), rows, 'reading the coins leaves the dollars as they were');
  // Far away prices make the bins wider (16 fine steps here): a bin's middle moves with them, within half a bin of each order's own price.
  tape.add(P, 120_000, 120_000);
  tape.add(P, 40_000, -40_000);
  const w = tape.binWidth, bin = (price: number): number => Math.floor(Math.floor(price / tape.fine * (1 + 1e-12)) / (w / tape.fine));
  const inBin = (price: number, usd: number): number => usd / ((bin(price) + 0.5) * w);
  const orders: [number, number][] = [[81_001, 81_001], [81_002, 40_501], [81_008, 162_016], [120_000, 120_000], [40_000, 40_000]];
  const all = tape.rows(w * 4, null), allCoins = tape.coinRows(w * 4, null);
  assert.equal(allCoins.length, all.length);
  close(allCoins.reduce((a, r) => a + r[1] + r[2], 0), orders.reduce((a, [price, usd]) => a + inBin(price, usd), 0));
  for (const [price, usd] of orders) assert.ok(Math.abs(inBin(price, usd) - usd / price) <= usd / price * (w / 2) / price, `${price}: within half a bin`);
  const before = tape.coinRows(w * 4, null);
  tape.add(P, 81_001, 81_001);
  assert.notEqual(tape.coinRows(w * 4, null), before, 'worked out again once an order came');
  close(tape.coinRows(w * 4, null).reduce((a, r) => a + r[1] + r[2], 0), orders.reduce((a, [price, usd]) => a + inBin(price, usd), 0) + inBin(81_001, 81_001));
});

test('an alert keeps its coins from when it fired, written when the Recent list shows: in dollars as it fired, in coins its coins', () => {
  const words = (size: string): string => `Bid wall appeared: ${size}`;
  const wall: AlertEntry = { at: 0, panel: 'book', kind: 'wall-appeared', side: 'buy', text: words('$4.5M'), audible: true, sent: 0, size: { usd: 4_500_000, coins: 50, signed: false, words } };
  const delta = (d: string): string => `1h candle closed with ${d} of net taker flow`;
  const bar: AlertEntry = { at: 0, panel: 'bars', kind: 'bar-delta', side: 'sell', text: delta('−$2.1M'), audible: true, sent: 0, size: { usd: -2_100_000, coins: -23.5, signed: true, words: delta } };
  assert.equal(alertText(wall), 'Bid wall appeared: $4.5M'); assert.equal(alertText(bar), bar.text);
  inCoinMode(() => {
    assert.equal(alertText(wall), 'Bid wall appeared: 50 BTC');
    assert.equal(alertText(bar), '1h candle closed with −23.5 BTC of net taker flow');
    assert.equal(alertText({ ...bar, size: { ...bar.size!, coins: Number.NaN } }), '1h candle closed with – of net taker flow', 'coins not known when it fired: a dash');
    assert.equal(alertText({ ...wall, size: undefined }), wall.text);
  });
});

test('an alert\'s coins come from the dollars\' series as it fires: each second over its own price, else the last before it, NaN without one', () => {
  const book = new FlowBook();
  // Five seconds: $1,000 bought at 100, nothing traded, $600 sold with no price of its own (the last, 100, holds), $2,000 bought at 200.
  book.apply([[P, (SEC - 4) * 1000, 1_000, 0, 100], [P, (SEC - 3) * 1000, 0, 0, 0], [P, (SEC - 2) * 1000, 0, 600, 0], [P, (SEC - 1) * 1000, 2_000, 0, 200]]);
  const series = book.get(P)!;
  assert.equal(series.coins, undefined, 'in dollars no coin series is kept, and none is needed');
  close(windowCoinDelta(series, SEC - 4, SEC), 10 - 6 + 10); close(windowCoinDelta(series, SEC - 2, SEC - 2), -6);
  close(windowCoinDelta(series, SEC - 100, SEC + 100), 14, 'the seconds the series holds, as its dollars count them');
  assert.equal(windowCoinDelta(series, SEC + 10, SEC + 20), 0, 'nothing traded: none');
  const unpriced = new FlowBook(); unpriced.apply([[P, SEC * 1000, 500, 0]]);
  assert.ok(Number.isNaN(windowCoinDelta(unpriced.get(P)!, SEC, SEC)), 'a second that moved with no price at all: not known');
  assert.equal(series.coins, undefined, 'still no coin series kept');
});

test('a Delta table row in coins: half a cent\'s worth of coin is nothing, not half a coin', () => {
  const price = 90_000, floor = 0.005 / price;
  assert.deepEqual(deltaRow('Thin', 0.004, 0.004, 0.004, floor), { name: 'Thin', buys: 0.004, sells: 0, delta: 0.004, share: 1 });
  assert.equal(deltaRow('Thin', 0.004, 0.004, 0.004).buys, 0, 'the dollars\' floor read as coins would drop it');
  assert.equal(deltaRow('Residue', 1e-12, 1e-12, 1, floor).buys, 0, 'a residue is still nothing');
});
