import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { leanTone, rowLabel, rowHover, aggregateLabel, aggregateHover } from '../src/app/cvd/text.ts';
import { nlnsCardLines, nlnsModel, nlnsWhoLines } from '../src/app/delta/nlns.ts';
import { orderLines, type StripOrders } from '../src/app/measures/strip-orders.ts';
import type { CvdModel, FamilyRow, LaneLine } from '../src/app/cvd/model.ts';
import type { OiBar } from '../src/app/store.ts';

// Karl, 2026-11-22: every figure of buying less selling says so in its colour and its sign, together. Left in the plain text colour it read as
// buying in the Terminal theme (whose text is its buy colour) whatever its sign; a sign beside a part's colour said two things at once.

const lane = (kind: 'spot' | 'perp', delta: number, last = delta): LaneLine => ({ id: '', kind, series: null, lo: Float64Array.of(last), hi: Float64Array.of(last), last: Float64Array.of(last), min: last, max: last, delta, buy: 10, sell: 10 } as unknown as LaneLine);

test('the flow column: each lane\'s delta and the window\'s total in the colour of their sign; the dot keeps the lane\'s colour', () => {
  assert.deepEqual([leanTone(5), leanTone(-5), leanTone(0)], ['buy', 'sell', 'text']);
  const row: FamilyRow = { key: 'binance', rank: 1, share: 0.4, gross: 1e6, quiet: false, lanes: [lane('spot', 2e6), lane('perp', -3e6)] };
  const lines = rowLabel(row, '1H', 200, false);
  assert.deepEqual(lines.filter(l => l.dot).map(l => [l.dot, l.tone]), [['spot', 'buy'], ['perp', 'sell']]);
  // Two lanes folded onto one line keep the plain text: one colour cannot say both.
  assert.equal(rowLabel(row, '1H', 40, false).find(l => /S .* P /.test(l.text))?.tone ?? 'text', 'text');
  const model = { rankSec: 3600, spot: lane('spot', 1e6), perp: lane('perp', -4e6), hidden: 0, rows: [] } as unknown as CvdModel;
  const agg = aggregateLabel(model, 120);
  assert.deepEqual(agg.slice(1).map(l => [l.text.split(' ')[0], l.tone]), [['S', 'buy'], ['P', 'sell'], ['Δ1H', 'sell']]);
  // The boxes: the running delta and the window's net in the book's buy (below) and sell (above) colours.
  const box = rowHover(row, 0, 0, '1h');
  assert.deepEqual(box.filter(l => /CVD here|net,/.test(l.label ?? '')).map(l => l.color), ['below', 'above', 'below', 'above']);
  assert.deepEqual(aggregateHover(model, 0, 0, '1h').filter(l => /CVD here|net,/.test(l.label ?? '')).map(l => l.color), ['below', 'above', 'below', 'above']);
  assert.equal(rowHover({ ...row, lanes: [lane('spot', 0, NaN)] }, 0, 0, '1h').find(l => /CVD here/.test(l.label ?? ''))!.color, 'text', 'nothing held: no side');
});

const H = 3_600_000, T = Date.UTC(2026, 9, 1);
const bar = (t: number, v: number): OiBar => [t, v, v, v, v];
const none = new Map<number, number>();

test('NL/NS: a part without a sign in the colour of what its orders did; the card\'s Net in the colour of its own figure, not the running sum\'s', () => {
  const [, c] = nlnsModel([T, T + H], [{ bars: [bar(T, 1_000), bar(T + H, 1_000 - 84)], flows: [null, { delta: 1, low: 0, high: 1, gross: 2 }] }], none, [0, 0], H);
  const parts = nlnsWhoLines(c!, 'BTC').filter(l => /closed/.test(l.label ?? ''));
  assert.ok(parts.length > 0);
  // Open interest fell under net buying: shorts closed, in the buy colour, once written "−84 BTC".
  assert.deepEqual(parts.map(l => [l.label, l.text, l.color]), [['Shorts closed', '84 BTC', 'buy']]);
  // A buying candle in a run that has sold: the figure is the candle's, so is the colour.
  const net = (v: number, cum: number) => nlnsCardLines({ ...c!, v, cum }, '1h', 'BTC', 'Binance BTCUSDT').find(l => l.label === 'Net')!;
  assert.deepEqual([net(5, -10).color, net(-5, 10).color, net(0, 10).color], ['buy', 'sell', 'text']);
});

test('the whale orders\' Δ in the colour of its sign', () => {
  const base: StripOrders = { buyN: 3, sellN: 2, buyUsd: 6e5, sellUsd: 4e5, whale: { buy: 3e5, sell: 1e5, exact: true }, minutes: null, of: 1, venues: [] } as unknown as StripOrders;
  const whale = (o: StripOrders) => orderLines(o, 1e5).find(l => /Whale orders/.test(l.label ?? ''))!;
  assert.equal(whale(base).color, 'buy');
  assert.equal(whale({ ...base, whale: { buy: 1e5, sell: 3e5, exact: true } }).color, 'sell');
  assert.equal(whale({ ...base, whale: { buy: 2e5, sell: 2e5, exact: true } }).color, undefined, 'even: no side');
});

test('canvas and readout wiring, pinned by source: the headers, the boxes and the Range lines colour a lean by its sign, a tie by neither', () => {
  const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lower = read('src/app/panes/lower-panes.ts');
  assert.match(lower, /const leanClass = \(value: number\): string => value > 0 \? ' class="bid"' : value < 0 \? ' class="ask"' : '';/);
  assert.match(lower, /Δ <b\$\{leanClass\(b - a\)\}>\$\{coins \? tableSigned\(b - a\) : signedText\(b - a\)\}<\/b>/, 'the Depth header over the book');
  assert.match(lower, /Δ <b\$\{leanClass\(b - a\)\}>\$\{signedText\(b - a\)\}<\/b> \$\{t\('imb'\)\} <b\$\{leanClass\(imb\)\}>/, 'the Liquidity Tracker header');
  assert.match(lower, /closed = \[\[t\('Shorts closed'\), c\.shortClosed, 'bid'\], \[t\('Longs closed'\), c\.longClosed, 'ask'\]\]/, 'the OI header\'s parts: no minus in the buy colour');
  assert.match(lower, /<b class="\$\{tone\}">\$\{coinSize\(x, ''\)\}<\/b>/);
  assert.match(read('src/app/panes/cvd-pane.ts'), /line\.tone === 'buy' \? p\.bid : line\.tone === 'sell' \? p\.ask : p\.text/);
  assert.match(read('src/app/panes/footprint.ts'), /tn\(rest\.length, '\{n\} more venue', '\{n\} more venues'\), text: [^\n]*color: buy > sell \? 'buy' : buy < sell \? 'sell' : 'muted'/);
  assert.match(read('src/app/panes/bar-stats.ts'), /const signTone = \(value: number\): StatTone => value > 0 \? 'buy' : value < 0 \? 'sell' : 'text';/);
  const stats = read('src/app/range/stats.ts');
  assert.match(stats, /\.\.\.\(d > 0 \? \{ tone: 'buy' as const \} : d < 0 \? \{ tone: 'sell' as const \} : \{\}\)/, 'the Range delta: a tie takes no side');
  assert.match(stats, /tone = longs > shorts \? 'sell' as const : shorts > longs \? 'buy' as const : null;/, 'the Range liquidations: an even split takes no side');
  const delta = read('src/app/range/delta-lines.ts');
  assert.match(delta, /signedUsd\(s\.before\)\], \.\.\.leanTone\(s\.before\)/);
  assert.match(delta, /signedUsd\(s\.largest\.delta\)\}`\], \.\.\.leanTone\(s\.largest\.delta\)/);

  assert.match(read('src/app/sound/panel.ts'), /class: e\.side \? `panel-note alert-\$\{e\.side\}` : 'panel-note'/);
  const css = read('src/app/styles.css');
  assert.match(css, /\.alert-log \.alert-buy \{ color: var\(--bid\); \}/);
  assert.match(css, /\.alert-log \.alert-sell \{ color: var\(--ask\); \}/);
});
