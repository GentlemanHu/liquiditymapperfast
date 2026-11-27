import test from 'node:test';
import assert from 'node:assert/strict';
import { setUnits } from '../src/app/units.ts';
import { barCoins, barVwap, rowCellAt, rowCellLines, rowText, volText, type Bar } from '../src/app/panes/footprint.ts';
import { detectSide, trapText } from '../src/app/traps.ts';
import { binsBetween, binsIn, levelsInCoins, liqProfile, liqRows, liqStanding, parseLiqLevels, profileMaxima, rowInCoins, standingBelow, standingInCoins, type LiqLevels } from '../src/app/liq-levels.ts';
import { cumulate } from '../src/app/liq-history.ts';
import { coinSplit, splitAmounts, splitText } from '../src/app/liq-words.ts';
import { stripeBoxLines } from '../src/app/liq-box.ts';
import { liqCardLines } from '../src/app/hover-rows.ts';
import { rowBody, saidMax, saidNet, saidTotal, tradedHeader, tradedNetLine, tradedRows, VOLUME_WORDS } from '../src/app/traded.ts';
import { eventRows, flowRows, oiRows, oiSpread, withFlowCoins } from '../src/app/measures/model.ts';
import { candleCoins, joinRows, stripLines, type StripBar } from '../src/app/measures/volume-strip.ts';
import { OI } from '../src/app/measures/defs/oi.ts';
import { blocksOf } from '../src/app/tpo/model.ts';
import type { ProfileAnswer } from '../src/shared/footprint.ts';
import type { CandleRow, OiBar } from '../src/app/store.ts';
import type { DeltaTrack } from '../src/app/delta/candles.ts';

// The map's figures in coins (issue 9): each part's dollars over the price it was valued at, added up after; the dollars unchanged beside them.

const near = (a: number, b: number, what = '', tol = 1e-9): void => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const inCoinsMode = (run: () => void): void => { setUnits('coin'); try { run(); } finally { setUnits('usd'); } };

test('a footprint bar in coins: each row over its middle, the venues\' parts over the same price, the candle the rows added up', () => {
  const bar: Bar = { t: 0, rows: [[100, 1000, 500], [110, 2100, 0]], buyUsd: 3100, sellUsd: 500, parts: [[['a:X', 600, 500], ['b:X', 400, 0]], [['a:X', 2100, 0]]] };
  const c = barCoins(bar, 10);
  near(c.rows[0]![1], 1000 / 105, 'row 0 buy'); near(c.rows[0]![2], 500 / 105, 'row 0 sell'); near(c.rows[1]![1], 2100 / 115, 'row 1 buy');
  near(c.buy, 1000 / 105 + 2100 / 115, 'candle buy'); near(c.sell, 500 / 105, 'candle sell');
  near(c.parts![0]![1]![1], 400 / 105, 'venue part');
  assert.equal(barCoins(bar, 10), c, 'kept beside the bar'); assert.notEqual(barCoins(bar, 5), c, 'another row step is another conversion');
  assert.deepEqual(bar.rows, [[100, 1000, 500], [110, 2100, 0]], 'the bar\'s own dollars are left as they are');
  near(barVwap(bar, 10), 3600 / (1500 / 105 + 2100 / 115), 'the volume-weighted price of its rows');
  assert.ok(Number.isNaN(barVwap({ t: 0, rows: [], buyUsd: 0, sellUsd: 0 }, 10)));
  // Dollars mode prints exactly what it printed; coins print the coin's own figures, never 0 for a fraction.
  assert.equal(rowText(13_400_000), volText(13_400_000)); assert.equal(rowText(0), '0.00');
  inCoinsMode(() => { assert.equal(rowText(0.0523), '0.0523'); assert.equal(rowText(0), '0.00'); assert.equal(rowText(13.24), '13.2'); });
});

test('a footprint row\'s box in coins: its sizes from the coins, whether it is the busiest and its share from the dollars', () => {
  const bar: Bar = { t: 0, rows: [[100, 1000, 500], [110, 2100, 0]], buyUsd: 3100, sellUsd: 500 };
  const usd = rowCellAt(bar, 10, 104)!;
  inCoinsMode(() => {
    const cell = rowCellAt(bar, 10, 104)!;
    near(cell.buy, 1000 / 105); near(cell.sell, 500 / 105); near(cell.barBuy, 1000 / 105 + 2100 / 115);
    assert.equal(cell.poc, usd.poc); assert.equal(cell.share, usd.share);
    const text = rowCellLines(cell, bar, 10, '1h').map(l => l.text);
    assert.ok(text.includes(`${(500 / 105).toFixed(2)} BTC`), text.join(' | '));
  });
  assert.deepEqual(rowCellLines(usd, bar, 10, '1h').find(l => l.label === 'Sold')?.text, '$500');
});

/** The trap test's own rows: 2.5M of net buying in each of rows 106-109 of a candle that opened at 100 and closed at 99. */
const trapRows = (): [number, number, number][] => [[98, 1e5, 2e5], [99, 1e5, 3e5], ...[100, 101, 102, 103, 104, 105].map((p): [number, number, number] => [p, 2e5, 2e5]), ...[106, 107, 108, 109].map((p): [number, number, number] => [p, 3e6, 5e5])];

test('a rejected-flow flag carries its zone in coins, each row over its own middle, the same whatever order the rows come in', () => {
  const candle: CandleRow = [0, 100, 110, 98, 99, 1, 1];
  const trap = detectSide('buyers', candle, trapRows(), 1, 7, 1e6)!, again = detectSide('buyers', candle, [...trapRows()].reverse(), 1, 7, 1e6)!;
  const zone = [106, 107, 108, 109];
  near(trap.zoneBuyCoins, zone.reduce((s, p) => s + 3e6 / (p + 0.5), 0) + [100, 101, 102, 103, 104, 105].reduce((s, p) => s + 2e5 / (p + 0.5), 0), 'zone bought');
  near(trap.zoneDeltaCoins, trap.zoneBuyCoins - trap.zoneSellCoins, 'net');
  assert.deepEqual(trap, again);
  // The sellers' rows are mirrored for the rule, never for their price.
  const sold = detectSide('sellers', [0, 100, 102, 90, 101, 1, 1], [...[90, 91, 92, 93].map((p): [number, number, number] => [p, 5e5, 3e6]), ...[94, 95, 96, 97, 98, 99].map((p): [number, number, number] => [p, 2e5, 2e5]), [100, 3e5, 1e5], [101, 3e5, 1e5]], 1, 7, 1e6)!;
  near(sold.zoneSellCoins, [90, 91, 92, 93].reduce((s, p) => s + 3e6 / (p + 0.5), 0) + [94, 95, 96, 97, 98, 99].reduce((s, p) => s + 2e5 / (p + 0.5), 0), 'sellers\' zone sold');
  inCoinsMode(() => {
    const lines = trapText(trap);
    assert.match(lines[1]!, /^[\d.]+K BTC net aggressive buying in the upper wick/);
    assert.match(lines[2]!, /^Wick volume: [\d.]+K BTC bought and [\d.]+K BTC sold at market \(61% net\); 9\d% of the candle's volume$/, 'the shares are the dollars\'');
  });
  assert.match(trapText(trap)[2]!, /^Wick volume: \$/);
});

/** Levels as the service writes them (format 2), around a mark of 100 on $5 bins: [k, longIso, longCross, shortIso, shortCross, longN, shortN, longTop, shortTop]. */
function levelsOf(bins: number[][], step = 5): LiqLevels {
  const at = Date.UTC(2026, 10, 1);
  return parseLiqLevels({ v: 2, coin: 'BTC', snapshot: { asOf: at, createdAt: at, fetchedAt: at }, mark: 100, positions: 10, step, bins }, 'BTC')!;
}

test('liquidation levels in coins agree with the Depth pane\'s: each bin over the price in its middle, as `cumulate` puts each bucket', () => {
  // Buckets of 5 % from a mark of 100: their middles are 97.5, 92.5, 87.5 below and 102.5, 107.5, 112.5 above, the middles of bins 19, 18, 17 and 20, 21, 22.
  const long = [10, 20, 30], short = [40, 50, 60];
  const depth = cumulate({ asOf: 0, createdAt: 0, fetchedAt: 0, mark: 100 }, { long: Float64Array.from(long), short: Float64Array.from(short) }, [5, 10, 15]);
  const levels = levelsOf([[17, 30, 0, 0, 0, 1, 0, 30, 0], [18, 20, 0, 0, 0, 1, 0, 20, 0], [19, 10, 0, 0, 0, 1, 0, 10, 0], [20, 0, 0, 40, 0, 0, 1, 0, 40], [21, 0, 0, 50, 0, 0, 1, 0, 50], [22, 0, 0, 60, 0, 0, 1, 0, 60]]);
  const coins = standingInCoins(liqStanding(levels, null));
  // The Depth pane keeps its sums in Float32Array: the same to its precision.
  near(standingBelow(coins, 'long', 100), depth.longCoin[2]!, 'longs below the mark', 1e-6);
  near(standingBelow(coins, 'short', 1000) - standingBelow(coins, 'short', 100), depth.shortCoin[2]!, 'shorts above it', 1e-6);
  // The levels' own twin: the same bins and counts, each amount over its middle, made once.
  const twin = levelsInCoins(levels);
  assert.equal(levelsInCoins(levels), twin); assert.deepEqual([...twin.k], [...levels.k]); assert.deepEqual([...twin.longWallets], [...levels.longWallets]);
  near(twin.longTop[0]!, 30 / 87.5); near(twin.shortIso[5]!, 60 / 112.5);
  assert.equal(standingInCoins(liqStanding(levels, null)) === coins, false, 'a new standing is a new conversion');
});

test('a stripe row, the column\'s maxima and the box in coins: the bins converted before they are added, the shares of the dollars', () => {
  const levels = levelsOf([[18, 60, 40, 0, 0, 3, 0, 70, 0], [19, 100, 0, 0, 0, 2, 0, 50, 0], [21, 0, 0, 300, 0, 0, 1, 0, 300]]);
  const [row] = liqRows(levels, null, 2, 90, 100), said = rowInCoins(levels, null, row!);
  near(said.long, 100 / 92.5 + 100 / 97.5, 'two bins of one row'); near(said.longIso, 60 / 92.5 + 100 / 97.5, 'their isolated part'); near(said.longTop, 70 / 92.5, 'the largest');
  assert.equal(said.longWallets, row!.longWallets);
  // The column's MAX figures: what the row with the longest bar holds, in coins, where the dollars put the longest bar.
  const standing = liqStanding(levels, null), prof = liqProfile(standing, 10, 80, 120, 100), m = profileMaxima(prof, liqProfile(standingInCoins(standing), 10, 80, 120, 100));
  near(m.level, 300 / 107.5, 'the 300 short is the longest bar'); near(m.cum, 300 / 107.5, 'and the longest curve');
  inCoinsMode(() => {
    const lines = stripeBoxLines(row!, 'liq', 100, standingInCoins(standing), null, side => side === 'long', null, said);
    const at = lines.find(l => l.label === 'At this level')!, top = lines.find(l => l.label === 'Largest position')!;
    assert.equal(at.text, `${(said.long).toFixed(2)} BTC`);
    assert.equal(top.text, `${(said.longTop).toFixed(3)} BTC (35%)`, 'its share of the level is the dollars\' (70 of 200)');
  });
});

test('the largest position is the one with the most dollars, said in coins, so it never stands beside another bin\'s share', () => {
  // Bin 18 [90, 95) holds a 70 position, bin 19 [95, 100) a 72 one: 72 has the most dollars, though 70 / 92.5 is more coins than 72 / 97.5.
  const levels = levelsOf([[18, 70, 0, 0, 0, 1, 0, 70, 0], [19, 72, 0, 0, 0, 1, 0, 72, 0]]), coins = levelsInCoins(levels);
  const [row] = liqRows(levels, null, 2, 90, 100);
  near(rowInCoins(levels, null, row!).longTop, 72 / 97.5, 'the stripe row\'s');
  assert.equal(rowInCoins(levels, null, row!).longOne, row!.longOne, 'one position holding half of it: the dollars\' call');
  near(binsBetween(levels, 'long', 18, 20, coins).top, 72 / 97.5, 'the card\'s');
  near(binsIn(levels, 'long', 90, 100, coins).top, 72 / 97.5, 'the finger\'s');
  assert.equal(binsBetween(levels, 'long', 18, 20).top, 72, 'dollars as before');
  assert.equal(binsIn(levels, 'long', 90, 100).positions, 2);
});

test('a total and its two parts in coins add up as printed, in the total\'s last figure and unit', () => {
  inCoinsMode(() => {
    for (const [total, a, b] of [[13.24, 9.1, 4.14], [0.01254, 0.004, 0.00854], [5514, 4000, 1514], [12.01, 7.5, 4.51], [551.4, 551.4, 0], [0.35, 0.1, 0.25]]) {
      const [shown, pa, pb] = coinSplit(total!, a!, b!), unit = /[KMBT]$/.exec(shown)?.[0] ?? '', value = (s: string): number => Number(s.replace(/[KMBT]$/, ''));
      const decimals = (s: string): number => s.split('.')[1]?.replace(/[KMBT]$/, '').length ?? 0, places = Math.max(decimals(shown), decimals(pa), decimals(pb));
      assert.equal((value(pa) + value(pb)).toFixed(places), value(shown).toFixed(places), `${total}: ${shown} = ${pa} + ${pb}`);
      if (pa !== '0') assert.ok(pa.endsWith(unit) || unit === '', `${pa} in ${unit}`);
    }
    assert.deepEqual(coinSplit(12.01, 7.5, 4.51), ['12', '7.5', '4.5'], '"12" is 12.0: tenths');
    assert.equal(splitText({ liq: 9.1, stops: 4.14 }, 13.24), 'Total 13.2 BTC = liquidations 9.1 BTC + stops 4.1 BTC');
    assert.deepEqual(splitAmounts(13.24, 9.1, 4.14), coinSplit(13.24, 9.1, 4.14));
  });
  assert.deepEqual(splitAmounts(330_600_000, 200_500_000, 130_100_000), ['330.6M', '200.5M', '130.1M'], 'dollars as before');
  assert.equal(splitText({ liq: 200_500_000, stops: 130_100_000 }), 'Total $330.6M = liquidations $200.5M + stops $130.1M');
});

test('the liquidation card says "left of total" by the figures it prints, in either units', () => {
  const card = (level: number, total: number) => liqCardLines({ kind: 'liq', side: 'long', lo: 90, hi: 100, step: 10, level, total, split: null, positions: 2, top: 0, below: level, above: 0, pct: '5%', totals: false, bandSplit: null })[1]!.text;
  // 1.234 and 1.2341 coins print alike: nothing said taken. In dollars 1,234 and 1,234.4 print alike too.
  inCoinsMode(() => { assert.equal(card(1.234, 1.2341), '1.23 BTC'); assert.equal(card(1.1, 1.234), '1.1 BTC of 1.23 BTC'); });
  assert.equal(card(1_234, 1_234.4), '$1.2K'); assert.equal(card(1_000, 1_234), '$1K of $1.2K');
});

/** A profile answer of one instrument on rows of `step`. */
const answer = (rows: [number, number, number][], step = 10): ProfileAnswer => ({ from: 0, to: 60_000, instruments: [{ id: 'a:X', step, minutes: 1, first: null, earliest: null, rows }] } as unknown as ProfileAnswer);

test('the volume profile in coins: each instrument row over its middle; the point of control, the shares and the bars from the dollars', () => {
  const a = answer([[100, 1000, 500], [110, 4000, 0], [120, 0, 2400]]);
  const usd = tradedRows(a, 10, 100, 130), coins = tradedRows(a, 10, 100, 130, true);
  assert.equal(usd.coins, undefined); assert.deepEqual([...coins.buy], [...usd.buy]); assert.equal(coins.poc, usd.poc);
  near(coins.coins!.buy[1]!, 4000 / 115); near(coins.coins!.sell[2]!, 2400 / 125);
  inCoinsMode(() => {
    near(saidTotal(coins), 1500 / 105 + 4000 / 115 + 2400 / 125, 'total'); near(saidMax(coins), 4000 / 115, 'ROW MAX: the row with the longest bar');
    near(saidNet(coins), 1000 / 105 - 500 / 105 + 4000 / 115 - 2400 / 125, 'net');
    assert.equal(tradedHeader(coins)[0], `TRADED ${(1500 / 105 + 4000 / 115 + 2400 / 125).toFixed(1)}`);
    const body = rowBody(coins, 0, VOLUME_WORDS, null).map(l => l.text);
    assert.deepEqual(body.slice(0, 3), [`${(1000 / 105).toFixed(2)} BTC`, `${(500 / 105).toFixed(2)} BTC`, `+${(500 / 105).toFixed(2)} BTC`]);
    assert.equal(body[3], `${(1500 / 7900 * 100).toFixed(1)} %`, 'its share is of the dollars');
    assert.match(tradedNetLine(coins), /^Δ \+[\d.]+ BTC · /);
  });
  // Dollars as before, and rows asked without coins print dollars.
  assert.equal(tradedHeader(usd)[0], 'TRADED 7.9K'); assert.equal(rowBody(usd, 0, VOLUME_WORDS, null)[0]!.text, '$1K');
});

/** A market's running sums by the second from per-second buys and sells starting at `t0` (whole seconds). */
function track(t0: number, buys: number[], sells: number[]): DeltaTrack {
  const delta: number[] = [], gross: number[] = [];
  let d = 0, g = 0;
  buys.forEach((b, i) => { d += b - sells[i]!; g += b + sells[i]!; delta.push(d); gross.push(g); });
  const at = (sum: number[], sec: number): number => sec < t0 ? 0 : sum[Math.min(sum.length - 1, sec - t0)]!;
  return { first: t0, cumDelta: sec => at(delta, sec), cumGross: sec => at(gross, sec) };
}

test('bands along the top in coins: flow from the coin tracks, events each over their own price, open interest in its own coins', () => {
  // Seconds 11 and 12 at 100, 13 and 14 at 200: each second's buys are one coin. A market counts from the second after its first.
  const dollars = track(9, [0, 0, 100, 100, 200, 200], [0, 0, 0, 0, 0, 0]), coins = track(9, [0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]);
  const rows = withFlowCoins(flowRows([dollars], 10_000, 14_000, 2_000, 20_000), [coins]);
  assert.deepEqual([...rows.buy], [100, 300]); assert.deepEqual([...rows.coins!.buy], [1, 2]);
  const joined = joinRows(rows, withFlowCoins(flowRows([dollars], 14_000, 16_000, 2_000, 20_000), [coins]));
  assert.deepEqual([...joined.coins!.buy], [1, 2, 1]); assert.deepEqual([...joined.buy], [100, 300, 200]);
  assert.equal(joinRows(rows, flowRows([dollars], 14_000, 16_000, 2_000, 20_000)).coins, undefined, 'none where one part has none');
  const events = eventRows([{ t: 0, side: 0, usd: 1000, coins: 0.01 }, { t: 500, side: 1, usd: 2000, coins: 0.025 }], 0, 1000, 1000, { from: 0, to: 1000 }, true);
  assert.deepEqual([...events.buy], [1000]); near(events.coins!.buy[0]!, 0.01); near(events.coins!.sell[0]!, 0.025);
  // A linear market's readings are its coins; an inverse market's USD over the price traded in each minute.
  const MIN = 60_000, bars = (amounts: number[]): OiBar[] => amounts.map((v, i) => [i * MIN, v, v, v, v] as OiBar);
  const flat = { first: 0, cumGross: (s: number) => Math.max(0, s + 1), priceAt: () => 50 };
  const linear = oiSpread([{ id: 'l', bars: bars([10, 12]), track: flat }], 0, 3 * MIN);
  near(linear.parts.reduce((s, p) => s + p.usd, 0), 2 * 50, 'its dollars at the price'); near(linear.parts.reduce((s, p) => s + p.coins!, 0), 2, 'its coins as read');
  const inverse = oiSpread([{ id: 'i', bars: bars([10, 12]), usdAt: 40, track: flat }], 0, 3 * MIN);
  near(inverse.parts.reduce((s, p) => s + p.usd, 0), 2 * 40, 'its own USD'); near(inverse.parts.reduce((s, p) => s + p.coins!, 0), 2 * 40 / 50, 'that USD over the price traded');
  const oi = oiRows([{ t: MIN, usd: 100, coins: 2 }, { t: MIN, usd: -50, coins: -1 }], [[0, 3 * MIN]], 0, 3 * MIN, MIN, 0, true);
  assert.deepEqual([...oi.coins!.buy], [0, 2, 0]); assert.deepEqual([...oi.coins!.sell], [0, 1, 0]);
});

test('a signed share beside a figure in coins is of the coins, so a nearly even bar or column never says two signs', () => {
  // Sells low and buys high: $10 more bought than sold, yet fewer coins bought than sold.
  const rows = tradedRows(answer([[100, 0, 1000], [200, 1010, 0]]), 100, 100, 300, true);
  inCoinsMode(() => {
    const line = tradedNetLine(rows);
    assert.match(line, /^Δ −[\d.]+ BTC · -[\d.]+ %$/, line);
    const bar: StripBar = { t: 0, x: 0, w: 1, source: 'candle', buy: 1010, sell: 1000, split: true, i: -1, gap: null, coins: { buy: 1010 / 205, sell: 1000 / 105 } };
    const net = stripLines(bar, { rows: null, tf: 60_000, now: 120_000, market: 'X', tfName: '1m', reports: true, total: 0 }).find(l => l.label === VOLUME_WORDS.net)!;
    assert.match(net.text, /^−[\d.]+ BTC · −[\d.]+ %$/, net.text); assert.equal(net.color, 'sell');
  });
  assert.match(tradedNetLine(rows), /^Δ \+\$10 · 0\.5 %$/, 'dollars as before');
});

test('open interest\'s change not placed is said in coins only where its coins are known, never over today\'s price', () => {
  const rows = tradedRows(answer([[100, 10_000, 0]]), 10, 100, 110, true);
  inCoinsMode(() => {
    assert.equal(OI.header(rows, { cut: false, incomplete: false, unplaced: 5_000 }).sub, '– not placed');
    assert.equal(OI.header(rows, { cut: false, incomplete: false, unplaced: 5_000, unplacedCoins: 0.05 }).sub, '+0.05 BTC not placed');
  });
  assert.equal(OI.header(rows, { cut: false, incomplete: false, unplaced: 5_000 }).sub, '+$5K not placed');
});

test('a candle\'s coins as the strip and TPO say them: its volume and taker buys read as they are', () => {
  const candle: CandleRow = [0, 100, 110, 90, 105, 8, 1, 6];
  assert.deepEqual(candleCoins(candle, candle), { buy: 6, sell: 2 }, 'split by its taker buys');
  assert.deepEqual(candleCoins([0, 100, 110, 90, 105, 8, 1], undefined), { buy: 8, sell: 0 }, 'all of it where nothing says who bought');
  const quoted: CandleRow = [0, 100, 110, 90, 105, 8, 1, 5, 40, 820, 500];
  assert.deepEqual(candleCoins([0, 100, 110, 90, 105, 9, 1], quoted), { buy: 5, sell: 3 }, 'the exchange\'s own base volumes where its quote volumes are the dollars');
  const blocks = blocksOf([[0, 100, 110, 90, 105, 8], [60_000, 105, 120, 100, 110, 2]] as CandleRow[], 0, 1_800_000, 1_800_000, 60_000, 3_600_000);
  assert.equal(blocks[0]!.coins, 10);
  near(blocks[0]!.usd, 8 * (110 + 90 + 105) / 3 + 2 * (120 + 100 + 110) / 3, 'the dollars as before');
});
