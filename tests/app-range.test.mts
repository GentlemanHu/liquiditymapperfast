import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTE, draftOf, follow, refreshMs, rowStep, selects, snap, type RangeSelection } from '../src/app/range/selection.ts';
import { draftLabel, priceOf, pricePieces, rangeLines, type RangeInput, type RangeLine } from '../src/app/range/stats.ts';
import type { RangeAnswer, RangeInstrument } from '../src/shared/footprint.ts';
import type { AbsorptionMark } from '../src/app/absorption.ts';
import { setUnits } from '../src/app/units.ts';

const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);

test('a drag becomes the whole minutes it touches; one that reaches the open minute is live and follows the clock', () => {
  const draft = draftOf({ t: T0 + 10 * MINUTE + 20_000, p: 81_900 }, { t: T0 + 2 * MINUTE + 5_000, p: 81_200 });
  assert.deepEqual([draft.t0, draft.t1, draft.p0, draft.p1, draft.draft], [T0 + 2 * MINUTE + 5_000, T0 + 10 * MINUTE + 20_000, 81_200, 81_900, true], 'either way round');
  const made = snap(draft, T0 + 60 * MINUTE);
  assert.deepEqual([made.t0, made.t1, made.live, made.draft], [T0 + 2 * MINUTE, T0 + 11 * MINUTE, false, false]);
  assert.equal(snap(draftOf({ t: T0 + 1_000, p: null }, { t: T0 + 2_000, p: null }), T0 + 60 * MINUTE).t1, T0 + MINUTE, 'a click-sized drag is one minute');
  assert.deepEqual([snap(draftOf({ t: T0, p: 81_000 }, { t: T0 + 5 * MINUTE, p: 81_000 }), T0 + 60 * MINUTE).p0], [null], 'a band with no height is every price');
  // Into the open minute (now is 14:30:40): live, ending with that minute, and moving on with it.
  const now = T0 + 30 * MINUTE + 40_000, live = snap(draftOf({ t: T0 + 20 * MINUTE, p: null }, { t: now + 5 * MINUTE, p: null }), now);
  assert.deepEqual([live.live, live.t1], [true, T0 + 31 * MINUTE]);
  assert.equal(follow(live, now + 10_000), live, 'the same minute: nothing moves');
  assert.equal(follow(live, now + 30_000).t1, T0 + 32 * MINUTE);
  assert.equal(follow(made, now + 10 * MINUTE), made, 'a selection in the past stays');
});

test('a press selects with the tool armed or Ctrl / Cmd held, only with the main button; a live selection is asked again at a pace its answers allow', () => {
  assert.equal(selects(true, { ctrlKey: false, metaKey: false, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: true, metaKey: false, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: false, metaKey: true, button: 0 }), true);
  assert.equal(selects(false, { ctrlKey: false, metaKey: false, button: 0 }), false);
  assert.equal(selects(true, { ctrlKey: false, metaKey: false, button: 2 }), false, 'the right button still zooms');
  assert.deepEqual([refreshMs(5), refreshMs(300), refreshMs(5_000)], [2_000, 6_000, 30_000]);
  assert.equal(refreshMs(300, 24 * 60 * MINUTE), 10_000, 'a long selection is asked no more than every ten seconds');
  assert.equal(rowStep({ p0: 81_000, p1: 82_200 }, 20), 10, 'about 120 rows across a box, on a round step');
  assert.equal(rowStep({ p0: null, p1: null }, 20), 20, 'the map\'s grid for every price');
  assert.equal(rowStep({ p0: 81_000, p1: 81_001 }, 20), 0.5, 'never finer than the recording');
});

const sel = (over: Partial<RangeSelection> = {}): RangeSelection => ({ t0: T0, t1: T0 + 30 * MINUTE, p0: 81_000, p1: 82_000, live: false, draft: false, ...over });
const inst = (id: string, over: Partial<RangeInstrument> = {}): RangeInstrument => ({
  id, band: { buy: 0, sell: 0, buyN: 0, sellN: 0 }, minutes: 30, counted: 30, countedFrom: T0, countedUsd: { buy: 0, sell: 0 }, all: { buy: 0, sell: 0 }, before: { buy: 0, sell: 0, minutes: 30 }, ...over,
});
const answer = (instruments: RangeInstrument[], rows: RangeAnswer['rows'] = []): RangeAnswer => ({ from: T0, to: T0 + 30 * MINUTE, p0: 81_000, p1: 82_000, step: 10, rows, instruments });
const input = (over: Partial<RangeInput> = {}): RangeInput => ({ sel: sel(), answer: null, error: null, marks: [], resting: null, prints: null, kind: id => id.includes('spot') ? 'spot' : 'perp', ...over });
const line = (lines: RangeLine[], key: string): RangeLine | undefined => lines.find(l => l.key === key);

test('the panel adds up the market orders of one set of instruments, the orders behind them and who traded them', () => {
  const lines = rangeLines(input({ answer: answer([
    inst('binance:BTCUSDT', { band: { buy: 6_000_000, sell: 2_000_000, buyN: 300, sellN: 100 }, countedUsd: { buy: 6_000_000, sell: 2_000_000 }, all: { buy: 10_000_000, sell: 6_000_000 }, before: { buy: 4_000_000, sell: 4_000_000, minutes: 30 } }),
    inst('binancespot:BTCUSDT', { band: { buy: 1_000_000, sell: 1_000_000, buyN: 50, sellN: 50 }, countedUsd: { buy: 1_000_000, sell: 1_000_000 }, all: { buy: 2_000_000, sell: 2_000_000 }, before: { buy: 1_000_000, sell: 1_000_000, minutes: 30 } }),
    inst('okx:BTC-USDT-SWAP', { band: { buy: 0, sell: 0, buyN: 0, sellN: 0 } }),
  ], [[81_500, 3_000_000, 1_000_000, 120, 40], [81_600, 500_000, 200_000, 10, 5]]) }));
  assert.equal(line(lines, 'split')!.share, 0.7, 'bought 7M of 10M');
  assert.deepEqual(line(lines, 'delta')!.cells, ['Delta', '+$4M · +40% of the volume']);
  // The average price of each side: each row's middle (rows of 10) weighted by what traded there.
  assert.deepEqual(line(lines, 'avg-price')!.cells, ['Average price', 'bought at 81,519.3 · sold at 81,521.6']);
  assert.deepEqual(line(lines, 'orders')!.cells, ['Orders', '350 buys · 150 sells']);
  assert.deepEqual(line(lines, 'average')!.cells, ['Average order', '$20K buy · $20K sell']);
  assert.equal(line(lines, 'orders-from'), undefined, 'every minute counted: no note');
  assert.deepEqual(line(lines, 'band')!.cells[1], '50% of all market volume in these minutes', '10M of the 20M traded at every price');
  assert.deepEqual(line(lines, 'before')!.cells, ['Against the 30 min before', '×2.0 the volume']);
  // One exchange however many markets: Binance's perpetual and spot together, and an exchange that traded nothing in the band is no row.
  assert.deepEqual(line(lines, 'who-binance')!.cells, ['Binance', '$7M', '$3M', '100%']);
  assert.equal(line(lines, 'who-okx'), undefined);
  assert.deepEqual(line(lines, 'lanes')!.cells, ['Spot · perpetual', '20% · 80%']);
  // The volume profile: every price from the lowest traded to the highest, the highest first, an empty bar where nothing traded.
  const profile = line(lines, 'profile')!.profile!;
  assert.deepEqual(profile.map(b => [b.label, b.total, b.top]), [['81,600', '$700K', false], ['81,590', '', false], ['81,580', '', false], ['81,570', '', false], ['81,560', '', false],
    ['81,550', '', false], ['81,540', '', false], ['81,530', '', false], ['81,520', '', false], ['81,510', '', false], ['81,500', '$4M', true]]);
  assert.deepEqual([profile.at(-1)!.buy, profile.at(-1)!.sell], [0.75, 0.25]);
  assert.deepEqual(line(lines, 'profile-top')!.cells, ['Most traded', '81,500 · $4M · 40% · 160 orders']);
});

test('a profile over more prices than it has bars joins whole rows, and names the busiest bar by its prices', () => {
  const rows: RangeAnswer['rows'] = Array.from({ length: 100 }, (_, i) => [81_000 + i * 10, i === 42 ? 5_000_000 : 100_000, 50_000, 0, 0]);
  const lines = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 14_900_000, sell: 5_000_000, buyN: 0, sellN: 0 }, counted: 0, countedFrom: null })], rows) }));
  const profile = line(lines, 'profile')!.profile!;
  assert.equal(profile.length, 20, 'a hundred rows in bars of five');
  assert.equal(profile.filter(b => b.top).length, 1);
  assert.deepEqual(line(lines, 'profile-top')!.cells, ['Most traded', '81,400 – 81,450 · $5.7M · 28%']);
  assert.match(line(lines, 'profile-note')!.cells[0]!, /in bars of 50$|in bars of 50\.$/);
});

test('the coverage line names the markets counted and those on the map that are not', () => {
  const kind = (id: string): 'spot' | 'perp' => id.includes(':spot') || id.startsWith('binancespot') || id.startsWith('kraken') ? 'spot' : 'perp';
  const lines = rangeLines(input({ kind,
    answer: answer([inst('binance:BTCUSDT', { band: { buy: 1, sell: 1, buyN: 0, sellN: 0 } }), inst('binancespot:BTCUSDT', { band: { buy: 1, sell: 1, buyN: 0, sellN: 0 } }), inst('okx:BTC-USDT-SWAP', { minutes: 0 })]),
    books: [{ id: 'binance:BTCUSDT', on: true }, { id: 'binance:BTCUSDT:spot', on: true }, { id: 'kraken:BTC/USD', on: true }, { id: 'htx:BTC-USDT', on: true }, { id: 'okx:BTC-USDT-SWAP', on: false }] }));
  // Binance's spot book and its spot trades are one market; Kraken and HTX have books and no trades; OKX is off.
  assert.equal(line(lines, 'market-coverage')!.cells[0], 'Counts 2 markets. No trades are recorded for HTX, Kraken: their books are on the map, not in these figures. Switched off or outside the Spot / Perp filter: OKX.');
});

test('the price line asks for candles that lie inside the selection: minutes at its edges, coarser candles between', () => {
  const day = Date.UTC(2026, 9, 12), at = (h: number, m: number) => day + h * 3_600_000 + m * MINUTE;
  assert.deepEqual(pricePieces(at(0, 2), at(6, 2)), [{ tf: '1m', ms: MINUTE, from: at(0, 2), to: at(6, 2) }], '360 minutes: minutes alone');
  // 00:02 to 06:43 (401 minutes): five-minute candles from 00:05 to 06:40, minutes before and after.
  assert.deepEqual(pricePieces(at(0, 2), at(6, 43)), [{ tf: '1m', ms: MINUTE, from: at(0, 2), to: at(0, 5) }, { tf: '5m', ms: 5 * MINUTE, from: at(0, 5), to: at(6, 40) }, { tf: '1m', ms: MINUTE, from: at(6, 40), to: at(6, 43) }]);
  assert.deepEqual(pricePieces(at(0, 0), at(7, 0)), [{ tf: '5m', ms: 5 * MINUTE, from: at(0, 0), to: at(7, 0) }], 'edges on the candles: nothing more');
  assert.equal(pricePieces(day, day + 20 * 86_400_000), null, 'longer than 400 hours: none');
  // A candle that starts before a piece, or after it, is left out; the open is the first inside, the close the last.
  const pieces = pricePieces(at(0, 2), at(6, 43))!;
  const price = priceOf(pieces, [[[at(0, 1), 1, 99, 1, 1, 0], [at(0, 2), 10, 12, 9, 11, 0], [at(0, 4), 11, 13, 10, 12, 0]], [[at(0, 0), 2, 98, 2, 2, 0], [at(0, 5), 12, 20, 8, 15, 0]], [[at(6, 42), 15, 16, 14, 14.5, 0], [at(6, 43), 3, 97, 3, 3, 0]]], 'X');
  assert.deepEqual(price, { market: 'X', tf: '5m', open: 10, close: 14.5, high: 20, low: 8 });
  // In a replay at 06:42:30 the minute under way holds prices it has not reached: left out.
  assert.deepEqual(priceOf(pieces, [[], [[at(0, 5), 12, 20, 8, 15, 0]], [[at(6, 41), 15, 16, 14, 14.8, 0], [at(6, 42), 15, 99, 1, 50, 0]]], 'X', at(6, 42) + 30_000), { market: 'X', tf: '5m', open: 12, close: 14.8, high: 20, low: 8 });
});

test('the two sides of what was absorbed always say 100 % between them', () => {
  const mark = (side: 'buy' | 'sell', usd: number): AbsorptionMark => ({ id: 'binance:BTCUSDT', side, price: 81_000, t0: T0 + MINUTE, t1: T0 + MINUTE + 5, usd, fills: 3, peak: usd, threshold: 100_000 });
  const split = line(rangeLines(input({ marks: [mark('sell', 1_010_000), mark('buy', 990_000)] })), 'abs-split')!;
  assert.deepEqual(split.cells, ['Passive buyers $1M · 51%', 'Passive sellers $990K · 49%'], 'not 51 % and 50 %');
});

test('the average price of a side is its dollars over its coins', () => {
  // Ten coins bought at 10 and five at 20: $200 for 15 coins, 13.33 a coin (not the 15 a dollar-weighted mean gives).
  const lines = rangeLines(input({ answer: { ...answer([inst('a:BTC', { band: { buy: 200, sell: 0, buyN: 0, sellN: 0 } })], [[9.5, 100, 0, 0, 0], [19.5, 100, 0, 0, 0]]), step: 1 } }));
  assert.deepEqual(line(lines, 'avg-price')!.cells, ['Average price', 'bought at 13.33 · sold at –']);
});

test('the price line gives open to close and the high and low of the chart market', () => {
  const lines = rangeLines(input({ price: { market: 'Binance BTCUSDT', tf: '1m', open: 82_000, close: 81_590, high: 82_100, low: 81_500 } }));
  assert.deepEqual(line(lines, 'price-move')!.cells, ['Open → close', '82,000.0 → 81,590.0 · −0.50%']);
  assert.equal(line(lines, 'price-move')!.tone, 'sell');
  assert.deepEqual(line(lines, 'price-range')!.cells, ['High · low', '82,100.0 · 81,500.0 · 0.74%']);
  assert.equal(line(rangeLines(input({ price: null })), 'price-move'), undefined);
});

test('order counts that cover part of the selection say since when, none say so, and an older server says to restart it', () => {
  const partial = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 100, buyN: 1, sellN: 1 }, counted: 12, countedFrom: T0 + 18 * MINUTE, countedUsd: { buy: 100, sell: 100 } })]) }));
  assert.match(line(partial, 'orders-from')!.cells[0]!, /\(12 of 30 minutes\)/);
  const none = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 100, buyN: 0, sellN: 0 }, counted: 0, countedFrom: null })]) }));
  assert.ok(line(none, 'orders-none'));
  assert.equal(line(none, 'average'), undefined, 'no average without counts');
  const gappy = rangeLines(input({ answer: answer([inst('a:BTC', { band: { buy: 100, sell: 0, buyN: 1, sellN: 0 }, minutes: 20, counted: 20 })]) }));
  assert.match(line(gappy, 'coverage')!.cells[0]!, /20 of its 30 minutes/);
  assert.equal(line(gappy, 'before'), undefined, 'no comparison when the selection itself is not all recorded');
  assert.match(line(rangeLines(input({ error: 'older' })), 'market-wait')!.cells[0]!, /restart it/);
});

test('absorption marks are added up against what traded there, and resting orders are given for a box only', () => {
  const mark = (side: 'buy' | 'sell', usd: number, price: number, id = 'binance:BTCUSDT'): AbsorptionMark => ({ id, side, price, t0: T0 + MINUTE, t1: T0 + MINUTE + 5, usd, fills: 3, peak: usd, threshold: 100_000 });
  const lines = rangeLines(input({
    answer: answer([inst('binance:BTCUSDT', { band: { buy: 4_000_000, sell: 2_000_000, buyN: 0, sellN: 0 } })]),
    marks: [mark('sell', 500_000, 81_500), mark('sell', 300_000, 81_500), mark('buy', 400_000, 81_700, 'bybit:BTCUSDT')],
    resting: [{ id: 'binance:BTCUSDT', bid: 3_000_000, ask: 1_000_000 }],
  }));
  // What was absorbed adds up to 100 %: passive buyers took 800K of sells, passive sellers 400K of buys.
  assert.deepEqual(line(lines, 'abs-total')!.cells, ['Absorbed', '$1.2M · 3 marks']);
  assert.deepEqual([line(lines, 'abs-split')!.share, ...line(lines, 'abs-split')!.cells], [800_000 / 1_200_000, 'Passive buyers $800K · 67%', 'Passive sellers $400K · 33%']);
  // Each side against the market orders it could take, the totals written out.
  assert.deepEqual(line(lines, 'abs-of')!.cells, ['Of all market orders', '40% of the $2M sold · 10% of the $4M bought']);
  // By exchange, with the threshold its marks were judged at.
  assert.deepEqual(line(lines, 'abs-v-binance')!.cells, ['Binance', '$800K', '$0', '$100K']);
  assert.deepEqual(line(lines, 'abs-v-bybit')!.cells, ['Bybit', '$0', '$400K', '$100K']);
  assert.deepEqual(line(lines, 'abs-at-buyers')!.cells, ['Passive buyers held at', '81,500 $800K'], 'one price, its marks together');
  assert.deepEqual(line(lines, 'rest-split')!.cells, ['Bids $3M', 'Asks $1M']);
  assert.ok(line(rangeLines(input({ marks: null })), 'abs-off'), 'Absorption off says so');
  const time = rangeLines(input({ sel: sel({ p0: null, p1: null }), answer: answer([inst('a:BTC', { band: { buy: 1, sell: 1, buyN: 0, sellN: 0 } })]) }));
  assert.equal(line(time, 'h-resting'), undefined, 'a stretch of time has no box to rest in');
  assert.equal(line(time, 'prices')!.cells[0], 'Every price');
});

test('absorption at one price is told per side, and the marks are counted as the orders are', () => {
  const mark = (side: 'buy' | 'sell', usd: number, price: number): AbsorptionMark => ({ id: 'binance:BTCUSDT', side, price, t0: T0 + MINUTE, t1: T0 + MINUTE + 5, usd, fills: 3, peak: usd, threshold: 100_000 });
  // At 84,000 passive sellers took market buys and passive buyers took market sells: two lines, never one figure under one side's name
  // (the screenshot of 2026-10-11 said "$29.2M taken by passive sellers" for $28.6M of buys and $0.5M of sells).
  const lines = rangeLines(input({ answer: answer([inst('binance:BTCUSDT', { band: { buy: 40_000_000, sell: 20_000_000, buyN: 0, sellN: 0 } })]),
    marks: [mark('buy', 28_600_000, 84_000), mark('sell', 500_000, 84_000), mark('buy', 1_000_000, 83_500)] }));
  assert.deepEqual(line(lines, 'abs-at-sellers')!.cells, ['Passive sellers held at', '84,000 $28.6M · 83,500 $1M']);
  assert.deepEqual(line(lines, 'abs-at-buyers')!.cells, ['Passive buyers held at', '84,000 $500K']);
  assert.equal(line(lines, 'abs-at-sellers')!.tone, 'sell', 'passive sellers in the sell colour');
  const many = rangeLines(input({ marks: Array.from({ length: 1_647 }, (_, i) => mark('buy', 100_000, 81_000 + i * 0.5)) }));
  assert.deepEqual(line(many, 'abs-total')!.cells, ['Absorbed', '$164.7M · 1,647 marks'], 'with the thousands separated, as the orders are');
  // Marks the page could not hold all of (an answer cut at its limit, or more than it holds) are said to be incomplete, as on the map.
  const cut = rangeLines(input({ marks: [mark('buy', 1_000_000, 84_000)], marksCut: ['bybit:BTCUSDT', 'binance:BTCUSDT', 'bybit:BTCUSDT'] }));
  assert.match(line(cut, 'abs-cut')!.cells[0]!, /^Only the largest marks of (Bybit, Binance|Binance, Bybit) are held for these minutes, so their smaller ones are not counted\.$/);
  assert.equal(line(rangeLines(input({ marks: [], marksCut: [] })), 'abs-cut'), undefined);
});

test('an exchange whose marks were judged at several thresholds (Auto moved, spot and perpetual) gives the middle one, as about', () => {
  const mark = (id: string, threshold: number): AbsorptionMark => ({ id, side: 'buy', price: 81_000, t0: T0 + MINUTE, t1: T0 + MINUTE + 5, usd: 1_000_000, fills: 3, peak: 1_000_000, threshold });
  const lines = rangeLines(input({ marks: [mark('binance:BTCUSDT', 400_000), mark('binance:BTCUSDT', 450_000), mark('binancespot:BTCUSDT', 70_000), mark('okx:BTC-USDT-SWAP', 300_000)] }));
  assert.equal(line(lines, 'abs-v-binance')!.cells[3], '≈$400K', 'the middle of 70K, 400K and 450K');
  assert.equal(line(lines, 'abs-v-okx')!.cells[3], '$300K');
});

test('the tag beside a selection being dragged gives its minutes, and a box its height', () => {
  assert.equal(draftLabel({ ...sel(), t1: T0 + 12 * MINUTE }), '12 min · 1.23%');
  assert.equal(draftLabel({ ...sel({ p0: null, p1: null }), t1: T0 + 3 * 60 * MINUTE }), '3 h');
});

test('coverage is the instrument that recorded the most minutes, in whatever order they come; a selection past the map says what it lacks', () => {
  const lines = rangeLines(input({ answer: answer([
    inst('a:BTC', { band: { buy: 100, sell: 100, buyN: 0, sellN: 0 }, minutes: 10, counted: 10, countedFrom: T0 + 20 * MINUTE }),
    inst('b:BTC', { band: { buy: 100, sell: 100, buyN: 2, sellN: 2 }, minutes: 30, counted: 3, countedFrom: T0 + 27 * MINUTE }),
  ]) }));
  assert.match(line(lines, 'orders-from')!.cells[0]!, /(3 of 30 minutes)/, 'not the 10 of the instrument that recorded less');
  assert.equal(line(lines, 'coverage'), undefined);
  assert.ok(line(rangeLines(input({ partial: true })), 'abs-partial'));
  assert.equal(line(rangeLines(input()), 'abs-partial'), undefined);
});

test('coins (issue 9): the map\'s summary writes each size in the coin at the price it traded at; shares, settings and open interest as in dollars', async () => {
  // Two rows of step 10: 99,995 + 5 = 100,000 and 100,005 + 5 = 100,010 a coin.
  const rows: RangeAnswer['rows'] = [[99_995, 200_000, 100_000, 2, 1], [100_005, 100_010, 0, 1, 0]];
  const ans = answer([inst('a:BTC', { band: { buy: 300_010, sell: 100_000, buyN: 3, sellN: 1 }, countedUsd: { buy: 300_010, sell: 100_000 }, all: { buy: 300_010, sell: 100_000 } })], rows);
  const mark = (side: 'buy' | 'sell', usd: number, price: number) => ({ id: 'a:BTC', t0: T0, t1: T0 + 1, price, usd, side, threshold: 50_000 }) as unknown as AbsorptionMark;
  const liq = { t: T0 + MINUTE, id: 'a:BTC', side: 'long', price: 81_500, usd: 50_000, reported: 100_000, kind: 'single' } as never;
  const prints = [{ id: 'a:BTC', t: T0 + 2 * MINUTE, price: 81_250, usd: 162_500, side: 'buy' }] as never;
  const make = () => rangeLines(input({ answer: ans, marks: [mark('sell', 81_500, 81_500)], liquidations: [liq], liquidationMin: 1_000, prints, resting: [{ id: 'a:BTC', bid: 815_000, ask: 1_630_000 }] as never }));
  const dollars = make();
  setUnits('coin');
  try {
    const lines = make(), cell = (key: string): string => line(lines, key)!.cells.join(' | ');
    assert.equal(cell('split'), 'Bought 3 BTC | Sold 1 BTC', 'each row over its own price');
    assert.match(cell('delta'), /^Delta \| \+2 BTC · \+50% of the volume$/);
    assert.match(cell('average'), /1 BTC buy · 1 BTC sell/, 'the average order at its side\'s average price');
    assert.match(cell('largest'), /^Largest order \| 2 BTC buy · 81,250/, 'at its own price');
    assert.match(cell('liquidations'), /0\.5 BTC longs · 0 BTC shorts .*\(from \$1K\)/, 'at the reported price; the setting in dollars');
    assert.match(cell('abs-total'), /^Absorbed \| 1 BTC/, 'a mark over its own price');
    assert.equal(cell('abs-v-a'), 'A | 1 BTC | 0 BTC | $50K', 'the threshold, which judges, in dollars');
    assert.equal(cell('abs-of'), 'Of all market orders | 82% of the 1 BTC sold · 0% of the 3 BTC bought', 'the shares are the dollars\'');
    assert.equal(cell('who-a'), 'A | 3 BTC | 1 BTC | 100%', 'an exchange at each side\'s average price');
    assert.equal(cell('rest-split'), 'Bids 10 BTC | Asks 20 BTC', 'at the box\'s middle price, 81,500');
    assert.deepEqual(line(lines, 'profile')!.profile!.map(b => b.total).filter(Boolean), ['1 BTC', '3 BTC'], 'every bar\'s volume in coins, the highest price first');
    assert.match(cell('profile-top'), /^Most traded \| 99,995 · 3 BTC · 75%/);
    assert.equal(line(lines, 'split')!.share, line(dollars, 'split')!.share, 'the bar is the dollars\'');
  } finally { setUnits('usd'); }
  assert.deepEqual(make(), dollars, 'back in dollars, the same lines');
});

test('coins (issue 9): the delta\'s share of the volume and its colour are the coin amounts\' beside it, which can lean the other way from the dollars\'', () => {
  // Bought at 200,000 a coin and sold at 100,000: more dollars bought (+$50K), more coins sold (−0.5).
  const rows: RangeAnswer['rows'] = [[199_995, 200_000, 0, 1, 0], [99_995, 0, 150_000, 0, 1]];
  const ans = answer([inst('a:BTC', { band: { buy: 200_000, sell: 150_000, buyN: 1, sellN: 1 }, countedUsd: { buy: 200_000, sell: 150_000 }, all: { buy: 200_000, sell: 150_000 } })], rows);
  const delta = (): RangeLine => line(rangeLines(input({ answer: ans })), 'delta')!;
  assert.deepEqual([delta().cells[1], delta().tone], ['+$50K · +14% of the volume', 'buy'], 'dollars as before');
  setUnits('coin');
  try {
    assert.deepEqual([delta().cells[1], delta().tone], ['−0.5 BTC · −20% of the volume', 'sell'], 'the share and the colour agree with the coin figure');
  } finally { setUnits('usd'); }
});

test('coins (issue 9): absorption by side, by price and past the sixth exchange in coins, each mark over its own price; in dollars as before', () => {
  // Eight exchanges' passive buyers took market sells: a 800K, b 700K … g 200K at 100,000 a coin, and h 100K at 50,000.
  const mark = (venue: string, usd: number, price: number) => ({ id: `${venue}:BTC`, t0: T0, t1: T0 + 1, price, usd, side: 'sell', threshold: 50_000 }) as unknown as AbsorptionMark;
  const marks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v, k) => mark(v, (8 - k) * 100_000, 100_000)).concat(mark('h', 100_000, 50_000));
  const make = () => rangeLines(input({ marks })), cell = (lines: RangeLine[], key: string): string => line(lines, key)!.cells.join(' | ');
  const dollars = make();
  assert.equal(cell(dollars, 'abs-v-rest'), '2 others | $300K | $0 | ');
  assert.equal(cell(dollars, 'abs-at-buyers'), 'Passive buyers held at | 100,000 $3.5M · 50,000 $100K');
  setUnits('coin');
  try {
    const lines = make();
    assert.equal(cell(lines, 'abs-total'), 'Absorbed | 37 BTC · 8 marks');
    assert.equal(cell(lines, 'abs-split'), 'Passive buyers 37 BTC · 100% | Passive sellers 0 BTC · 0%');
    assert.equal(cell(lines, 'abs-v-rest'), '2 others | 4 BTC | 0 BTC | ', 'g\'s 2 and h\'s 2, at its own 50,000');
    assert.equal(cell(lines, 'abs-at-buyers'), 'Passive buyers held at | 100,000 35 BTC · 50,000 2 BTC');
    assert.deepEqual(line(lines, 'abs-v-rest')!.bars, line(dollars, 'abs-v-rest')!.bars, 'the bars are the dollars\'');
  } finally { setUnits('usd'); }
  assert.deepEqual(make(), dollars, 'back in dollars, the same lines');
});
