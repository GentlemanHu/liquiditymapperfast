// Two-sided figures take the colour of what their orders do (Karl, 2026-11-21; AGENTS "Words and look"): the rule for the liquidation levels
// (order-side.ts) and every surface that draws them, the Depth pane's Liquidation levels source first (it drew longs in the bid colour), the
// phone Liq tab's tie and the Plus demo's picture of that pane.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { depthOrderSides, levelsOrderSide, pairKey } from '../src/app/order-side.ts';
import { liquidationOrderSide } from '../src/app/script/inputs.ts';
import { depthHeads, depthLiqReadout, depthTableRows } from '../src/app/panes/lower-panes.ts';
import { depthCardLines, liqCardLines, ltCardLines } from '../src/app/panes/pane-cards.ts';
import { DepthRangeSummary, depthHeldKey, type DepthLiqRow, type DepthPaneHeld } from '../src/app/range/depth-lines.ts';
import { liqRatioWords } from '../src/app/liq-words.ts';
import { tableInk } from '../src/app/panes/pane-table.ts';
import { viewKey, type LiqView } from '../src/app/liq-view.ts';
import type { LevelsKind } from '../src/app/liq-levels.ts';
import type { InfoLine } from '../src/app/infobox.ts';

const KINDS: readonly LevelsKind[] = ['liq', 'stops', 'both', 'takes'];
const VIEWS: Record<LevelsKind, LiqView> = {
  liq: { liq: true, stops: false, takes: false, group: 'all' }, stops: { liq: false, stops: true, takes: false, group: 'all' },
  both: { liq: true, stops: true, takes: false, group: 'all' }, takes: { liq: false, stops: false, takes: true, group: 'all' },
};
const P = { bid: '#00aa00', ask: '#cc0000', text: '#111111', muted: '#777777' };
const BUY = tableInk(P.bid, P), SELL = tableInk(P.ask, P);

test('the rule: a long is closed by a sell and a short by a buy; take profits alone keep the shorts\' buys below the price (the long array)', () => {
  const all = KINDS.flatMap(kind => (['long', 'short'] as const).map(side => `${kind} ${side} ${levelsOrderSide(kind, side)}`));
  assert.deepEqual(all, ['liq long sell', 'liq short buy', 'stops long sell', 'stops short buy', 'both long sell', 'both short buy', 'takes long buy', 'takes short sell']);
  // The same answer as the script language's executed liquidations, which name the position liquidated.
  for (const side of ['long', 'short'] as const) assert.equal(levelsOrderSide('liq', side), liquidationOrderSide(side));
  for (const kind of KINDS) assert.notEqual(levelsOrderSide(kind, 'long'), levelsOrderSide(kind, 'short'), `${kind}: the two sides do opposite things`);
  assert.deepEqual(depthOrderSides(null), { above: 'sell', below: 'buy' }, 'the book: asks above sell, bids below buy');
  assert.deepEqual(depthOrderSides('liq'), { above: 'buy', below: 'sell' }, 'liquidation levels: the other way round');
  assert.deepEqual(depthOrderSides('takes'), depthOrderSides(null), 'take profits alone are resting orders like the book\'s');
  assert.deepEqual([pairKey('buy'), pairKey('sell')], ['bid', 'ask']);
});

test('the Depth table: longs lead in the sell colour, so × points at the longs\' column (Karl\'s screenshot: 33.7M, 24.9M, +8.76M, 1.35×)', () => {
  const rows = [{ r: 0.0125, bid: 33.7e6, ask: 24.9e6 }, { r: 0.05, bid: 86e6, ask: 99.6e6 }];
  const liq = depthTableRows(rows, P, depthOrderSides('liq'));
  assert.deepEqual(liq[0]!.map(c => c.text), ['±1.25%', '33.7M', '24.9M', '+8.8M', '1.35×']);
  assert.deepEqual([liq[0]![1]!.color, liq[0]![2]!.color], [SELL, BUY], 'longs in the sell colour, shorts in the buy colour');
  assert.equal(liq[0]![4]!.color, SELL, 'more long liquidations: × in the sell colour');
  assert.equal(liq[1]![4]!.color, BUY, 'more short liquidations: × in the buy colour');
  assert.equal(liq[0]![3]!.color, undefined, 'longs less shorts is not buying less selling: never coloured');
  for (const kind of ['stops', 'both'] as const) assert.deepEqual(depthTableRows(rows, P, depthOrderSides(kind)), liq, `${kind} as liquidations`);
  // The book and take profits alone: bids (the shorts' take-profit buys) below in the buy colour.
  for (const sides of [undefined, depthOrderSides('takes')]) {
    const r = depthTableRows(rows, P, sides);
    assert.deepEqual([r[0]![1]!.color, r[0]![2]!.color, r[0]![4]!.color, r[1]![4]!.color], [BUY, SELL, BUY, SELL]);
  }
  assert.deepEqual(depthTableRows([{ r: 0.01, bid: 5, ask: 5 }], P, depthOrderSides('liq'))[0]![4], { text: '1.00×', color: P.muted }, 'a tie names no side');
  assert.equal(depthTableRows([{ r: 0.01, bid: 0, ask: 5 }], P, depthOrderSides('liq'))[0]![4]!.color, BUY, 'only shorts: their buy colour');
});

test('the Depth table\'s titles: take profits alone are bids and asks, never "Longs" over the shorts\' take profits', () => {
  assert.deepEqual(depthHeads(null), ['Bid', 'Ask']);
  for (const kind of ['liq', 'stops', 'both'] as const) assert.deepEqual(depthHeads(kind), ['Longs', 'Shorts']);
  assert.deepEqual(depthHeads('takes'), ['Bids', 'Asks']);
});

test('the Depth header over the liquidation levels: each figure and the named larger side in the colour of what its orders would do', () => {
  const base = { whose: '', band: '1.25', coins: false, unit: '', take: null, asOf: '20:13' } as const;
  const liq = depthLiqReadout({ ...base, long: 33.7e6, short: 24.9e6, kind: 'liq' });
  assert.match(liq, /L <b class="ask">33\.7M<\/b> S <b class="bid">24\.9M<\/b> Δ <b>\+8\.8M<\/b>/);
  assert.match(liq, /<b class="ask">longs 1\.35×<\/b>/);
  assert.match(liq, / · positions as of 20:13$/);
  assert.match(depthLiqReadout({ ...base, long: 10e6, short: 30e6, kind: 'stops' }), /<b class="bid">shorts 3\.00×<\/b>/);
  const alone = depthLiqReadout({ ...base, long: 30e6, short: 10e6, kind: 'takes' });
  assert.match(alone, /^±1\.25% B <b class="bid">30M<\/b> A <b class="ask">10M<\/b>/, 'take profits alone lettered as the book');
  assert.match(alone, /<b class="bid">bids 3\.00×<\/b>/);
  assert.ok(!/longs|shorts|\bL </.test(alone), 'no "L" over the shorts\' take profits');
  assert.ok(!depthLiqReadout({ ...base, long: 5, short: 5, kind: 'liq' }).includes('×'), 'a tie names no side');
  const beside = depthLiqReadout({ ...base, long: 1e6, short: 2e6, kind: 'liq', take: { long: 3e6, short: 4e6 } });
  assert.match(beside, /take profits <b class="ask">▲4M<\/b> <b class="bid">▼3M<\/b>/, 'the longs\' take profits above sell, the shorts\' below buy');
});

test('the Depth card: the larger side in the colour of what its orders would do; the difference uncoloured; the book, tracker and OI cards as before', () => {
  const by = (lines: InfoLine[], label: string): InfoLine | undefined => lines.find(l => l.label === label);
  const card = (kind: LevelsKind, bid: number, ask: number): InfoLine[] => liqCardLines({ asOf: 0, bands: [{ r: 0.05, bid, ask }], watched: 0, units: 'usd', coin: 'BTC', view: VIEWS[kind] });
  assert.deepEqual([by(card('liq', 25e6, 10e6), 'Ratio')!.text, by(card('liq', 25e6, 10e6), 'Ratio')!.color], ['longs 2.50×', 'above'], 'longs lead: the sell (ask) colour');
  assert.deepEqual([by(card('both', 10e6, 25e6), 'Ratio')!.text, by(card('both', 10e6, 25e6), 'Ratio')!.color], ['shorts 2.50×', 'below']);
  assert.deepEqual([by(card('takes', 25e6, 10e6), 'Ratio')!.text, by(card('takes', 25e6, 10e6), 'Ratio')!.color], ['bids 2.50×', 'below']);
  for (const kind of KINDS) assert.equal(by(card(kind, 25e6, 10e6), 'Δ')!.color, undefined, `${kind}: no colour on longs less shorts`);
  assert.equal(by(liqCardLines({ asOf: 0, bands: [{ r: 0.05, bid: 25e6, ask: 10e6 }], watched: 0, units: 'usd', coin: 'BTC' }), 'Ratio')!.color, 'above', 'no view: liquidations');
  const book = depthCardLines({ time: 0, bands: [{ r: 0.05, bid: 30e6, ask: 10e6 }], watched: 0, units: 'usd', coin: 'BTC', rank: null, of: 0 });
  assert.deepEqual([by(book, 'Δ')!.color, by(book, 'Ratio')!.color], ['below', 'below'], 'the book: bids less asks is buying less selling');
  assert.equal(by(ltCardLines({ time: 0, bid: 1, ask: 3, halfLifeBp: 10, venues: 2 }), 'Ratio')!.color, 'above');
});

test('the Range panel: the liquidation levels\' rows in the colour of what their orders would do', () => {
  const M = 60_000, T = Date.UTC(2026, 10, 13, 0), RADII = [0.005, 0.02];
  const row = (m: number, long: number, short: number): DepthLiqRow => ({ asOf: T + (m - 2) * M, fetchedAt: T + m * M, long: [long, long * 2], short: [short, short * 2], longCoin: [long / 5e4, long / 2.5e4], shortCoin: [short / 5e4, short / 2.5e4] });
  const held = (kind: LevelsKind): DepthPaneHeld => ({ key: depthHeldKey('liq', [], RADII, viewKey(VIEWS[kind])), source: 'liq', ids: [], t0: T, t1: T + 200 * M, w: 20, radii: RADII,
    bid: new Float32Array(40), ask: new Float32Array(40), bidCoin: new Float32Array(40), askCoin: new Float32Array(40), present: null, centred: null, stepMs: 0, answeredAt: Infinity,
    rows: [row(0, 10, 20), row(4, 30, 10)], buckets: [0, 1], omitted: [], coins: false, coin: 'BTC', focus: 1, view: VIEWS[kind] });
  const tones = (kind: LevelsKind): string[] => {
    const h = held(kind), lines = new DepthRangeSummary().lines({ t0: T, t1: T + 10 * M, p0: null, p1: null, live: false, draft: false, pane: 'depth', step: M }, h, true, h.key, T + 600 * M);
    return lines.flatMap(l => l.grid ?? [])[0]!.rows!.map(r => `${r.label}: ${r.tone}`);
  };
  for (const kind of ['liq', 'stops', 'both'] as const) assert.deepEqual(tones(kind), ['Longs first → last: sell', 'Shorts first → last: buy'], kind);
  assert.deepEqual(tones('takes'), ['Take profits of shorts: buy', 'Take profits of longs: sell']);
});

test('the phone Liq tab: "Balanced" under the boxes\' 2 %, never longs in the sell colour on a tie', () => {
  assert.deepEqual(liqRatioWords(100, 100, false), { text: 'Balanced', side: null });
  assert.deepEqual(liqRatioWords(101.5, 100, false), { text: 'Balanced', side: null });
  assert.deepEqual(liqRatioWords(135, 100, false), { text: 'Longs 1.35x', side: 'long' });
  assert.deepEqual(liqRatioWords(100, 300, false), { text: 'Shorts 3.00x', side: 'short' });
  assert.deepEqual(liqRatioWords(135, 100, true), { text: 'bids 1.35x', side: 'long' }, 'take profits alone named as orders');
  assert.deepEqual(liqRatioWords(0, 7, false), { text: 'Shorts all of it', side: 'short' });
  assert.deepEqual(liqRatioWords(0, 0, false), { text: '', side: null });
  // The class each side takes: the falling colour for longs, the rising for shorts; take profits alone the other way round.
  const css = fs.readFileSync('src/app/mobile.css', 'utf8');
  assert.match(css, /\.liq-ratio\.long \{ color: var\(--candle-down\); \}/);
  assert.match(css, /\.liq-ratio\.short \{ color: var\(--candle-up\); \}/);
  assert.match(css, /\.liq-sum\.takes \.liq-usd\.long, \.liq-sum\.takes \.liq-ratio\.long \{ color: var\(--candle-up\); \}/);
});

test('the Plus demo draws the Depth pane\'s liquidations and stops as the app does: shorts above in the bid colour, longs below in the ask colour', () => {
  const css = fs.readFileSync('src/app/plus/demo/demo.css', 'utf8');
  const fill = (selector: string): string => { const at = css.indexOf(`${selector} {`); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('}', at)); };
  for (let k = 0; k < 5; k++) {
    assert.match(fill(`.pd-ch .pd-db.pd-up.pd-k${k}`), /var\(--bid\)/, `band ${k} above`);
    assert.match(fill(`.pd-ch .pd-db.pd-dn.pd-k${k}`), /var\(--ask\)/, `band ${k} below`);
  }
  assert.match(fill('.pd-ch .pd-d-edge.pd-up'), /var\(--bid\)/); assert.match(fill('.pd-ch .pd-d-edge.pd-dn'), /var\(--ask\)/);
  assert.match(fill('.pd-ch text.pd-t-up'), /var\(--bid\)/); assert.match(fill('.pd-ch text.pd-t-dn'), /var\(--ask\)/);
  assert.match(fill('.pd-vis .pd-v-up'), /var\(--bid\)/); assert.match(fill('.pd-vis .pd-v-dn'), /var\(--ask\)/);
  // Its liquidation column was already right: shorts' levels above in the bid colour (`pd-b`), take profits the other way round (svg.ts, chart.ts).
  assert.match(fs.readFileSync('src/app/plus/demo/svg.ts', 'utf8'), /top = tp \? 'pd-a' : 'pd-b'/);
});
