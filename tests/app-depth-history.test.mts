import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BandHistory, DepthHistory, RANK_MIN_COVER_MS, RANK_RECENT_MS, RANK_SPAN_MS, cannotRank, rankAt, rankKind, rankValue, SETTLE_MS, USUAL_SHARE, type BandRank } from '../src/app/depth-history.ts';
import { depthCardLines, depthRankBrief, liqCardLines, liqTakesLine, type DepthHistoryLines } from '../src/app/panes/pane-cards.ts';
import { clock } from '../src/app/format.ts';
import type { ColumnsFrame } from '../src/shared/columns.ts';

const STEP = 16 * 60_000, HOUR = 3_600_000, DAY = 24 * HOUR, RADII = [0.01];
/** A frame of 16-minute windows from `from`: each book, in window x, one bid and one ask of `sizeAt(id, x)` USD at the touch (null: absent). */
function frame(ids: readonly string[], from: number, w: number, sizeAt: (id: string, x: number) => number | null): ColumnsFrame {
  const instruments = ids.map(id => {
    const times: number[] = [], counts: number[] = [], samples: number[] = [], bins: number[] = [], bid: number[] = [], ask: number[] = [];
    for (let x = 0; x < w; x++) {
      const s = sizeAt(id, x); if (s === null) continue;
      times.push(from + x * STEP); counts.push(2); samples.push(1);
      bins.push(999, 1001); bid.push(s, 0); ask.push(0, s);
    }
    return { id, step: 1, times, counts, samples, bins: Int32Array.from(bins), bid: Float32Array.from(bid), ask: Float32Array.from(ask) };
  });
  return { from, to: from + w * STEP, stepMs: STEP, instruments };
}
const T0 = 1_000 * STEP;   // on the grid
const at = (x: number): number => T0 + x * STEP + STEP / 2;

test('a moment is ranked by the closing minute of the window that closed last by then, against the closing minutes before it only', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0, w, (_, x) => 100 + x), T0, T0 + w * STEP);     // rising every window
  const r = rankAt(h, 'ask', 0, at(300))!;
  assert.equal(r.value, 399, 'window 299 closed last before a moment inside window 300');
  assert.equal(r.at, T0 + 300 * STEP);
  assert.equal(r.above, 0); assert.equal(r.equal, 0);
  assert.deepEqual(rankKind(r), { kind: 'highest', pct: 100, extreme: true });
  // A larger window later on changes nothing about an earlier moment: no look-ahead.
  h.put(frame(['a'], T0 + 350 * STEP, 1, () => 1e9), T0 + 350 * STEP, T0 + 351 * STEP);
  assert.deepEqual(rankAt(h, 'ask', 0, at(300)), r);
  assert.deepEqual(rankAt(h, 'ask', 0, T0 + 300 * STEP + 1), r, 'anywhere in the window, the same closing minute');
  // A value read finely (a column as shown) is ranked against the closing minutes that closed before its moment: windows 0..299.
  const v = rankValue(h, 'ask', 0, at(300), 250)!;
  assert.equal(v.n, 300); assert.equal(v.below, 150); assert.equal(v.equal, 1); assert.equal(v.at, null);
  assert.deepEqual(rankKind(v), { kind: 'above', pct: 50, extreme: false }, '150 of 300 strictly lower, 149 strictly higher');
});

test('ties never make a reading rarer than it is; a flat history reads as the middle; too little history gives no rank', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0, w, () => 500), T0, T0 + w * STEP);
  const r = rankAt(h, 'bid', 0, at(300))!;
  assert.equal(r.p, 0.5); assert.deepEqual(rankKind(r), { kind: 'middle', pct: 50, extreme: false });
  // Valid windows must cover the minimum, not only their first-to-last span.
  const need = Math.ceil(RANK_MIN_COVER_MS / STEP);
  assert.equal(rankAt(h, 'bid', 0, at(need)), null, `${need - 1} windows before it`);
  assert.ok(rankAt(h, 'bid', 0, at(need + 1)));
  const gappy = new BandHistory('k', ['a'], RADII);
  gappy.put(frame(['a'], T0, w, (_, x) => x < 5 || x > need + 100 ? 500 : null), T0, T0 + w * STEP);
  assert.equal(rankAt(gappy, 'bid', 0, at(need + 110)), null, 'a long gap does not count as covered');
});

test('a window missing a usual book is a gap; every book present is added up; a big newcomer makes a window a gap', () => {
  const w = 4 * 96, gaps = new Set([309, 200, 201, 202]);
  // b misses 4 of 384 windows (still usual at 90 %); c, small, is there one window in three; d, huge, once.
  const h = new BandHistory('k', ['a', 'b', 'c', 'd'], RADII);
  h.put(frame(['a', 'b', 'c', 'd'], T0, w, (id, x) => id === 'b' && gaps.has(x) ? null : id === 'c' ? (x % 3 ? null : 5) : id === 'd' ? (x === 100 ? 1e6 : null) : 100 + (x % 7)), T0, T0 + w * STEP);
  assert.deepEqual(h.usual(), [0, 1]);
  assert.ok(USUAL_SHARE > 0.5);
  assert.equal(rankAt(h, 'ask', 0, at(310)), null, 'the window b is missing from is not ranked');
  const n0 = h.n0;
  assert.equal(h.total('ask', 0, n0 + 318), 2 * (100 + 318 % 7) + 5, 'c is added where it is present');
  assert.ok(Number.isNaN(h.total('ask', 0, n0 + 100)), 'd holds more than a fifth of window 100: a gap');
  const r = rankAt(h, 'ask', 0, at(320))!;
  assert.equal(r.value, 2 * (100 + 319 % 7));
  assert.equal(r.n, 319 - 4 - 1, 'the windows before 319, less the four b is missing from (309 is one) and the one d swamps');
  // Asked of some books only, the others are left out.
  assert.equal(h.total('ask', 0, n0 + 318, ['a', 'b']), 2 * (100 + 318 % 7));
});

test('the grid grows both ways, a trim forgets the oldest windows, and a gap after a trim reads as not held', () => {
  const h = new BandHistory('k', ['a'], RADII);
  h.put(frame(['a'], T0 + 100 * STEP, 50, () => 7), T0 + 100 * STEP, T0 + 150 * STEP);
  h.put(frame(['a'], T0, 20, () => 3), T0, T0 + 20 * STEP);
  assert.equal(h.n0, Math.round(T0 / STEP)); assert.equal(h.count, 150);
  // a is in every window that holds a book (the 80 between the puts hold none: the source's gap, not a's), so it is usual of this grid.
  assert.deepEqual(h.usual(), [0]);
  assert.ok(Number.isNaN(h.total('ask', 0, h.n0 + 50, null, [0])), 'between the two puts nothing is held');
  assert.equal(h.total('ask', 0, h.n0 + 10, null, [0]), 3); assert.equal(h.total('ask', 0, h.n0 + 120, null, [0]), 7);
  h.trim(T0 + 110 * STEP);
  assert.equal(h.n0, Math.round(T0 / STEP) + 110); assert.equal(h.count, 40);
  assert.equal(h.total('ask', 0, h.n0), 7); assert.deepEqual(h.usual(), [0]);
  // A put past the end with a gap: the gap is not held, whatever the trim left behind in the buffer.
  h.put(frame(['a'], T0 + 200 * STEP, 5, () => 9), T0 + 200 * STEP, T0 + 205 * STEP);
  for (let n = Math.round(T0 / STEP) + 150; n < Math.round(T0 / STEP) + 200; n++) assert.ok(Number.isNaN(h.total('ask', 0, n, null, [0])), `window ${n} is not held`);
  assert.equal(h.total('ask', 0, Math.round(T0 / STEP) + 202, null, [0]), 9);
});

test('the words count the readings strictly lower or higher, rounded down, never 0 or 100 % unless past every one', () => {
  const r = (below: number, equal: number, above: number) => ({ p: (below + equal / 2) / (below + equal + above), n: below + equal + above, below, equal, above, coverMs: 3 * DAY, value: 1, at: null });
  assert.deepEqual(rankKind(r(990, 0, 10)), { kind: 'above', pct: 99, extreme: true });
  assert.deepEqual(rankKind(r(10, 0, 990)), { kind: 'below', pct: 99, extreme: true });
  assert.deepEqual(rankKind(r(0, 0, 50)), { kind: 'lowest', pct: 100, extreme: true });
  assert.deepEqual(rankKind(r(60, 0, 40)), { kind: 'above', pct: 60, extreme: false });
  assert.deepEqual(rankKind(r(30, 0, 70)), { kind: 'below', pct: 70, extreme: false });
  assert.equal(rankKind(r(999, 0, 1)).pct, 99, 'one reading above keeps it under 100');
  // Astra's tie (round 1): none lower, 7 equal, 193 higher. Below 96 %, not 98.
  assert.deepEqual(rankKind(r(0, 7, 193)), { kind: 'below', pct: 96, extreme: true });
  assert.deepEqual(rankKind(r(10, 90, 0)), { kind: 'middle', pct: 50, extreme: false });
});

test('what a source really had: the windows holding any book, not the grid it was asked over (the browser engine answers a week with minutes)', () => {
  const h = new BandHistory('k', [], RADII);
  h.addBooks(['a', 'b']);
  // A week asked for, minutes answered: the grid spans 200 windows, three hold a book.
  h.put(frame(['a', 'b'], T0, 200, (id, x) => x >= 197 && id === 'a' ? 5 : null), T0, T0 + 200 * STEP);
  assert.deepEqual([h.count, h.held()], [200, 3]);
  // More held, by the other book too, counts once a window; a trim forgets what it drops.
  h.put(frame(['a', 'b'], T0, 200, (id, x) => x >= 10 ? 5 : null), T0, T0 + 200 * STEP);
  assert.equal(h.held(), 190);
  h.trim(T0 + 50 * STEP);
  assert.deepEqual([h.count, h.held()], [150, 150]);
});

test('a window no book holds is the source\'s gap, not every book\'s: a 4-day source, a 20-hour outage of every book and an empty week still rank; a newcomer stays unusual', () => {
  const ids = ['a', 'b'], end = T0 + 630 * STEP;
  const rankOf = (sizeAt: (id: string, x: number) => number | null, among = ids) => {
    const h = new BandHistory('k', [], RADII); h.addBooks(['a', 'b', 'c']);
    h.put(frame(['a', 'b', 'c'], T0, 630, sizeAt), T0, end);
    return { h, r: rankValue(h, 'ask', 0, end, 25, among) };
  };
  const size = (x: number) => 10 + (x % 7);
  // A source that has held four days of the week asked for (a server in its first week): every window it holds counts, as it held them.
  const four = rankOf((id, x) => id !== 'c' && x >= 270 ? size(x) : null);
  assert.deepEqual([four.h.usualIn(ids, T0 / STEP, end / STEP).length, four.r?.n], [2, 360]);
  // Every book out for 20 hours (the PC or the server off): the rest of the week counts.
  const outage = rankOf((id, x) => id !== 'c' && (x < 300 || x >= 375) ? size(x) : null);
  assert.deepEqual([outage.h.usualIn(ids, T0 / STEP, end / STEP).length, outage.r?.n], [2, 555]);
  // The older days answered with nothing (the browser engine, or a store that lost them): the 50 recent hours rank (188 windows, 48 h and more).
  const recent = rankOf((id, x) => id !== 'c' && x >= 442 ? size(x) : null);
  assert.deepEqual([recent.h.held(), recent.r?.n], [188, 188]);
  // A venue that joined two days ago stays unusual (present in 180 of 630 windows held by the others), so its absence before never voids a window.
  const newcomer = rankOf((id, x) => id === 'c' ? (x >= 450 ? 3 : null) : size(x), ['a', 'b', 'c']);
  assert.deepEqual([newcomer.h.usualIn(['a', 'b', 'c'], T0 / STEP, end / STEP), newcomer.r?.n], [[0, 1], 630]);
});

test('a reading taken as shown is not ranked against windows unlike it: a large book back after a long outage (review round 2), healthy books still are', () => {
  const end = T0 + 630 * STEP;
  const history = (bigAt: (x: number) => boolean) => {
    const h = new BandHistory('k', [], RADII); h.addBooks(['big', 'small']);
    h.put(frame(['big', 'small'], T0, 630, (id, x) => id === 'small' ? 10 : bigAt(x) ? 15 : null), T0, end);
    return h;
  };
  // big holds 60 % of the band and was out 200 windows (53 h): unusual, so the hold rule voids every window that holds it and only the outage
  // counts. The reading now (both books, 25) would be the highest of those 200; the last windows held all void, so it has no rank at all.
  const back = history(x => x < 200 || x >= 400);
  assert.deepEqual(back.usualIn(['big', 'small'], T0 / STEP, end / STEP), [1]);
  assert.equal(rankValue(back, 'ask', 0, end, 25, ['big', 'small']), null);
  // Its coarse rank (a window total that passed the rule) is not touched by this.
  assert.equal(rankValue(back, 'ask', 0, T0 + 300 * STEP, 10, ['big', 'small'], T0 + 300 * STEP), null, 'under 48 h of counted windows before it');
  // Both books always there: both usual, every window counts, the reading ranks among all 630.
  const healthy = history(() => true);
  assert.equal(rankValue(healthy, 'ask', 0, end, 25, ['big', 'small'])?.n, 630);
  // A usual book merely missing from the last windows (a feed back after a few hours, review round 3) says nothing against the reading: it ranks.
  const late = history(x => x < 625);
  assert.equal(late.usualIn(['big', 'small'], T0 / STEP, end / STEP).length, 2);
  assert.equal(rankValue(late, 'ask', 0, end, 25, ['big', 'small'])?.n, 625, 'big out for the last 5 windows');
  assert.equal(rankValue(late, 'ask', 0, end, 10, ['big', 'small'], null, 1), null, 'a reading short of books is still not ranked');
  // The large book not usual and back for one window only (or new): the reading with it is refused at once, not after an hour of "highest".
  const justBack = history(x => x < 200 || x >= 629);
  assert.equal(rankValue(justBack, 'ask', 0, end, 25, ['big', 'small']), null);
  // A small book that is not usual never trips it (the usual books still hold 80 % of the band with it there).
  const smallNew = new BandHistory('k', [], RADII); smallNew.addBooks(['a', 'b', 'tiny']);
  smallNew.put(frame(['a', 'b', 'tiny'], T0, 630, (id, x) => id === 'tiny' ? (x >= 600 ? 1 : null) : 10), T0, end);
  assert.equal(rankValue(smallNew, 'ask', 0, end, 21, ['a', 'b', 'tiny'])?.n, 630);
});

test('whether a history can rank at all: a source whose own minutes began under 48 hours ago, known at once; a history read whole that holds fewer', () => {
  const NOW = T0 + 630 * STEP, h = new BandHistory('k', [], RADII);
  h.addBooks(['a']);
  h.put(frame(['a'], T0, 630, (_, x) => x >= 530 ? 5 : null), T0, NOW);
  assert.equal(h.held(), 100);
  assert.equal(cannotRank(null, false, NOW - 24 * HOUR, NOW), true, 'the browser engine: a day of its own minutes, from the first frame');
  assert.equal(cannotRank(null, false, NOW - 3 * DAY, NOW), false, 'three days: may rank, the history decides');
  assert.equal(cannotRank(null, false, Infinity, NOW), true, 'a book with no minutes of its own yet');
  assert.equal(cannotRank(h, false, null, NOW), false, 'still reading: not decided');
  assert.equal(cannotRank(h, true, null, NOW), true, 'read whole, 100 windows held (26.7 h)');
  h.put(frame(['a'], T0, 630, (_, x) => x >= 400 ? 5 : null), T0, NOW);
  assert.equal(cannotRank(h, true, null, NOW), false, '230 windows held (61 h)');
});

test('a short table\'s one row (Karl, 2026-11-22): the band, or in a coarse view the time of the book ranked, then each side\'s place without the span; bold past the 5th or 95th percentile', () => {
  const r = (below: number, equal: number, above: number, at: number | null = null): BandRank => ({ p: (below + equal / 2) / (below + equal + above), n: below + equal + above, below, equal, above, coverMs: 7 * DAY, value: 1, at });
  const brief = (bid: BandRank | null, ask: BandRank | null, more: Partial<DepthHistoryLines> = {}) => depthRankBrief(0.00625, { bid, ask, loading: false, whole: true, ...more });
  assert.deepEqual(brief(r(13, 0, 87), r(62, 0, 38)), [{ label: '±0.63%', text: 'bids below 87 % · asks above 62 %', bold: false }]);
  const t = Date.UTC(2026, 10, 22, 15, 12);
  assert.deepEqual(brief(r(8, 0, 92, t), r(13, 0, 87, t)), [{ label: clock(t), text: 'bids below 92 % · asks below 87 %', bold: false }], 'a coarse view names the book ranked');
  assert.deepEqual(brief(r(50, 0, 0), r(10, 90, 0)), [{ label: '±0.63%', text: 'bids highest · asks in the middle', bold: true }]);
  assert.equal(brief(r(0, 0, 50), r(3, 0, 97))[0]!.text, 'bids lowest · asks below 97 %');
  assert.equal(brief(r(40, 0, 60), r(4, 0, 96))[0]!.bold, true, 'one side past its 5th percentile');
  assert.equal(brief(null, null, { loading: true, whole: false })[0]!.text, 'bids … · asks …');
  assert.equal(brief(null, null, { whole: false })[0]!.text, 'bids … · asks …', 'older days still to come');
  assert.equal(brief(null, r(62, 0, 38))[0]!.text, 'bids – · asks above 62 %');
  assert.deepEqual(depthRankBrief(0.05, null), []);
  // The liquidation levels' row is the card's take-profits line, as the card says it.
  const takes = { bid: 1.5e6, ask: 4.2e6 }, said = liqCardLines({ asOf: 0, bands: [{ r: 0.05, bid: 5, ask: 9 }], watched: 0, units: 'usd', coin: 'BTC', takes }).find(l => l.label === liqTakesLine(takes, 'usd', 'BTC').label)!;
  assert.deepEqual({ label: said.label, text: said.text }, liqTakesLine(takes, 'usd', 'BTC'));
});

test('with Table on the Depth pane shows no card (Karl, 2026-11-22): the card only where no table is drawn; a short table says the band\'s place, or the take profits, in one row', () => {
  const lower = fs.readFileSync('src/app/panes/lower-panes.ts', 'utf8').replace(/\r\n/g, '\n');
  const depth = lower.slice(lower.indexOf('export class DepthPane '), lower.indexOf('  #drawTable(rows: readonly'));
  assert.match(depth, /if \(pointed && card && !placed\) this\.#lines = card;/);
  assert.doesNotMatch(depth, /!placed\?\.complete/);
  assert.match(depth, /brief = depthRankBrief\(s\.radii\[said\]!, placeOf\);/);
  assert.match(depth, /if \(readRow && tk\) brief = \[liqTakesLine\(tk, settings\.units, coin\)\];/);
  assert.match(depth, /depthHeads\(levelsKind\), sides, lines, brief, keepBrief, /);
  // A source that can never reach the minimum (the public site's browser engine): once whole and still short, the card's rank in view as before
  // the history, no rank row and no room kept for one.
  assert.match(depth, /ruledOut = !liq && cannotRank\(null, false, this\.hub\.source\.depthSince\?\.\(counted\) \?\? null, this\.hub\.sourceNow\(\)\);/);
  assert.match(depth, /const history = !liq && !ruledOut && \(pointed \|\| settings\.table\) \? this\.#bandHistory\.get\(counted, s\.radii\) : null;/, 'never asked where it cannot rank');
  assert.match(depth, /const unranked = !liq && \(ruledOut \|\| cannotRank\(history, whole, null, this\.hub\.sourceNow\(\)\)\);/);
  assert.match(lower, /new DepthHistory\(\(ids, from, to, step\) => this\.hub\.source\.columns\(ids, from, to, step, true\), \(\) => this\.invalidate\(\), \(\) => this\.hub\.sourceNow\(\)\)/, 'the source\'s clock');
  assert.match(depth, /if \(unranked\) \{\n\s+const here = rows\[said\]!\.bid \+ rows\[said\]!\.ask;/);
  assert.match(depth, /card = depthCardLines\(\{ time: readTime, bands: rows, watched: said, units: settings\.units, coin, rank, of \}\);/);
  assert.match(depth, /keepBrief = liq \? !!liqHeld\?\.takeRows\?\.length : !unranked;/);
  // The card the browser engine's pane says then: its rank in view, no history lines.
  const said = (h: Parameters<typeof depthCardLines>[0]) => depthCardLines(h).map(l => l.label ?? l.text);
  const bands = [{ r: 0.01, bid: 3, ask: 1 }, { r: 0.05, bid: 5, ask: 9 }];
  assert.ok(said({ time: 0, bands, watched: 1, units: 'usd', coin: 'BTC', rank: 4, of: 90 }).includes('Rank in view'));
  assert.ok(!said({ time: 0, bands, watched: 1, units: 'usd', coin: 'BTC', rank: 4, of: 90 }).includes('Bids'));
  // With the history: what the ranks stand on while it is read; nothing once it is read and this moment has no rank ("…" would read as loading).
  const basis = (history: DepthHistoryLines) => said({ time: 0, bands, watched: 1, units: 'usd', coin: 'BTC', rank: null, of: 0, history }).filter(t => /earlier readings/.test(t));
  assert.equal(basis({ bid: null, ask: null, loading: true, whole: false }).length, 1);
  assert.equal(basis({ bid: null, ask: null, loading: false, whole: false }).length, 1);
  assert.deepEqual(basis({ bid: null, ask: null, loading: false, whole: true }), []);
});

test('the pane\'s history asks for a new book\'s recent hours first, then its older days, then each closed window; new books alone; new bands afresh', async () => {
  let now = T0 + 500 * STEP + 1000;
  const asked: { ids: string[]; from: number; to: number }[] = [];
  let release: (() => void) | null = null;
  const ask = (ids: string[], from: number, to: number): Promise<ColumnsFrame> => {
    asked.push({ ids, from, to });
    return new Promise(resolve => { release = () => resolve(frame(ids, from, Math.round((to - from) / STEP), () => 10)); });
  };
  let changes = 0;
  const hist = new DepthHistory(ask, () => { changes++; }, () => now);
  const settle = async () => { release!(); await new Promise(r => setTimeout(r, 0)); };
  assert.equal(hist.get(['a', 'b'], RADII), null, 'nothing held yet');
  assert.equal(asked.length, 0, 'the list of books has not stood long enough yet');
  now += SETTLE_MS;
  const closed = Math.floor((now - 60_000) / STEP) * STEP, recent = Math.ceil(RANK_RECENT_MS / STEP) * STEP;
  assert.equal(hist.get(['a', 'b'], RADII), null);
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b'], from: closed - recent, to: closed }, 'its recent hours, on the grid');
  hist.get(['a', 'b'], RADII); assert.equal(asked.length, 1, 'one question at a time');
  await settle();
  assert.ok(hist.get(['a', 'b'], RADII), 'the recent hours are enough to answer');
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b'], from: closed - RANK_SPAN_MS, to: closed - recent }, 'then the older days');
  await settle(); assert.equal(changes, 2); assert.ok(hist.wholeFor(['a', 'b']));
  hist.get(['a', 'b'], RADII); assert.equal(asked.length, 2, 'nothing more until a window closes');
  // A book joins: only it is asked for (its recent hours, then its older days); the others keep what they hold.
  assert.equal(hist.get(['a', 'b', 'c'], RADII), null, 'c has nothing yet');
  assert.deepEqual(asked.at(-1), { ids: ['c'], from: closed - recent, to: closed }, 'a book joining later is asked for at once');
  await settle();
  const h = hist.get(['a', 'b', 'c'], RADII)!;
  assert.ok(h);
  assert.deepEqual(asked.at(-1), { ids: ['c'], from: closed - RANK_SPAN_MS, to: closed - recent });
  assert.equal(h.total('ask', 0, Math.floor(closed / STEP) - 10, ['a'], [0]), 10, 'a was not asked for again and still holds its windows');
  await settle();
  // A window closes (and a minute's grace passes): the books held are asked for from the last window held again to the newest closed one.
  now += STEP + 1;
  hist.get(['a', 'b', 'c'], RADII);
  const closed2 = Math.floor((now - 60_000) / STEP) * STEP;
  assert.deepEqual(asked.at(-1), { ids: ['a', 'b', 'c'], from: closed - STEP, to: closed2 });
  await settle();
  // Other bands start afresh (once the list of books has stood).
  assert.equal(hist.get(['a'], [0.02]), null);
  now += SETTLE_MS; hist.get(['a'], [0.02]);
  assert.deepEqual(asked.at(-1)!.ids, ['a']);
});

test('a window with no price the books agree on is not held; membership comes from the windows before the moment; a reading short of books is not ranked', () => {
  const w = 4 * 96, h = new BandHistory('k', ['a', 'b'], RADII);
  // b stops after window 300 for good: it is still a usual book for moments before then, whatever came after.
  h.put(frame(['a', 'b'], T0, w, (id, x) => id === 'b' && x > 300 ? null : 100 + (x % 5)), T0, T0 + w * STEP);
  const before = rankAt(h, 'ask', 0, at(290))!;
  assert.ok(before);
  assert.deepEqual(h.usualIn(null, h.n0, h.n0 + 289), [0, 1]);
  assert.equal(rankValue(h, 'ask', 0, at(290), 205, null, null, 1), null, 'a reading that counted one book where the history usually had two');
  assert.ok(rankValue(h, 'ask', 0, at(290), 205, null, null, 2));
  // A one-sided answer (only asks, no bid to agree a price on) leaves the window not held.
  const one = new BandHistory('k', ['a'], RADII);
  const f = frame(['a'], T0, 3, () => 50);
  f.instruments[0]!.bid.fill(0);
  one.put(f, T0, T0 + 3 * STEP);
  assert.ok(Number.isNaN(one.total('ask', 0, one.n0, null, [0])), 'no centre: not held');
  // A put off the grid is refused.
  const off = new BandHistory('k', ['a'], RADII);
  off.put(frame(['a'], T0 + STEP / 2, 4, () => 5), T0 + STEP / 2, T0 + 4.5 * STEP);
  assert.equal(off.count, 0);
});
