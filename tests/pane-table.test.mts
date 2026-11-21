import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneTable, headed, paintTable, placeTable, ratioCell, ratioFigure, sideRatio, tableInk, tableLines, type TableCell, type TableRoom, type TableSpec } from '../src/app/panes/pane-table.ts';
import { fundingAt, type FundingNow, type FundingRow } from '../src/app/funding.ts';
import { fundingAllCardLines, fundingAllNow, fundingCardLines, fundingTableRows } from '../src/app/panes/funding-pane.ts';
import { lsCardLines, lsTableRows } from '../src/app/panes/ls-pane.ts';
import { bookNames, depthTableRows, ltHeads, ltRank, ltRowsAt, ltTableRows, oiTableRows } from '../src/app/panes/lower-panes.ts';
import type { LtParts } from '../src/app/lt.ts';
import { deltaCardLines, deltaRow, deltaTableRows } from '../src/app/panes/delta-pane.ts';
import { depthCardLines, liqCardLines, ltCardLines, oiCardLines } from '../src/app/panes/pane-cards.ts';
import { nlnsWhoLines, type NlnsCandle } from '../src/app/delta/nlns.ts';
import type { HourOpens } from '../src/app/delta/nlns-source.ts';
import type { InfoLine } from '../src/app/infobox.ts';
import { tableRowCap } from '../src/app/panes/pane-table.ts';
import { foldCount } from '../src/app/pane-tune.ts';
import type { Market } from '../src/app/store.ts';
import { oiVenuesAt, sumOi, type OiPart } from '../src/app/oi-change.ts';
import type { OiBar } from '../src/app/store.ts';
import type { LsSeries } from '../src/shared/long-short.ts';
import { readSettings } from '../src/app/store.ts';

/** Every character five pixels wide. */
const measure = (text: string): number => text.length * 5;
const room = (over: Partial<TableRoom> = {}): TableRoom => ({ w: 700, h: 140, plotW: 400, axisW: 60, pointing: false, ...over });
const cells = (...texts: string[]): TableCell[] => texts.map(text => ({ text }));
const spec = (rows = 5, minCols = 3): Pick<TableSpec, 'heads' | 'rows' | 'minCols'> => ({ heads: ['', 'Longs', 'Shorts', 'Diff'], minCols, rows: Array.from({ length: rows }, () => cells('name', '123', '456', '+789')) });

test('a table goes beside the plot where it has the room, the last columns going first, and on a plate only under a pointer', () => {
  // Widths 20 + 25 + 30 + 20 = 95, three gaps of 7, two pads of 5: 126 for all four, 99 without the last.
  const four = placeTable(measure, room({ w: 400 + 60 + 130 }), spec())!;
  assert.deepEqual([four.cols, four.left, four.plate, four.width], [4, 404, false, 126]);
  const three = placeTable(measure, room({ w: 400 + 60 + 110 }), spec())!;
  assert.deepEqual([three.cols, three.left, three.plate, three.width], [3, 404, false, 99]);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 90 }), spec()), null, 'no room beside the plot and no pointer: nothing covers the chart at rest');
  const plate = placeTable(measure, room({ w: 400 + 60 + 90, pointing: true }), spec())!;
  assert.deepEqual([plate.cols, plate.left, plate.plate, plate.width], [4, 6, true, 126], 'under a pointer it goes over the left end, with every column');
  assert.equal(placeTable(measure, room({ w: 150 + 60, plotW: 150, pointing: true }), spec()), null, 'wider than 60 % of the plot: no plate');
  // Columns may go down to `minCols` and no further.
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 72 }), spec(5, 2))!.cols, 2);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 72 }), spec(5, 3)), null);
});

test('a short pane closes the rows up, then leaves out the titles, then the foot, and past that has no table', () => {
  const at = (h: number) => { const p = placeTable(measure, room({ h }), spec()); return p && [p.rowH, p.titles, p.foot]; };
  assert.deepEqual(at(109), [15, true, true], 'seven lines of 15 and four pixels');
  assert.deepEqual(at(102), [14, true, true]);
  assert.deepEqual(at(88), [12, true, true], 'the lowest row height');
  assert.deepEqual(at(87), [13, false, true], 'without the titles the rows open up again');
  assert.deepEqual(at(64), [12, false, false], 'without the foot');
  assert.equal(at(63), null);
});

test('the columns line up on their right edges, and the rows sit in the middle of the pane', () => {
  const p = placeTable(measure, room({ w: 590 }), spec())!;
  assert.deepEqual(p.rights, [429, 461, 498, 525], 'left 404, pad 5, then each width and a gap of 7');
  assert.deepEqual([p.y0, p.first], [Math.round(70 - 105 / 2), Math.round(70 - 105 / 2) + 15]);
});

test('painting: a lit row, a row under the pointer, the colours, the foot, and only the columns that fit', () => {
  const calls: (string | number)[][] = [];
  const ctx = { fillStyle: '', strokeStyle: '', globalAlpha: 1, textAlign: 'left', fillText: (s: string, x: number, y: number) => calls.push(['text', s, x, y, ctx.fillStyle, ctx.textAlign]), fillRect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h, ctx.globalAlpha]), strokeRect: () => calls.push(['stroke']) };
  const rows: TableCell[][] = [[{ text: 'A' }, { text: '1', color: 'green' }, { text: '2' }], [{ text: 'B' }, { text: '3', color: 'green' }, { text: '4' }]];
  const s: TableSpec = { heads: ['', 'H1', 'H2'], rows, foot: 'then', minCols: 2, focus: 0 };
  const at = { rowH: 15, titles: true, foot: true, cols: 2, left: 10, plate: false, width: 50, y0: 20, first: 35, rights: [20, 40], height: 60, summary: [], summaryW: 50, summaryH: 0, complete: false };
  paintTable(ctx as unknown as CanvasRenderingContext2D, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, at, s, 1);
  assert.deepEqual(calls, [
    ['text', 'H1', 40, 27.5, 'M', 'right'],
    ['rect', 12, 35, 46, 15, 0.1],
    ['text', 'A', 15, 42.5, 'T', 'left'],
    ['text', '1', 40, 42.5, 'green', 'right'],
    ['rect', 12, 50, 46, 15, 0.05],
    ['text', 'B', 15, 57.5, 'M', 'left'],
    ['text', '3', 40, 57.5, 'green', 'right'],
    ['text', 'then', 15, 72.5, 'M', 'left'],
  ]);
  calls.length = 0;
  paintTable(ctx as unknown as CanvasRenderingContext2D, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, { ...at, plate: true, titles: false, foot: false, cols: 3, rights: [20, 40, 60], height: 30 }, { ...s, focus: -1 }, -1);
  assert.deepEqual(calls.slice(0, 3).map(c => c[0]), ['rect', 'stroke', 'text'], 'on a plate, drawn before its rows');
  assert.ok(calls.some(c => c[1] === '2'), 'with every column');
  assert.ok(!calls.some(c => c[1] === 'H2' || c[1] === 'then'), 'no titles and no foot where they do not fit');
});

test('the pointer over a table: a row lit and chosen by a click or a tap, the click after a tap the same choice; a table with no action takes no row; a cleared one nothing', () => {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = { addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), getBoundingClientRect: () => ({ left: 10, top: 100 }), style: { cursor: '' } };
  let redraws = 0; const chosen: number[] = [];
  const host = { canvas: canvas as unknown as HTMLCanvasElement, left: () => 20, rangeGesture: () => false, invalidate: () => { redraws++; } };
  const ctx = { measureText: (s: string) => ({ width: measure(s) }), fillText: () => undefined, fillRect: () => undefined, strokeRect: () => undefined } as unknown as CanvasRenderingContext2D;
  const palette = { panel: 'P', line: 'L', text: 'T', muted: 'M' }, full: TableSpec = { ...spec(), foot: 'then', focus: -1 };
  const table = new PaneTable(host, row => chosen.push(row));
  const at = table.draw(ctx, palette, room({ w: 590 }), full)!;
  const y = at.first + 2 * at.rowH + 1, inside = at.left + 3;
  assert.equal(table.owns(inside, { y: 100 + y }), true, 'over the table it is the table\'s');
  assert.deepEqual([redraws, canvas.style.cursor], [1, 'pointer'], 'the row is lit, and says it can be clicked');
  listeners.get('click')!({ clientX: 10 + 20 + inside, clientY: 100 + y, pointerType: 'mouse' });
  assert.deepEqual(chosen, [2]);
  assert.equal(table.tap({ x: inside, y }), true);
  assert.deepEqual(chosen, [2, 2]);
  listeners.get('click')!({ clientX: 10 + 20 + inside, clientY: 100 + y, pointerType: 'mouse' });
  assert.deepEqual(chosen, [2, 2], 'the click the browser sends after a tap is not a second choice');
  assert.equal(table.tap({ x: at.left - 5, y }), false, 'beside the table a tap is not the table\'s');
  assert.equal(table.owns(at.left - 5, { y: 100 + y }), false);
  table.clear();
  assert.equal(table.owns(inside, { y: 100 + y }), false, 'not drawn this frame: it takes no pointer');
  // No action: it still owns the pointer over it, so that it can be read, but takes no row and adds no listener.
  listeners.clear();
  const plain = new PaneTable(host);
  plain.draw(ctx, palette, room({ w: 590 }), full);
  assert.equal(listeners.size, 0);
  assert.equal(plain.owns(inside, { y: 100 + y }), true);
  assert.equal(plain.tap({ x: inside, y }), false);
});

test('the tables are on by default, for a save or a layout from before them, and stay off once switched off', () => {
  const on = readSettings({});
  assert.deepEqual([on.fundingTable, on.oiTable, on.lsTable, on.ltTable, on.deltaTable, on.sizesTable], [true, true, true, true, true, true]);
  const off = readSettings({ fundingTable: false, oiTable: false, lsTable: false, ltTable: false, deltaTable: false, sizesTable: false });
  assert.deepEqual([off.fundingTable, off.oiTable, off.lsTable, off.ltTable, off.deltaTable, off.sizesTable], [false, false, false, false, false, false]);
});

const H = 3_600_000, T = Date.UTC(2026, 10, 6, 0), MIN = 60_000;

test('what a venue reads at a time: its settled row, the reading now over the interval under way, its newest record after it', () => {
  const rows: FundingRow[] = [{ t: T + 8 * H, rate: 1e-4, per8h: 1e-4, hours: 8 }, { t: T + 16 * H, rate: 2e-4, per8h: 2e-4, hours: 8 }];
  const now: FundingNow = { rate: 3e-4, per8h: 3e-4, hours: 8, next: T + 24 * H, premium: null };
  assert.deepEqual(fundingAt(rows, now, T + 4 * H, T + 20 * H), { row: rows[0], forming: false });
  assert.deepEqual(fundingAt(rows, now, T + 20 * H, T + 20 * H), { row: { t: T + 24 * H, rate: 3e-4, per8h: 3e-4, hours: 8 }, forming: true });
  assert.deepEqual(fundingAt(rows, null, T + 20 * H, T + 20 * H), { row: rows[1], forming: false }, 'a venue that says nothing of the time under way: its newest record');
  assert.deepEqual(fundingAt(rows, now, T - H, T + 20 * H), { row: null, forming: false }, 'before anything is held');
  // The interval under way has settled, its record in before the next reading now: the settled row stands.
  const settled = [...rows, { t: T + 24 * H, rate: 4e-4, per8h: 4e-4, hours: 8 }];
  assert.deepEqual(fundingAt(settled, now, T + 20 * H, T + 25 * H), { row: settled[2], forming: false });
});

const PALETTE = { bid: '#00ff00', ask: '#ff0000', text: '#000000', muted: '#888888' };

test('the Funding table: per eight hours, the yearly rate, the premium where it is held, a dash where a venue says nothing', () => {
  const rows = fundingTableRows([{ name: 'Binance', per8h: 0.0001, premium: -0.0004 }, { name: 'Deribit', per8h: 0, premium: null }, { name: 'OKX', per8h: null, premium: null }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '+0.0100%', '+10.95%', '−0.0400%'], ['Deribit', '0.0000%', '0.00%', '–'], ['OKX', '–', '–', '–']]);
  assert.notEqual(rows[0]![1]!.color, rows[0]![3]!.color, 'funding paid by longs and a negative premium in different colours');
  assert.equal(rows[1]![1]!.color, undefined, 'zero has no side');
});

const bar = (t: number, oi: number): OiBar => [t, oi, oi, oi, oi];
test('the OI table: each venue as the sum counts it, its own change, its share, the largest first', () => {
  const parts: OiPart[] = [
    { id: 'bybit:BTCUSDT', bars: [bar(T, 30), bar(T + H, 35)] },
    { id: 'binance:BTCUSDT', bars: [bar(T, 100), bar(T + H, 90)] },
    { id: 'okx:BTC-USDT-SWAP', bars: [bar(T + H, 25)] },
  ];
  const at = oiVenuesAt(parts, H, T + H);
  assert.deepEqual(at.map(v => [v.id, v.oi, v.change]), [['binance:BTCUSDT', 90, -10], ['bybit:BTCUSDT', 35, 5], ['okx:BTC-USDT-SWAP', 25, null]], 'a venue with nothing a bar before has no change, not its whole open interest');
  assert.deepEqual(at.map(v => Math.round(v.share * 150)), [90, 35, 25], 'each one\'s share of the three');
  const sum = sumOi(parts, H);
  assert.equal(at.reduce((n, v) => n + v.oi, 0), sum.bars.find(b => b[0] === T + H)![4], 'the rows add up to the sum at that bar');
  assert.equal(at.reduce((n, v) => n + (v.change ?? 0), 0), sum.change.get(T + H), 'and their changes to its change');
  assert.deepEqual(oiVenuesAt(parts, H, T).map(v => v.id), ['binance:BTCUSDT', 'bybit:BTCUSDT'], 'the order is each one\'s newest reading, at any bar; a venue with nothing yet is left out');
  assert.deepEqual(oiVenuesAt(parts, H, T - 5 * H), [], 'before any reading: no rows');
  // A venue whose reading is carried: read every five minutes on a one-minute chart.
  const sparse: OiPart[] = [{ id: 'a:X', bars: [bar(T, 10), bar(T + 5 * MIN, 12)] }, { id: 'b:X', bars: [bar(T, 1), bar(T + MIN, 1), bar(T + 2 * MIN, 1), bar(T + 3 * MIN, 1), bar(T + 4 * MIN, 1), bar(T + 5 * MIN, 1)] }];
  assert.deepEqual(oiVenuesAt(sparse, MIN, T + 3 * MIN).map(v => [v.id, v.oi, v.change]), [['a:X', 10, 0], ['b:X', 1, 0]], 'its last reading, held');
  assert.deepEqual(oiTableRows(at, PALETTE).map(r => r.map(c => c.text)), [['Binance', '90', '−10', '60%'], ['Bybit', '35', '+5', '23%'], ['OKX', '25', '–', '17%']]);
});

test('the Long/Short table: long, short and their ratio at the moment read, dashes where a venue has no reading', () => {
  const series: LsSeries[] = [
    { id: 'binance:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: T, long: 0.556 }] },
    { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: H, status: 'failed', points: [{ t: T, long: 0.4 }] },
    { id: 'okx:BTC-USDT-SWAP', population: 'accounts', periodMs: H, status: 'ok', points: [] },
    { id: 'bitget:BTCUSDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T, long: 0.5 }] },
  ] as unknown as LsSeries[];
  const rows = lsTableRows(series, T + 30 * MIN, PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '55.6%', '44.4%', '1.25'], ['Bybit', '–', '–', '–'], ['OKX', '–', '–', '–'], ['Bitget', '50.0%', '50.0%', '1.00']]);
  assert.deepEqual(rows[3]!.slice(1).map(c => c.color), [PALETTE.muted, PALETTE.muted, PALETTE.muted], 'an earlier reading after a failed update is muted');
  assert.notEqual(rows[0]![1]!.color, PALETTE.muted);
});

test('the Liquidity Tracker table: bids, asks, the imbalance signed, and the share only outside the Per level mode', () => {
  const rows = ltTableRows([{ name: 'Binance', bid: 29_900_000, ask: 40_500_000, share: 0.21 }, { name: '7 others', bid: 44_800_000, ask: 45_900_000, share: 0.26 }, { name: 'Kraken', bid: 0, ask: 0, share: 0 }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '29.9M', '40.5M', '−15%', '21%', '1.35×'], ['7 others', '44.8M', '45.9M', '−1%', '26%', '1.02×'], ['Kraken', '0', '0', '0%', '0%', '–']]);
  assert.equal(rows[2]![3]!.color, PALETTE.muted, 'no lean: muted');
  assert.equal(rows[0]![5]!.color, rows[0]![2]!.color, 'the asks lead: the ratio in their colour');
  assert.deepEqual(ltTableRows([{ name: 'OKX', bid: 300, ask: 100, share: null }], PALETTE).map(r => r.map(c => c.text)), [['OKX', '300', '100', '+50%', '3.00×']], 'Per level: no share column');
});

test('the Delta table: buys, sells, the delta signed and the share of the volume', () => {
  const rows = deltaTableRows([{ name: 'Binance', buys: 3_000_000, sells: 1_000_000, delta: 2_000_000, share: 0.8 }, { name: '2 others', buys: 400_000, sells: 600_000, delta: -200_000, share: 0.2 }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['Binance', '3M', '1M', '+2M', '80%', '3.00×'], ['2 others', '400K', '600K', '−200K', '20%', '1.50×']]);
  assert.deepEqual([rows[0]![5]!.color, rows[1]![5]!.color], [rows[0]![1]!.color, rows[1]![2]!.color], 'the ratio in the colour of the side that leads');
  assert.notEqual(rows[0]![3]!.color, rows[1]![3]!.color, 'a buying delta and a selling one in their sides\' colours');
});

test('book names: the venue\'s, and the spot market says so only where two would read the same', () => {
  const markets = [
    { id: 'binance:BTCUSDT', instrumentId: 'binance:BTCUSDT', marketType: 'perpetual' },
    { id: 'binance:BTCUSDT:spot', instrumentId: 'binance:BTCUSDT:spot', marketType: 'spot' },
    { id: 'coinbase:BTC-USD', instrumentId: 'coinbase:BTC-USD', marketType: 'spot' },
    { id: 'bybitspot:BTCUSDT', instrumentId: 'bybitspot:BTCUSDT', marketType: 'spot' },
  ] as unknown as Market[];
  assert.deepEqual(bookNames(['binance:BTCUSDT', 'binance:BTCUSDT:spot', 'coinbase:BTC-USD', 'bybitspot:BTCUSDT'], markets), ['Binance', 'Binance Spot', 'Coinbase', 'Bybit spot']);
});

test('a table of many markets keeps a row each for as many as fit at 13 px with its titles and foot, at most eight', () => {
  assert.deepEqual([40, 56, 69, 82, 108, 134, 400].map(tableRowCap), [0, 2, 3, 4, 6, 8, 8]);
  // Whatever the cap, the rows it allows (with the titles and the foot) fit the pane, so placeTable never leaves the table out for its rows.
  for (let h = 30; h < 300; h++) { const k = tableRowCap(h); if (k) assert.ok(placeTable(measure, room({ h }), spec(k)), `h ${h}, ${k} rows`); }
});

test('a header folds as few of its last controls as leave the figures their room, and all of them where nothing does', () => {
  const widths = [100, 90, 80], key = 22;
  // The row's width with the last k folded: the fixed part, the controls left, the key where one folded.
  const need = (k: number): number => 300 + widths.slice(0, widths.length - k).reduce((a, b) => a + b, 0) + (k ? key : 0);
  assert.equal(foldCount(3, 600, need), 0, 'everything fits');
  assert.equal(foldCount(3, 569, need), 1, 'the last one folds (and the key takes its place)');
  assert.equal(foldCount(3, 450, need), 2);
  assert.equal(foldCount(3, 300, need), 3, 'too narrow even folded: all of them, and the row wraps');
});

/** A series of `windows` windows with each market's parts given row by row (NaN: nothing), its lines their sums (pooled in the Per level mode). */
function ltSeriesOf(rows: number[][][], weights?: number[][][]): { times: Float64Array; bid: Float32Array; ask: Float32Array; parts: LtParts } {
  const owners = rows.length, windows = rows[0]!.length;
  const parts: LtParts = { bid: new Float32Array(owners * windows), ask: new Float32Array(owners * windows) };
  if (weights) { parts.wBid = new Float32Array(owners * windows); parts.wAsk = new Float32Array(owners * windows); }
  const bid = new Float32Array(windows), ask = new Float32Array(windows);
  for (let k = 0; k < windows; k++) {
    let b = 0, a = 0, wb = 0, wa = 0;
    rows.forEach((row, m) => {
      const [x, y] = row[k]!; parts.bid[m * windows + k] = x!; parts.ask[m * windows + k] = y!;
      if (weights) { const [u, v] = weights[m]![k]!; parts.wBid![m * windows + k] = u!; parts.wAsk![m * windows + k] = v!; if (!Number.isNaN(x!)) { wb += u!; wa += v!; } }
      if (!Number.isNaN(x!)) { b += x!; a += y!; }
    });
    bid[k] = weights ? (wb > 0 ? b / wb : 0) : b; ask[k] = weights ? (wa > 0 ? a / wa : 0) : a;
  }
  return { times: Float64Array.from({ length: windows }, (_, k) => k * MIN), bid, ask, parts };
}

test('the Liquidity Tracker table\'s order: the most liquidity on average over the windows each holds, the newest window alone changing nothing much, a market with none left out', () => {
  // Market 1 is a little larger in the newest window, market 0 over the three: market 0 first. Market 2 has nothing at all.
  const s = ltSeriesOf([[[50, 50], [50, 50], [40, 40]], [[30, 30], [30, 30], [45, 45]], [[NaN, NaN], [NaN, NaN], [NaN, NaN]]]);
  assert.deepEqual(ltRank(s.parts, 3, 3, 3), [0, 1]);
  // Market 1 recorded over the last window only, twice market 0's size there: it is not put below for the windows it lacks.
  const late = ltSeriesOf([[[10, 10], [10, 10], [10, 10]], [[NaN, NaN], [NaN, NaN], [20, 20]]]);
  assert.deepEqual(ltRank(late.parts, 3, 2, 3), [1, 0]);
  assert.deepEqual(ltRank(s.parts, 3, 3, 1), [0, 1], 'a replay cut to the first window ranks on that window alone');
  const tie = ltSeriesOf([[[10, 10]], [[10, 10]]]);
  assert.deepEqual(ltRank(tie.parts, 1, 2, 1), [0, 1], 'equal ones keep the markets\' order');
});

test('the Liquidity Tracker table\'s rows: the cap and the rest, a market with nothing in the window left out, and every row as many cells as the heads', () => {
  const s = ltSeriesOf([[[40, 60]], [[30, 30]], [[NaN, NaN]], [[20, 10]], [[5, 5]]]);
  const names = ['A', 'B', 'C', 'D', 'E'], order = ltRank(s.parts, 1, 5, 1);
  const rows = ltRowsAt(s, names, order, 0, 3);
  assert.deepEqual(rows.map(r => [r.name, r.bid, r.ask, r.share]), [['A', 40, 60, 0.5], ['B', 30, 30, 0.3], ['2 others', 25, 15, 0.2]], 'C has nothing there: neither a row nor among the rest');
  assert.equal(ltRowsAt(s, names, order, 0, 4).length, 4, 'all four fit: no rest row');
  assert.deepEqual(ltRowsAt(s, names, order, 0, 0), [], 'no room for a row: no table');
});

test('a Liquidity Tracker window that reads nothing (a size filter no bin passes) draws its table with a share of 0, never a short row', () => {
  // Present everywhere (a book's column with nothing counted is a zero), so the lines read 0 and so do the parts.
  const s = ltSeriesOf([[[0, 0]], [[0, 0]], [[0, 0]]]);
  const rows = ltRowsAt(s, ['A', 'B', 'C'], ltRank(s.parts, 1, 3, 1), 0, 2);
  assert.deepEqual(rows.map(r => r.share), [0, 0], 'a share of the empty lines is 0, not missing');
  const heads = ltHeads(s.parts), cells = ltTableRows(rows, PALETTE);
  assert.equal(heads.length, 6);
  assert.ok(cells.every(r => r.length === heads.length), 'every row has the heads\' columns');
  const ctx = { measureText: (t: string) => ({ width: measure(t) }), fillText: () => undefined, fillRect: () => undefined, strokeRect: () => undefined } as unknown as CanvasRenderingContext2D;
  const spec = { heads, rows: cells, minCols: 3, foot: 'newest 00:00', focus: -1 };
  const at = placeTable(measure, room({ w: 900, h: 140 }), spec)!;
  assert.equal(at.cols, 6);
  assert.doesNotThrow(() => paintTable(ctx, { panel: 'P', line: 'L', text: 'T', muted: 'M' }, at, spec, -1));
});

test('the Per level mode is the series\' own: each market\'s average, the rest pooled over their weights, no share', () => {
  const s = ltSeriesOf([[[400, 50]], [[600, 10]], [[90, 30]]], [[[2, 1]], [[1, 1]], [[3, 2]]]);
  const rows = ltRowsAt(s, ['A', 'B', 'C'], [0, 1, 2], 0, 2);
  assert.deepEqual(rows.map(r => [r.name, r.bid, r.ask, r.share]), [['A', 200, 50, null], ['2 others', 690 / 4, 40 / 3, null]]);
  assert.ok(ltTableRows(rows, PALETTE).every(r => r.length === ltHeads(s.parts).length && r.length === 5), 'five columns, as its heads have');
  const plain = ltSeriesOf([[[400, 50]], [[600, 10]]]);
  assert.ok(ltRowsAt(plain, ['A', 'B'], [0, 1], 0, 2).every(r => r.share !== null), 'without weights: a share on every row, whatever the setting says meanwhile');
});

test('the Delta table has the heads\' six columns on every row', () => {
  const rows = deltaTableRows([{ name: 'A', buys: 0, sells: 0, delta: 0, share: 0 }, { name: '3 others', buys: 1, sells: 2, delta: -1, share: 1 }], PALETTE);
  assert.ok(rows.every(r => r.length === 6));
});

test('the × column: how many times the larger side is the smaller, in its colour, and what it says where a side is empty', () => {
  assert.deepEqual(sideRatio(546, 214), { ratio: 546 / 214, lead: 1 });
  assert.equal(sideRatio(103, 113)!.lead, -1, 'the second side leads');
  assert.equal(sideRatio(100, 100.4)!.lead, 0, 'under 1.005x neither leads');
  assert.equal(sideRatio(100, 100.5)!.lead, 0, 'written 1.00x: neither leads, so no colour on a figure that says even');
  assert.equal(sideRatio(100, 100.6)!.lead, -1);
  assert.deepEqual(sideRatio(5, 0), { ratio: Infinity, lead: 1 }, 'only one side has something');
  assert.equal(sideRatio(0, 0), null); assert.equal(sideRatio(NaN, 3), null); assert.equal(sideRatio(3, Infinity), null); assert.equal(sideRatio(-1, 3), null);
  assert.deepEqual([1, 1.004, 2.5512, 9.994, 9.996, 42.37, 99.96, 999.4, 999.5, 8e13, Infinity].map(ratioFigure), ['1.00×', '1.00×', '2.55×', '9.99×', '10.0×', '42.4×', '100×', '999×', '>999×', '>999×', '∞']);
  assert.deepEqual(ratioCell(546, 214, PALETTE), { text: '2.55×', color: ratioCell(5, 0, PALETTE).color });
  assert.equal(ratioCell(0, 7, PALETTE).text, '∞'); assert.notEqual(ratioCell(0, 7, PALETTE).color, ratioCell(7, 0, PALETTE).color);
  assert.deepEqual(ratioCell(100, 100, PALETTE), { text: '1.00×', color: PALETTE.muted }, 'neither leads: muted');
  assert.deepEqual(ratioCell(0, 0, PALETTE), { text: '–', color: PALETTE.muted });
});

test('the Depth table: bids, asks, their difference and the × column, on both sources, dashes for a band not read', () => {
  const rows = depthTableRows([{ r: 0.0125, bid: 113e6, ask: 103e6 }, { r: 0.2, bid: 546e6, ask: 214e6 }, { r: 0.0025, bid: 0, ask: 2e6 }, { r: 0.05, bid: NaN, ask: NaN }], PALETTE);
  assert.deepEqual(rows.map(r => r.map(c => c.text)), [['±1.25%', '113M', '103M', '+10M', '1.10×'], ['±20%', '546M', '214M', '+332M', '2.55×'], ['±0.25%', '0', '2M', '−2M', '∞'], ['±5%', '–', '–', '–', '–']]);
  assert.equal(rows[1]![4]!.color, rows[1]![1]!.color, 'bids lead: the colour of the bids');
  assert.equal(rows[2]![4]!.color, rows[2]![2]!.color, 'only asks (shorts) there: their colour');
  const spec = { heads: ['', 'Bid', 'Ask', 'Δ', '×'], rows, minCols: 3, foot: 'newest 13:39', focus: -1 };
  assert.equal(placeTable(measure, room({ w: 900, h: 140 }), spec)!.cols, 5, 'with room beside the plot the × column shows');
});

test('a Delta row: a side that traded nothing is 0, not the residue of live seconds added up in doubles, so × says ∞ and the cells stay narrow', () => {
  const gross = 1_234_567.89, delta = gross + 4e-9;
  const r = deltaRow('Thin', delta, gross, 2 * gross);
  assert.deepEqual([r.buys, r.sells, r.share], [gross + 2e-9, 0, 0.5]);
  assert.equal(r.delta, r.buys, 'the delta is the two sides\' difference');
  assert.deepEqual(deltaTableRows([r], PALETTE)[0]!.map(c => c.text), ['Thin', '1.23M', '0', '+1.23M', '50%', '∞']);
  const below = deltaRow('Thin', -gross + 3e-8, gross, gross);
  assert.deepEqual([below.buys, deltaTableRows([below], PALETTE)[0]![5]!.text], [0, '∞'], 'a negative residue too');
  assert.deepEqual(deltaRow('A', 0, 0, 0), { name: 'A', buys: 0, sells: 0, delta: 0, share: 0 });
});

test('a plate keeps every column unless the table lets its last ones go (plateMin), and then only down to that', () => {
  // All four 126 wide, three 99: a plot of 200 takes 120 on a plate.
  const narrow = room({ w: 200 + 60 + 20, plotW: 200, pointing: true });
  assert.equal(placeTable(measure, narrow, spec()), null, 'by default a plate is the whole table or none (the card says it)');
  const plate = placeTable(measure, narrow, { ...spec(), plateMin: 3 })!;
  assert.deepEqual([plate.plate, plate.cols, plate.width], [true, 3, 99], 'the × tables let their last column go');
  assert.equal(placeTable(measure, room({ w: 150 + 60, plotW: 150, pointing: true }), { ...spec(), plateMin: 3 }), null, 'not even plateMin fit: none');
  assert.equal(placeTable(measure, narrow, { ...spec(), plateMin: 1 })!.cols, 3, 'never below minCols');
  const all = placeTable(measure, room({ w: 400 + 60 + 90, pointing: true }), { ...spec(), plateMin: 3 })!;
  assert.equal(all.cols, 4, 'with room on the plate every column stays');
});

test('the × column is the first to go beside the plot in the Liquidity Tracker and Delta tables', () => {
  const lt = ltTableRows([{ name: 'Binance', bid: 29_900_000, ask: 40_500_000, share: 0.21 }], PALETTE), heads = ltHeads({} as LtParts);
  assert.deepEqual(heads.slice(-2), ['Share', '×'], 'Share, then × last');
  assert.equal(ltHeads({ wBid: new Float64Array(0) } as unknown as LtParts).at(-1), '×', 'Per level: × last too');
  const full = placeTable(measure, room({ w: 2000 }), { heads, rows: lt, minCols: 3 })!;
  const less = placeTable(measure, room({ w: 400 + 60 + full.width - 10 }), { heads, rows: lt, minCols: 3 })!;
  assert.deepEqual([full.cols, less.cols], [6, 5], 'Share stays, × goes');
  assert.equal(deltaTableRows([deltaRow('A', 1, 3, 3)], PALETTE)[0]!.length, 6);
});

/** The placement before the card's lines came under the rows (2026-11-18), for tables without them: where they go must not move. */
function placedBefore(measure: (text: string) => number, room: TableRoom, spec: Pick<TableSpec, 'heads' | 'rows' | 'minCols' | 'plateMin' | 'cardCols'>) {
  const GAP = 7, PAD = 5, k = spec.rows.length, n = spec.heads.length;
  let rowH = 0, titles = true, foot = true;
  fit: for (const [withTitles, withFoot] of [[true, true], [false, true], [false, false]] as const) {
    for (const h of [15, 14, 13, 12]) if ((k + (withTitles ? 1 : 0) + (withFoot ? 1 : 0)) * h + 4 <= room.h) { rowH = h; titles = withTitles; foot = withFoot; break fit; }
  }
  if (!rowH) return null;
  const widths = spec.heads.map((head, c) => Math.max(measure(head), ...spec.rows.map(row => measure(row[c]?.text ?? ''))));
  const width = (cols: number): number => widths.slice(0, cols).reduce((a, b) => a + b, 0) + GAP * (cols - 1) + PAD * 2;
  const free = room.w - room.axisW - room.plotW;
  let cols = n, left = room.plotW + 4, plate = false;
  while (cols >= spec.minCols && width(cols) > free - 4) cols--;
  if (cols < spec.minCols) {
    left = 6; plate = true;
    if (!room.pointing) return null;
    const least = Math.min(n, Math.max(spec.minCols, spec.plateMin ?? n));
    for (cols = n; cols > least && width(cols) > room.plotW * 0.6;) cols--;
    if (width(cols) > room.plotW * 0.6) return null;
  }
  const height = (k + (titles ? 1 : 0) + (foot ? 1 : 0)) * rowH, y0 = Math.round(room.h / 2 - height / 2), first = y0 + (titles ? rowH : 0);
  const rights: number[] = [];
  for (let c = 0, x = left + PAD; c < cols; c++) { x += widths[c]!; rights.push(x); x += GAP; }
  // Complete: with its titles, its foot and the columns the card needs (all of them unless the table says fewer).
  return { rowH, titles, foot, cols, left, plate, width: width(cols), y0, first, rights, height, summary: [], summaryW: width(cols), summaryH: 0, complete: titles && foot && cols >= Math.min(n, Math.max(spec.minCols, spec.cardCols ?? n)) };
}

/** What of a placed table the card's lines must never move: the rows, their columns, their place and their height. */
const rowsBlock = (at: ReturnType<typeof placeTable>) => at && { rowH: at.rowH, titles: at.titles, foot: at.foot, cols: at.cols, left: at.left, plate: at.plate, width: at.width, y0: at.y0, first: at.first, rights: at.rights, height: at.height };

test('the rows go exactly where they went before the card\'s lines, with lines or without; complete only with titles, foot, the card\'s columns and every line', () => {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647, int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const words = ['Open interest', 'Δ', 'Candle before', 'Rank in view', 'Unusual', 'New longs', 'Shorts closed', 'Buy share', 'Its baseline'];
  for (let i = 0; i < 20_000; i++) {
    const n = int(2, 6), k = int(1, 9), minCols = int(2, n), plateMin = rnd() < 0.5 ? undefined : int(-1, n + 2), cardCols = rnd() < 0.5 ? undefined : int(0, n + 1);
    const heads = Array.from({ length: n }, (_, c) => c ? 'H'.repeat(int(1, 6)) : '');
    const rows = Array.from({ length: k }, () => Array.from({ length: n }, () => ({ text: 'x'.repeat(int(1, 9)) })));
    const lines: InfoLine[] = Array.from({ length: int(0, 7) }, (_, j) => rnd() < 0.2 ? { text: 'note '.repeat(int(1, 12)).trim(), wrap: true, ...(rnd() < 0.3 ? { label: words[j % words.length]! } : {}) } : { label: words[int(0, words.length - 1)]!, text: 'v'.repeat(int(1, 14)), bold: rnd() < 0.3, rule: rnd() < 0.2 });
    const r: TableRoom = { w: int(150, 1200), h: int(20, 400), plotW: int(80, 800), axisW: 60, pointing: rnd() < 0.5 };
    const s = { heads, rows, minCols, ...(plateMin === undefined ? {} : { plateMin }), ...(cardCols === undefined ? {} : { cardCols }) };
    const before = placedBefore(measure, r, s), bare = placeTable(measure, r, s), got = placeTable(measure, r, { ...s, lines });
    const tag = JSON.stringify({ r, n, k, minCols, plateMin, cardCols, lines: lines.length });
    assert.deepEqual(bare, before, tag);
    assert.deepEqual(rowsBlock(got), rowsBlock(before), tag);
    if (!got) continue;
    if (!got.complete) { assert.equal(got.summary.length, 0, tag); continue; }
    assert.ok(got.titles && got.foot, tag);
    if (lines.length) {
      assert.ok(got.summary.length > 0 && got.y0 + got.height + got.summaryH <= r.h - 2, tag);
      assert.ok(got.summaryW >= got.width && got.summaryW <= (got.plate ? r.plotW * 0.6 : r.w - r.axisW - r.plotW - 4), tag);
      assert.ok(got.summary.every(row => (row.label !== undefined ? measure(row.label) + (row.text ? 14 + measure(row.text) : 0) : measure(row.text)) <= got.summaryW - 10), tag);
    }
  }
});

/** Some of an Open Interest card's lines, as a table gets them: figures with labels, a plain status line and the first of a group with its hairline. */
const OI_LINES: InfoLine[] = [{ label: 'Open interest', text: '182,507', bold: true }, { label: 'Δ', text: '−431', color: 'above', bold: true }, { text: '4 of 6 venues', color: 'muted' }, { label: 'New longs', text: '+239 BTC', color: 'buy', rule: true }];

test('the card\'s lines hang under the foot where the pane has room below the rows, and only then is the table complete', () => {
  // Five rows, the titles and the foot at 15 px (105) in the middle of 300 (from 98); under them the hairline (5), four lines and the card's own hairline (4): 69, to 272.
  const whole = placeTable(measure, room({ w: 400 + 60 + 130, h: 300 }), { ...spec(), lines: OI_LINES })!;
  assert.deepEqual([whole.cols, whole.plate, whole.complete, whole.summary.map(r => r.label ?? r.text)], [4, false, true, ['Open interest', 'Δ', '4 of 6 venues', 'New longs']]);
  assert.deepEqual([whole.y0, whole.height, whole.summaryH], [98, 105, 69]);
  assert.deepEqual(rowsBlock(whole), rowsBlock(placeTable(measure, room({ w: 400 + 60 + 130, h: 300 }), spec())), 'the rows where they are without lines');
  // The rows stay in the middle, so the lines need the room under them: 140 has 15 px rows from 18 to 123 and no room for 69 more.
  for (const h of [120, 140, 200]) {
    const short = placeTable(measure, room({ w: 400 + 60 + 130, h }), { ...spec(), lines: OI_LINES })!;
    assert.deepEqual([short.cols, short.complete, short.summary.length, short.rowH, short.titles, short.foot], [4, false, 0, 15, true, true], `h ${h}`);
  }
  // From 247 the 174 px of rows and lines fit with the rows in the middle (from 71 to 176, the lines to 245).
  assert.deepEqual([246, 247].map(h => placeTable(measure, room({ w: 400 + 60 + 130, h }), { ...spec(), lines: OI_LINES })!.complete), [false, true]);
  // A column left out is not complete, lines or none; every column with its titles and foot and no lines is.
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 110, h: 300 }), { ...spec(), lines: OI_LINES })!.complete, false);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 110 }), spec())!.complete, false);
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 130 }), { ...spec(), lines: [] })!.complete, true);
  // A pane too short for the titles, or for the foot that says the moment read, is never complete: the card says what they would.
  const bare = (h: number) => { const at = placeTable(measure, room({ w: 400 + 60 + 130, h }), spec())!; return [at.titles, at.foot, at.complete]; };
  assert.deepEqual([bare(109), bare(87), bare(64)], [[true, true, true], [false, true, false], [false, false, false]]);
});

test('the rows never move for the card\'s lines: two moments with more lines and fewer, or none, put them in the same place', () => {
  // Funding on Hyperliquid: an old hour says three lines, the newest (the pointer gone onto the table) six. The rows a click chooses stay put.
  const three: InfoLine[] = [{ text: 'Hyperliquid', bold: true }, { label: 'Each settlement', text: '+0.00041% / 1 h' }, { label: 'Settled at', text: 'Nov 21 09:00', color: 'muted' }];
  const six: InfoLine[] = [...three, { label: 'Buyers opened', text: '61%', bold: true, rule: true }, { label: 'New longs', text: '+12 BTC' }, { label: 'New shorts', text: '+7 BTC' }];
  for (const h of [260, 360, 520]) {
    const at = (lines: InfoLine[]) => placeTable(measure, room({ w: 400 + 60 + 200, h }), { ...spec(6), lines });
    assert.deepEqual(rowsBlock(at(three)), rowsBlock(at(six)), `h ${h}`);
    assert.deepEqual(rowsBlock(at(six)), rowsBlock(at([])), `h ${h}`);
  }
  // The lines are never the table's for the pointer: it reads the time there, so drawing them or not changes nothing it owns.
  const canvas = { addEventListener: () => undefined, getBoundingClientRect: () => ({ left: 0, top: 0 }), style: { cursor: '' } };
  const table = new PaneTable({ canvas: canvas as unknown as HTMLCanvasElement, left: () => 0, rangeGesture: () => false, invalidate: () => undefined });
  const ctx = { font: '11px sans', measureText: (t: string) => ({ width: measure(t) }), fillText: () => undefined, fillRect: () => undefined, strokeRect: () => undefined, beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined, stroke: () => undefined } as unknown as CanvasRenderingContext2D;
  const palette = { panel: 'P', line: 'L', text: 'T', muted: 'M' }, r = room({ w: 400 + 60 + 200, h: 520 });
  const withLines = table.draw(ctx, palette, r, { ...spec(6), foot: 'then', focus: -1, lines: six })!;
  const underFoot = withLines.y0 + withLines.height + 20, overRow = withLines.first + 2;
  assert.ok(withLines.complete && withLines.summaryH > 20);
  const owned = [table.owns(withLines.left + 3, { y: underFoot }), table.owns(withLines.left + 3, { y: overRow })];
  table.draw(ctx, palette, r, { ...spec(6), foot: 'then', focus: -1, lines: [] });
  assert.deepEqual([...owned, table.owns(withLines.left + 3, { y: underFoot }), table.owns(withLines.left + 3, { y: overRow })], [false, true, false, true]);
});

test('the card\'s lines may be wider than the rows: the columns keep their places and the lines\' values end at their own edge; a sentence wraps', () => {
  // 'Minute by minute for' 100 + two gaps 14 + '3 of 4 venues' 65 = 179: wider than the columns' 126 less the pads.
  const wide = placeTable(measure, room({ w: 400 + 60 + 200, h: 300 }), { ...spec(), lines: [{ label: 'Minute by minute for', text: '3 of 4 venues' }] })!;
  assert.deepEqual([wide.width, wide.summaryW, wide.complete], [126, 189, true]);
  assert.deepEqual(wide.rights, [429, 461, 498, 525], 'where they are without lines');
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 180, h: 300 }), { ...spec(), lines: [{ label: 'Minute by minute for', text: '3 of 4 venues' }] })!.complete, false, 'lines wider than the strip: the rows alone');
  const note = 'Where a market flow is not recorded the way the price went decides.';
  const wrapped = placeTable(measure, room({ w: 400 + 60 + 200, h: 300 }), { ...spec(), lines: [{ text: note, color: 'muted', wrap: true }] })!;
  assert.equal(wrapped.summaryW, 126, 'a sentence does not widen the table');
  assert.ok(wrapped.summary.length >= 3 && wrapped.summary.every(r => measure(r.text) <= 126 - 10), 'it wraps to the width inside the pads');
  assert.equal(wrapped.summary.map(r => r.text).join(' '), note);
  // A wrapped line's label stands on a row of its own: wider than the columns, it widens the lines.
  const label = placeTable(measure, room({ w: 400 + 60 + 200, h: 300 }), { ...spec(), lines: [{ label: 'A label wider than the columns', text: note, wrap: true }] })!;
  assert.equal(label.summaryW, 30 * 5 + 10);
});

test('on a plate the card\'s lines hang under the rows where 60 % of the plot and the pane leave room, and there is no plate without a pointer', () => {
  const plate = placeTable(measure, room({ w: 400 + 60 + 90, h: 300, pointing: true }), { ...spec(), lines: OI_LINES })!;
  assert.deepEqual([plate.plate, plate.left, plate.complete, plate.summary.length], [true, 6, true, 4]);
  const rows = placeTable(measure, room({ w: 400 + 60 + 90, h: 120, pointing: true }), { ...spec(), lines: OI_LINES })!;
  assert.deepEqual([rows.plate, rows.cols, rows.complete, rows.summary.length], [true, 4, false, 0], 'too short for the lines: the rows alone, and the card is needed');
  assert.equal(placeTable(measure, room({ w: 400 + 60 + 90, h: 300 }), { ...spec(), lines: OI_LINES }), null, 'no pointer: nothing over the chart');
  // The rows beside the plot stay there when the pointer comes: the table never jumps to a plate for its lines.
  const beside = placeTable(measure, room({ w: 400 + 60 + 110, h: 300, pointing: true }), { ...spec(), lines: OI_LINES })!;
  assert.deepEqual([beside.plate, beside.cols, beside.complete], [false, 3, false]);
});

test('a table whose card speaks of the total (cardCols 1) is complete without its own last columns, never below minCols', () => {
  // The lines need 124 (see above); four columns 126, three 99. A strip of 128 holds three columns, and the lines under them.
  const strip = room({ w: 400 + 60 + 128, h: 300 });
  const three = placeTable(measure, strip, { ...spec(), lines: OI_LINES, cardCols: 1 })!;
  assert.deepEqual([three.cols, three.complete, three.summary.length, three.width, three.summaryW], [3, true, 4, 99, 124], 'the × first: the card has nothing in it');
  const partial = placeTable(measure, strip, { ...spec(), lines: OI_LINES })!;
  assert.deepEqual([partial.cols, partial.complete, partial.summary.length], [3, false, 0], 'by default every column says something of the card');
  assert.equal(placeTable(measure, strip, { ...spec(5, 4), lines: OI_LINES, cardCols: 1 }), null, 'minCols 4 holds: no table of three, and no plate without a pointer');
  const rowsOnly = placeTable(measure, room({ w: 400 + 60 + 110 }), { ...spec(), cardCols: 1 })!;
  assert.deepEqual([rowsOnly.cols, rowsOnly.complete], [3, true], 'no lines: the columns it keeps are enough');
});

test('a card\'s lines in a table: those it leaves out are gone, venue marks and pieces too, and a heading stands only over lines', () => {
  const card: InfoLine[] = [{ text: 'Title', bold: true, table: false }, { label: 'OKX', text: 'could not be read', mark: 'okx', color: 'muted' }, { text: 'A B', runs: [{ text: 'A' }, { text: ' B' }] }, { text: 'help', wrap: true, table: false }];
  assert.deepEqual(tableLines(card), [{ label: 'OKX', text: 'could not be read', color: 'muted' }, { text: 'A B' }]);
  assert.equal(card[1]!.mark, 'okx', 'the card keeps its own');
  assert.deepEqual(tableLines(null), []);
  assert.deepEqual(headed('Total', []), []);
  assert.deepEqual(headed('Total', [{ label: 'Δ', text: '+1' }]), [{ text: 'Total', bold: true }, { label: 'Δ', text: '+1' }]);
});

test('painting the card\'s lines: the foot under the rows where it always was, a hairline, labels muted at the left, values at the lines\' edge in their colours, bold in the heavier face', () => {
  const calls: (string | number)[][] = [];
  const ctx = {
    font: '11px sans', fillStyle: '', strokeStyle: '', globalAlpha: 1, textAlign: 'left',
    fillText: (s: string, x: number, y: number) => calls.push(['text', s, x, y, ctx.fillStyle, ctx.textAlign, ctx.font]),
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h]), strokeRect: () => undefined, beginPath: () => calls.push(['path']), moveTo: (x: number, y: number) => calls.push(['move', x, y]), lineTo: () => undefined, stroke: () => undefined,
  };
  const p = { panel: '#ffffff', line: '#cccccc', text: '#000000', muted: '#888888', bid: '#00ff00', ask: '#ff0000', candleUp: '#00aa00', candleDown: '#aa0000' };
  const s: TableSpec = { heads: ['', 'A'], rows: [[{ text: 'X' }, { text: '1' }]], foot: 'then', minCols: 2, focus: -1, lines: OI_LINES };
  const at = placeTable(measure, room({ w: 400 + 60 + 200, h: 300 }), s)!;
  paintTable(ctx as unknown as CanvasRenderingContext2D, p, at, s, -1);
  const text = (word: string) => calls.find(c => c[0] === 'text' && c[1] === word)!, right = at.left + at.summaryW - 5;
  assert.deepEqual(calls.filter(c => c[0] === 'text').map(c => c[1]), ['A', 'X', '1', 'then', 'Open interest', '182,507', 'Δ', '−431', '4 of 6 venues', 'New longs', '+239 BTC']);
  assert.equal(text('then')[3], at.first + at.rowH + at.rowH / 2, 'the foot right under the rows, where it is without lines');
  assert.deepEqual(text('Δ').slice(2, 7).filter((_, i) => i !== 1), [at.left + 5, p.muted, 'left', '11px sans'], 'a label: muted, at the left');
  assert.deepEqual(text('−431').slice(2, 7).filter((_, i) => i !== 1), [right, tableInk(p.ask, p), 'right', '600 11px sans'], 'its value: at the lines\' right edge, the side\'s ink, bold');
  assert.deepEqual(text('+239 BTC').slice(4, 7), [tableInk(p.candleUp, p), 'right', '11px sans'], 'the buyers\' colour, not bold');
  assert.deepEqual(text('4 of 6 venues').slice(2, 7).filter((_, i) => i !== 1), [at.left + 5, p.muted, 'left', '11px sans'], 'a plain line at the left');
  assert.equal(calls.filter(c => c[0] === 'path').length, 2, 'the hairline over the lines and the card\'s own before New longs');
  assert.equal(ctx.font, '11px sans', 'the font is the pane\'s again');
  const last = text('+239 BTC')[3] as number;
  assert.ok((text('Open interest')[3] as number) > at.y0 + at.height && last <= at.y0 + at.height + at.summaryH, 'the lines under the foot, inside their height');
  // On a plate, the plate goes under the lines too.
  calls.length = 0;
  const plate = placeTable(measure, room({ w: 400 + 60 + 20, h: 300, pointing: true }), s)!;
  paintTable(ctx as unknown as CanvasRenderingContext2D, p, plate, s, -1);
  assert.deepEqual(calls[0], ['rect', plate.left, plate.y0 - 2, Math.max(plate.width, plate.summaryW), plate.height + plate.summaryH + 4]);
});

const CANDLE = { longOpened: 239, shortOpened: 484, longClosed: 628, shortClosed: 527, unassigned: 0, unknown: 0, fine: 4, counted: 4, byPrice: false } as NlnsCandle;

test('each pane\'s card gives its table what the rows do not say, and nothing its rows, its foot, its header or its help say', () => {
  const said = (lines: InfoLine[]): string[] => tableLines(lines).map(line => line.label ?? line.text);
  // Open Interest: its level, change, the change before, rank, how unusual, how many venues; who made it, before the card's closing words.
  const oi = oiCardLines({ time: 0, level: 182_507, change: -431, before: 97, rank: 103, of: 194, sigma: 2.3, source: '4 of 6 venues', staleMin: 6 });
  oi.splice(oi.length - 1, 0, ...nlnsWhoLines(CANDLE, 'BTC'));
  assert.deepEqual(said(oi), ['Open interest', 'Δ', 'Candle before', 'Rank in view', 'Unusual', '4 of 6 venues', 'last sample 6 min ago', 'New longs', 'New shorts', 'Longs closed', 'Shorts closed']);
  // How a candle was read where it was not the usual way: some venues not minute by minute, a side decided by the price.
  const odd = said(nlnsWhoLines({ ...CANDLE, fine: 3, unassigned: 2, byPrice: true }, 'BTC'));
  assert.ok(odd.includes('Takers even') && odd.some(x => /3 of 4 venues/.test(x)) && odd.some(x => /the price went decides/.test(x)), odd.join(' | '));
  // The Liquidity Tracker: the total, its balance and how it was weighed.
  assert.deepEqual(said(ltCardLines({ time: 0, bid: 8e6, ask: 12e6, halfLifeBp: 25, venues: 7 })), ['Bid', 'Ask', 'Δ', 'Imbalance', 'Ratio', 'Half-life', 'Venues']);
  // Delta: the candle's delta and its CVD.
  assert.deepEqual(said(deltaCardLines({ t: 0, delta: -1.5e6, open: 2e6, high: 2.2e6, low: 4e5, close: 5e5, run: 0 }, '1h')), ['Delta', 'CVD at the close', 'CVD high and low']);
  // Depth: the watched band's balance and rank (its figures, difference and ratio are its row).
  assert.deepEqual(said(depthCardLines({ time: 0, bands: [{ r: 0.01, bid: 3, ask: 1 }, { r: 0.05, bid: 5, ask: 9 }], watched: 1, units: 'usd', coin: 'BTC', rank: 4, of: 90 })), ['Imbalance', 'Rank in view']);
  // Liquidation levels: the take profits, where they are drawn; nothing else.
  assert.deepEqual(said(liqCardLines({ asOf: 0, bands: [{ r: 0.05, bid: 5, ask: 9 }], watched: 0, units: 'usd', coin: 'BTC', takes: { bid: 1, ask: 2 } })), ['Take profits above / below']);
  assert.deepEqual(said(liqCardLines({ asOf: 0, bands: [{ r: 0.05, bid: 5, ask: 9 }], watched: 0, units: 'usd', coin: 'BTC' })), []);
  // Funding on one venue: when it settles and who opened (its funding, APR and premium are its row; who pays, their sign).
  const opens: HourOpens = { t: 0, longOpened: 30, shortOpened: 10 };
  assert.deepEqual(said(fundingCardLines({ time: 0, venue: 'Hyperliquid', row: { t: H, rate: 1e-4 / 8, per8h: 1e-4, hours: 1 }, forming: true, premium: -4e-4, opens, coin: 'BTC', continuous: false })), ['Each settlement', 'Settles at', 'Buyers opened', 'New longs', 'New shorts']);
  // Every venue: all of it is the rows.
  assert.deepEqual(said(fundingAllCardLines({ time: 0, need: 2, median: { per8h: 1e-4 }, venues: [{ id: 'binance', name: 'Binance', per8h: 1e-4, forming: true }, { id: 'okx', name: 'OKX', per8h: null, forming: false }] })), []);
  // Long/Short: why a venue has no reading (a dash in its row says only that it has none); the readings are the rows, who each line counts the header's Series.
  const series = [
    { id: 'binance:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: T, long: 0.556 }] },
    { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: H, status: 'failed', points: [] },
    { id: 'okx:BTC-USDT-SWAP', population: 'accounts', periodMs: H, status: 'ok', points: [] },
  ] as unknown as LsSeries[];
  const ls = tableLines(lsCardLines(series, T + 30 * MIN, '1h'));
  assert.deepEqual(ls.map(line => line.label ?? line.text), ['Bybit']);
  assert.deepEqual(tableLines(lsCardLines(series.filter(s => s.status === 'ok'), T + 30 * MIN, '1h')), [], 'every venue read: nothing the rows and the header do not say');
  const page = [...series, { id: 'gateio:BTC_USDT', population: 'accounts', periodMs: H, status: 'serverOnly', points: [] }] as unknown as LsSeries[];
  assert.deepEqual(tableLines(lsCardLines(page, T + 30 * MIN, '1h')).map(line => line.label ?? line.text), ['Bybit'], 'a venue a page cannot read: the header says so');
  const older = [...series, { id: 'bitget:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: T + 10 * H, long: 0.6 }] }, { id: 'gateio:BTC_USDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T, long: 0.5 }] }] as unknown as LsSeries[];
  const card = lsCardLines(older, T + 30 * MIN, '1h').map(line => line.text);
  assert.ok(card.some(text => /newest 30 readings/.test(text)) && card.some(text => /earlier readings/.test(text)), 'the card says both');
  assert.deepEqual(tableLines(lsCardLines(older, T + 30 * MIN, '1h')).map(line => line.label ?? line.text), ['Bybit'], 'Bitget\'s 30 readings and a muted row are the help\'s and the row\'s');
  // A venue whose last update failed and that has no reading at the moment read (a window its failed round never covered, or past its hold):
  // its row's dashes are any venue's, so the table says it has no reading here and that its last update failed (review rounds 3 and 4); not
  // "could not be read", which a gap in its readings inside what it read would make false.
  const gone = [...series.filter(s => s.status === 'ok'), { id: 'gateio:BTC_USDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T - 48 * H, long: 0.5 }] }] as unknown as LsSeries[];
  const goneLines = tableLines(lsCardLines(gone, T + 30 * MIN, '1h'));
  assert.equal(goneLines.length, 2); assert.equal(goneLines[0]!.text, 'no reading'); assert.ok(goneLines[0]!.label); assert.match(goneLines[1]!.text, /last update could not be read/);
  // A gap inside what it read (readings either side, none at the time read past the hold): the same two lines, never "could not be read".
  const gap = [...series.filter(s => s.status === 'ok'), { id: 'gateio:BTC_USDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T - 10 * H, long: 0.5 }, { t: T + 10 * H, long: 0.5 }] }] as unknown as LsSeries[];
  assert.deepEqual(tableLines(lsCardLines(gap, T, '1h')).map(line => line.text === 'no reading' ? line.text : /last update/.test(line.text) ? 'sentence' : line.text), ['no reading', 'sentence']);
  // Bitget whose last update failed, at a time before its readings: the same two lines in the table; its 30-readings limit stays the card's (review 5).
  const bitgetGone = [...series.filter(s => s.status === 'ok'), { id: 'bitget:BTCUSDT', population: 'accounts', periodMs: H, status: 'stale', points: [{ t: T + 10 * H, long: 0.6 }] }] as unknown as LsSeries[];
  const bitgetCard = lsCardLines(bitgetGone, T, '1h');
  assert.deepEqual(tableLines(bitgetCard).map(line => line.text === 'no reading' ? line.text : /last update/.test(line.text) ? 'sentence' : line.text), ['no reading', 'sentence']);
  assert.ok(bitgetCard.some(line => /newest 30 readings/.test(line.text)), 'the card keeps Bitget\'s limit');
  assert.deepEqual(lsTableRows(gone, T + 30 * MIN, PALETTE)[2]!.slice(1).map(cell => cell.text), ['–', '–', '–'], 'its row: dashes, as any venue without a reading');
  // Who each line counts: the header's Series says it while every line counts the same people, not Bybit's accounts beside top traders' positions.
  const mixed = [{ ...series[0]!, population: 'topPositions' }, { id: 'bybit:BTCUSDT', population: 'accounts', periodMs: H, status: 'ok', points: [{ t: T, long: 0.5 }] }] as unknown as LsSeries[];
  const mixedLines = tableLines(lsCardLines(mixed, T + 30 * MIN, '1h')).map(line => line.text);
  assert.equal(mixedLines.length, 1); assert.match(mixedLines[0]!, /^Binance: .+ · Bybit: /);
  assert.deepEqual([ls[0]!.text, ls[0]!.mark], ['could not be read', undefined]);
});

test('the Funding table marks a rate still accruing where some rates have settled, and leaves it to the foot where none has', () => {
  const mixed = fundingTableRows([{ name: 'Binance', per8h: 1e-4, premium: null, forming: true }, { name: 'Hyperliquid', per8h: 2e-4, premium: null, forming: false }, { name: 'Median', per8h: 1.5e-4, premium: null }], PALETTE);
  assert.deepEqual(mixed.map(r => r[1]!.text), ['+0.0100% (now)', '+0.0200%', '+0.0150%']);
  const all = [{ name: 'Binance', per8h: 1e-4, premium: null, forming: true }, { name: 'OKX', per8h: null, premium: null, forming: false }, { name: 'Median', per8h: 1e-4, premium: null }];
  assert.equal(fundingAllNow(all), true, 'a venue with no rate, and the median, do not count');
  assert.deepEqual(fundingTableRows(all, PALETTE).map(r => r[1]!.text), ['+0.0100%', '–', '+0.0100%']);
  assert.equal(fundingAllNow([{ name: 'Median', per8h: 1e-4, premium: null }]), false, 'nothing a venue reads: nothing to say');
  assert.equal(fundingAllNow([{ name: 'Binance', per8h: 1e-4, premium: null, forming: false }]), false);
});

test('every table stands in the middle of its pane, Flow history\'s too: a short pane leaves the card beside it, a tall one takes its lines', () => {
  // Eight rows (Flow history's) and a card of eight lines: in the middle of a pane 300 high the rows end at 225 and 73 px is not enough, so the
  // card stays beside the table (Karl, 2026-11-21: a table at the top of its pane looked misplaced beside the other panes' tables).
  const eight = { ...spec(8), lines: Array.from({ length: 8 }, (_, i): InfoLine => ({ label: `Line ${i}`, text: 'value', ...(i === 6 ? { rule: true } : {}) })) };
  const short = placeTable(measure, room({ w: 400 + 60 + 200, h: 300 }), eight)!;
  assert.deepEqual([short.y0, short.complete], [75, false]);
  const tall = placeTable(measure, room({ w: 400 + 60 + 200, h: 460 }), eight)!;
  assert.deepEqual([tall.y0, tall.complete, tall.summary.length], [155, true, 8]);
  assert.ok(tall.y0 + tall.height + tall.summaryH <= 458);
  assert.deepEqual(rowsBlock(placeTable(measure, room({ w: 400 + 60 + 200, h: 460 }), { ...eight, lines: [] })), rowsBlock(tall), 'the lines never move the rows');
});
