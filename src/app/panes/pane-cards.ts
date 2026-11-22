import type { InfoColor, InfoLine } from '../infobox.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import { clock, price as fmtPrice, usd } from '../format.ts';
import { signedUsd } from '../cvd/text.ts';
import { t } from '../i18n.ts';
import { bandText } from '../depth-settings.ts';
import { curveOf, viewParts, type LiqView } from '../liq-view.ts';
import { depthBuyLessSell, depthOrderSides, type OrderSide } from '../order-side.ts';
import { rankKind, type BandRank } from '../depth-history.ts';
import { ratioFigure, sideRatio } from './pane-table.ts';

/** The history's span a rank stands on, in words: whole days from two on, else hours. */
const spanWords = (ms: number): string => ms >= 2 * 86_400_000 ? t('{n} days', { n: Math.floor(ms / 86_400_000) }) : t('{n} h', { n: Math.floor(ms / 3_600_000) });
/**
 * Where a band's reading stands in its own history (depth-history.ts), in words: past every window held ("highest in 6 days"), under every one,
 * or the share on its side of the middle ("above 87 % of 6 days", "below 98 % of 6 days"). A dash where there is no rank (too little history,
 * or the moment's window missed a book the history usually has).
 */
export function rankWords(r: BandRank | null): string {
  if (!r) return '–';
  const k = rankKind(r), span = spanWords(r.coverMs);
  return k.kind === 'highest' ? t('highest in {span}', { span }) : k.kind === 'lowest' ? t('lowest in {span}', { span }) : k.kind === 'middle' ? t('in the middle of {span}', { span })
    : k.kind === 'above' ? t('above {pct} % of {span}', { pct: k.pct, span }) : t('below {pct} % of {span}', { pct: k.pct, span });
}
/**
 * A band's place in its history on each side, for the Depth card's and table's lines: `loading` until the newest hours are read, `whole` once the
 * older days are too (a moment with no rank before then may still get one: "…", not "–").
 */
export interface DepthHistoryLines { bid: BandRank | null; ask: BandRank | null; loading: boolean; whole: boolean }

/** The card colour of the book's pair for what a side's orders do (order-side.ts): the bid colour ('below') for buys, the ask colour ('above') for sells. */
const pairColor = (side: OrderSide): InfoColor => side === 'buy' ? 'below' : 'above';

/**
 * What the popup says for a point of the Depth, Liquidity Tracker and Open Interest panes: the lines of the box (infobox.ts / hovercard.ts)
 * and which column of each series the pointer is over. Plain functions with no canvas and no DOM, so they are tested alone.
 */

/** How many columns the Depth pane asks the worker for over a plot `plotW` px wide. */
export const depthColumns = (plotW: number): number => Math.min(1200, Math.max(60, Math.floor(plotW / 2)));

/**
 * What a Depth request was made for. The recorded columns that arrive later are part of it: an answer made from the columns that were here
 * before them is not the answer for the ones that came, and a view that stays where it is would otherwise keep it. The view counts in whole
 * columns of the answer: the map following the live edge moves a little on every frame, and asking again for each of those kept the worker
 * busy for nothing (what is live is refreshed on a clock instead).
 */
export function depthKey(ids: readonly string[], t0: number, t1: number, plotW: number, range: number | string, columnsVersion: number): string {
  const span = t1 - t0, column = span / depthColumns(plotW);
  return `${ids.join(',')}|${Math.round(span)}|${column > 0 ? Math.floor(t0 / column) : 0}|${plotW}|${range}|${columnsVersion}`;
}

/** The column of `count` equal columns over [t0, t1) that `time` falls in, or -1 outside it. */
export function columnAt(t0: number, t1: number, count: number, time: number): number {
  if (!(t1 > t0) || !(count > 0) || !(time >= t0) || !(time < t1)) return -1;
  return Math.min(count - 1, Math.floor((time - t0) / (t1 - t0) * count));
}

/** The column whose slot `[times[i], times[i] + step)` holds `time` (columns are sorted by time), or -1 when it falls in a gap between them. */
export function slotAt(times: ArrayLike<number>, step: number, time: number): number {
  let found = -1;
  for (let i = 0; i < times.length; i++) { if (times[i]! <= time) found = i; else break; }
  return found >= 0 && time < times[found]! + step ? found : -1;
}

/**
 * What a pointer at `time` reads: the point `found` under it, else, when `time` is at or past the newest point (index `newest`, at
 * `newestT`), the newest. Right of the plotted data, or over the pane's price axis, the popup keeps the last value instead of going away:
 * on a plot of this resolution, landing exactly on the last point is a hunt. A time in a gap between points still reads nothing.
 */
export function readAt(found: number, time: number, newest: number, newestT: number | undefined): number {
  if (found >= 0) return found;
  return newest >= 0 && newestT !== undefined && time >= newestT ? newest : -1;
}

/** The last of `rows` (ordered by fetch time) fetched at or before `time`, or -1. */
function fetchedBy(rows: readonly { fetchedAt: number }[], time: number): number {
  let lo = 0, hi = rows.length - 1, at = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid]!.fetchedAt <= time) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  return at;
}

/**
 * Which liquidation levels row each of `w` equal columns over [t0, t1] draws (-1: none): the row in force at the column's end (the newest
 * fetched by then, while it stands, `holdMs`), the column holding `until` (now, or the replay's moment) at `until` itself, and none past it.
 * So the newest column holds the newest snapshot at any zoom. Read at its middle, a column of a zoomed-out view (about 40 minutes over three
 * weeks) left the newest snapshot out until half a column had passed, and the table, which read that column, showed the snapshot before it
 * (Karl, 2026-11-21). Nothing of what is closed to this visitor (Plus, before `closedTo`, the boundary itself and not as far as the view
 * reaches) is drawn: no column read before it, and no row fetched before it, which a lapsed pass may still hold.
 */
export function liqColumnRows(rows: readonly { fetchedAt: number }[], t0: number, t1: number, w: number, until: number, holdMs: number, closedTo = -Infinity): Int32Array {
  const rowAt = new Int32Array(Math.max(0, w)).fill(-1), span = t1 - t0;
  if (!(span > 0)) return rowAt;
  for (let x = 0, i = 0; x < w; x++) {
    if (t0 + x / w * span >= until) break;
    const time = Math.min(t0 + (x + 1) / w * span, until);
    if (time < closedTo) continue;
    while (i + 1 < rows.length && rows[i + 1]!.fetchedAt <= time) i++;
    const row = rows[i];
    if (!row || row.fetchedAt > time || time - row.fetchedAt > holdMs || row.fetchedAt < closedTo) continue;
    rowAt[x] = i;
  }
  return rowAt;
}

/** How old the books now may be, and how far before now the view may end, for them to be read. */
const LIVE_FRESH_MS = 2 * 60_000;
/**
 * Whether the Depth pane reads the books now (the worker's live reading, `DepthNow`) rather than a column, in its header (`header`) and its
 * table (`table`). The header: whenever there is a reading under two minutes old (a dropped stream leaves the worker its last books), the view
 * reaches the live edge (its end at most two minutes before now) and no replay runs. The table: then too, with no pointer, a pointer at or
 * past the start of the column holding now (that column is a mean of the minutes in it), or one past the newest column with data.
 */
export function readsBooksNow(o: { liveAt: number | null; until: number; t1: number; replay: boolean; pointer: number | null; nowColumnStart: number; pastNewest: boolean }): { header: boolean; table: boolean } {
  const header = !o.replay && o.liveAt !== null && o.until - o.liveAt <= LIVE_FRESH_MS && o.t1 >= o.until - LIVE_FRESH_MS;
  return { header, table: header && (o.pointer === null || o.pointer >= o.nowColumnStart || o.pastNewest) };
}

/** The row of `rows` in force at `time` (the newest fetched by then, while it stands: `holdMs`), or -1. */
export function liqRowAt(rows: readonly { fetchedAt: number }[], time: number, holdMs: number): number {
  const i = fetchedBy(rows, time);
  return i >= 0 && time - rows[i]!.fetchedAt <= holdMs ? i : -1;
}

/**
 * What the Depth table, its header and its card read of the liquidation levels, from the rows themselves, never from the columns, so the
 * same at any zoom (`liqColumnRows`). With the pointer short of `until` (now, or the replay's moment): the row in force at its time, strictly,
 * so a pointer in a gap reads nothing whatever the view. With no pointer, or one at or past `until`: the newest moment in view (the view's end,
 * or `until`), where the newest row fetched by then is kept past its hold (the snapshots stopped: its positions time says how old it is).
 * The take profits are read at the same moment, strictly: an orders file that lags is not printed beside fresher levels. Nothing before
 * `closedTo` (Plus): neither a moment nor a row fetched before it. `at`: the moment read.
 */
export function liqReading(rows: readonly { fetchedAt: number }[], takes: readonly { fetchedAt: number }[] | null, o: { pointer: number | null; t1: number; until: number; holdMs: number; closedTo?: number }): { row: number; take: number; at: number } {
  const { pointer, t1, until, holdMs } = o, closedTo = o.closedTo ?? -Infinity;
  const newest = pointer === null || pointer >= until, at = newest ? Math.min(until, t1) : pointer;
  if (at < closedTo) return { row: -1, take: -1, at };
  const open = (list: readonly { fetchedAt: number }[], i: number): number => i >= 0 && list[i]!.fetchedAt >= closedTo ? i : -1;
  return { row: open(rows, newest ? fetchedBy(rows, at) : liqRowAt(rows, at, holdMs)), take: takes ? open(takes, liqRowAt(takes, at, holdMs)) : -1, at };
}

/** The bar of `bars` (each starting with its start time, sorted) the time falls in: the last one that has started. The newest holds on past its own slot (its level is the latest known until the next sample), so it answers for any later time. */
export function barAt(bars: ArrayLike<ArrayLike<number>>, tf: number, time: number): number {
  let found = -1;
  for (let i = 0; i < bars.length; i++) { if (bars[i]![0]! <= time) found = i; else break; }
  if (found < 0) return -1;
  return found === bars.length - 1 || time < bars[found]![0]! + tf ? found : -1;
}

/**
 * The columns of the Depth pane whose imbalance (bids minus asks over their sum, in size) is unusual: the one rule Highlights sets for the
 * whole page, applied to the columns. The baseline is `length` bars before the column, and a bar is `columnsPerBar` columns wide, so the
 * baseline covers the same stretch of time at any zoom; nothing is flagged until a dozen columns exist. Columns without liquidity are skipped.
 */
export function imbalanceFlags(bid: ArrayLike<number>, ask: ArrayLike<number>, highlight: Pick<HighlightOptions, 'length' | 'mult'>, columnsPerBar: number): Uint8Array {
  const n = Math.min(bid.length, ask.length), size = new Float64Array(n);
  for (let i = 0; i < n; i++) { const total = bid[i]! + ask[i]!; size[i] = total > 0 ? Math.abs(bid[i]! - ask[i]!) / total : NaN; }
  const length = Math.max(12, Math.min(n, Math.round(highlight.length * Math.max(columnsPerBar, 1e-9))));
  return anomalies(size, { length, mult: highlight.mult }).flag;
}

/**
 * Where the Open Interest step line ends: at the newest sample's centre when that sample is the last one on screen (`live`, and the dashed
 * continuation to the newest candle may follow), and otherwise at the right edge of the plot, at the level of the last sample on screen.
 */
export function oiTail(count: number, last: number, xSampled: number, plotW: number): { x: number; live: boolean } {
  const live = last === count - 1;
  return { x: live ? xSampled : plotW, live };
}

/** The side that has more of the two, and by how much of the two together. */
function imbalanceLine(bid: number, ask: number): InfoLine | null {
  const total = bid + ask;
  if (!(total > 0)) return null;
  const share = (bid - ask) / total;
  if (Math.abs(share) < 0.005) return { label: t('Imbalance'), text: '0%' };
  return { label: t('Imbalance'), text: `${share > 0 ? t('bids') : t('asks')} +${(Math.abs(share) * 100).toFixed(1)}%`, color: share > 0 ? 'below' : 'above', bold: true };
}
/**
 * How many times the larger side is the smaller, named by the larger (`names`: the first side's, the second's), as the tables' × column has it, in
 * the larger side's colour (`colors`: the first's, the second's; the book's bid and ask by default); none where neither leads.
 */
function ratioLine(first: number, second: number, names: readonly [string, string], colors: readonly [InfoColor, InfoColor] = ['below', 'above']): InfoLine | null {
  const r = sideRatio(first, second);
  if (!r?.lead) return null;
  return { label: t('Ratio'), text: `${r.lead > 0 ? names[0] : names[1]} ${ratioFigure(r.ratio)}`, color: r.lead > 0 ? colors[0] : colors[1], bold: true };
}
/** An amount of USD as the popups write it, with the sign the signed ones have. */
const money = (value: number): string => `$${usd(value)}`;
const sideColor = (value: number): InfoLine['color'] => value > 0 ? 'below' : value < 0 ? 'above' : 'text';
/** Coins to three significant figures, so a fraction of a coin is never written 0. */
const coinFigures = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });

/**
 * One moment of the Depth pane where its table is not drawn (no room beside the plot, or the table switched off): each band's bids and asks, the
 * watched band (the one brought forward, else the widest) in bold with its difference and balance, and where that band's total stands in the view.
 */
export function depthCardLines(h: { time: number; bands: readonly { r: number; bid: number; ask: number }[]; watched: number; units: 'usd' | 'coin'; coin: string; rank: number | null; of: number; history?: DepthHistoryLines | null }): InfoLine[] {
  const fmt = (value: number): string => h.units === 'coin' ? `${coinFigures.format(value)} ${h.coin}` : money(value);
  // The table says the time, every band and the watched band's difference and ratio in its rows: it keeps the balance and the rank.
  const lines: InfoLine[] = [{ text: t('Depth'), bold: true, table: false }, { label: t('Time'), text: clock(h.time, true), table: false }];
  h.bands.forEach((band, j) => lines.push({ label: `±${bandText(band.r)}%`, text: `${fmt(band.bid)} · ${fmt(band.ask)}`, bold: j === h.watched, table: false }));
  const w = h.bands[h.watched];
  if (w) {
    const diff = w.bid - w.ask;
    lines.push({ label: 'Δ', text: h.units === 'coin' ? `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}` : signedUsd(diff), color: sideColor(diff), bold: true, table: false });
    const imbalance = imbalanceLine(w.bid, w.ask); if (imbalance) lines.push(imbalance);
    const ratio = ratioLine(w.bid, w.ask, [t('bids'), t('asks')]); if (ratio) lines.push({ ...ratio, table: false });
  }
  // Where the watched band's bids and asks stand in their own history (the 16 minutes around the moment against those of the days before), in
  // place of its rank among the columns in view, which changed with the zoom. Said from the first frame ("…" while the history is read), so the
  // lines under the table do not move when it arrives.
  const hist = h.history;
  if (hist) {
    for (const [side, label, color] of [['bid', t('Bids'), 'below'], ['ask', t('Asks'), 'above']] as const) {
      const r = hist[side];
      lines.push({ label, text: r ? rankWords(r) : hist.loading || !hist.whole ? '…' : '–', color, bold: !!r && rankKind(r).extreme });
    }
    // What the ranks stand on, in the table too: how many earlier readings, and, where a coarser view's column could not be ranked as shown,
    // which closing minute was. Said from the first frame, so the lines do not move when the history arrives.
    // Once the history is read and this moment still has no rank, there is nothing to say it stands on ("…" would read as still loading).
    const r = hist.bid ?? hist.ask;
    if (r || hist.loading || !hist.whole) lines.push({ text: r?.at != null ? t('The book at {time}, against {n} earlier readings, one every 16 minutes', { time: clock(r.at), n: r.n })
      : t('Against {n} earlier readings, one every 16 minutes', { n: r ? r.n : '…' }), color: 'muted', wrap: true });
  }
  else if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  lines.push({ text: t('Bids · asks resting within each distance of the price, added up over the books counted (Venues); each band holds the ones inside it.'), color: 'muted', wrap: true, rule: true, table: false });
  return lines;
}

/**
 * Where the band stands in its history in one row, for a table too short for the Depth card's lines (Karl, 2026-11-22: with Table on the pane shows no
 * card): at the left the band, or the time of the book ranked where a coarser view could not rank the figure shown (the band is the lit row then), and
 * each side's place without the span, which the lines and the help say. Bold where a side is past its 5th or 95th percentile; none without a history.
 */
export function depthRankBrief(band: number, history: DepthHistoryLines | null | undefined): InfoLine[] {
  if (!history) return [];
  const place = (r: BandRank | null): string => {
    if (!r) return history.loading || !history.whole ? '…' : '–';
    const k = rankKind(r);
    return k.kind === 'highest' ? t('highest') : k.kind === 'lowest' ? t('lowest') : k.kind === 'middle' ? t('in the middle')
      : k.kind === 'above' ? t('above {pct} %', { pct: k.pct }) : t('below {pct} %', { pct: k.pct });
  };
  const { bid, ask } = history, at = (bid ?? ask)?.at;
  return [{ label: at != null ? clock(at) : `±${bandText(band)}%`, text: t('bids {bids} · asks {asks}', { bids: place(bid), asks: place(ask) }),
    bold: [bid, ask].some(r => !!r && rankKind(r).extreme) }];
}

/** The watched band's take profits beside the liquidation levels (those above the price · those below), as the card says them and a short table's row. */
export function liqTakesLine(takes: { bid: number; ask: number }, units: 'usd' | 'coin', coin: string): InfoLine {
  const fmt = (value: number): string => units === 'coin' ? `${coinFigures.format(value)} ${coin}` : money(value);
  return { label: t('Take profits above / below'), text: `${fmt(takes.ask)} · ${fmt(takes.bid)}` };
}

/**
 * One moment of the Depth pane's Liquidation levels where its table is not drawn: the snapshot in force (when its positions stood), each band's
 * longs and shorts, the watched band in bold with their difference. Where the money sits, not what was or will be liquidated. The larger side is
 * named in the colour of what its orders would do (order-side.ts: the longs' sell colour, a long being closed by a sell), as the table's ×. The
 * difference is what they would buy less what they would sell, as the table's Δ (`depthBuyLessSell`): the shorts less the longs (a short is closed
 * by a buy), take profits alone the bids less the asks (the shorts' buys below the price, the longs' sells above), coloured by its sign as the
 * book's card colours bids less asks.
 */
export function liqCardLines(h: { asOf: number; bands: readonly { r: number; bid: number; ask: number }[]; watched: number; units: 'usd' | 'coin'; coin: string; view?: LiqView; takes?: { bid: number; ask: number } | null }): InfoLine[] {
  const fmt = (value: number): string => h.units === 'coin' ? `${coinFigures.format(value)} ${h.coin}` : money(value);
  const kind = h.view ? curveOf(h.view) : 'liq';
  // The table says the snapshot's time in its foot, every band and the watched band's difference and ratio in its rows, and the levels control
  // what is shown: it keeps the take profits.
  const lines: InfoLine[] = [{ text: h.view ? viewParts(h.view).join(' · ') : t('Liquidation levels'), bold: true, table: false }, { label: t('Positions'), text: clock(h.asOf, true), table: false }];
  h.bands.forEach((band, j) => lines.push({ label: `±${bandText(band.r)}%`, text: `${fmt(band.bid)} · ${fmt(band.ask)}`, bold: j === h.watched, table: false }));
  const w = h.bands[h.watched];
  if (w) {
    // Take profits on alone are resting orders: the buys below the price are bids, the sells above asks.
    const sides = depthOrderSides(kind), colors = [pairColor(sides.below), pairColor(sides.above)] as const, diff = depthBuyLessSell(w.bid, w.ask, sides);
    lines.push({ label: 'Δ', text: h.units === 'coin' ? `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))}` : signedUsd(diff), color: sideColor(diff), bold: true, table: false });
    const ratio = ratioLine(w.bid, w.ask, kind === 'takes' ? [t('bids'), t('asks')] : [t('longs'), t('shorts')], colors); if (ratio) lines.push({ ...ratio, table: false });
  }
  // The take profits of the watched band: the sells that close longs above the price, the buys that close shorts below; never added to the rest.
  if (h.takes) lines.push({ ...liqTakesLine(h.takes, h.units, h.coin), rule: true });
  lines.push({ table: false, text: kind === 'takes' ? t('Take profits of shorts · longs within each distance of the price, from HyperTracker\'s snapshot of the orders on Hyperliquid\'s BTC: where the orders rest, not what will fill.')
    : kind === 'stops' ? t('Stops of longs · shorts within each distance of the price, from HyperTracker\'s snapshot of the orders on Hyperliquid\'s BTC: where the orders rest, not what will trigger.')
    : kind === 'both' ? t('Longs · shorts that would be liquidated or stopped out within each distance of the price, from HyperTracker\'s snapshot of Hyperliquid\'s BTC positions and orders: where the money sits, not what will happen.')
      : t('Longs · shorts that would be liquidated within each distance of the price, from HyperTracker\'s snapshot of Hyperliquid\'s BTC positions: where the money sits, not what will be liquidated.'), color: 'muted', wrap: true, rule: true });
  return lines;
}

/** One point of the Liquidity Tracker: the weighted liquidity of each side, how it compares, and the settings it was worked out with. */
export function ltCardLines(h: { time: number; bid: number; ask: number; halfLifeBp: number; venues: number }): InfoLine[] {
  const lines: InfoLine[] = [
    { text: t('Liquidity Tracker'), bold: true, table: false },
    { label: t('Time'), text: clock(h.time, true), table: false },
    { label: t('Bid'), text: money(h.bid), color: 'below' },
    { label: t('Ask'), text: money(h.ask), color: 'above' },
    { label: 'Δ', text: signedUsd(h.bid - h.ask), color: sideColor(h.bid - h.ask), bold: true },
  ];
  const imbalance = imbalanceLine(h.bid, h.ask); if (imbalance) lines.push(imbalance);
  const ratio = ratioLine(h.bid, h.ask, [t('bids'), t('asks')]); if (ratio) lines.push(ratio);
  lines.push({ label: t('Half-life'), text: `${h.halfLifeBp} bp` }, { label: t('Venues'), text: String(h.venues) });
  lines.push({ text: t('Liquidity near the touch, weighted: a level counts in full at the touch and half as much for every half-life further away.'), color: 'muted', wrap: true, rule: true, table: false });
  return lines;
}

/** One bar of the Open Interest pane: the level, the step from the bar before, and how unusual that step is. */
/** `estimate`: a reading of the long view (oi-long.ts), chained back over the venues' history: its time is the reading's, its figures marked ≈. */
export function oiCardLines(h: { time: number; level: number; change: number | null; before: number | null; rank: number | null; of: number; sigma: number | null; source: string | null; staleMin: number | null; estimate?: boolean }): InfoLine[] {
  const about = h.estimate ? '≈ ' : '';
  const signed = (value: number): string => `${about}${value > 0 ? '+' : value < 0 ? '−' : ''}${fmtPrice(Math.abs(value), 1)}`;
  const lines: InfoLine[] = [
    { text: t('Open Interest'), bold: true, table: false },
    { label: h.estimate ? t('Time') : t('Candle'), text: clock(h.time, true), table: false },
    { label: t('Open interest'), text: `${about}${fmtPrice(h.level, 1)}`, bold: true },
  ];
  if (h.change !== null) lines.push({ label: 'Δ', text: signed(h.change), color: sideColor(h.change), bold: true });
  if (h.before !== null) lines.push({ label: t('Candle before'), text: signed(h.before) });
  if (h.rank !== null && h.of > 1) lines.push({ label: t('Rank in view'), text: t('{rank} of {total}', { rank: h.rank, total: h.of }) });
  if (h.sigma !== null && Number.isFinite(h.sigma)) lines.push({ label: t('Unusual'), text: t('{z}σ above its baseline', { z: h.sigma.toFixed(1) }), bold: true });
  if (h.source) lines.push({ text: h.source, color: 'muted' });
  if (h.staleMin !== null) lines.push({ text: t('last sample {n} min ago', { n: h.staleMin }), color: 'above' });
  lines.push({ table: false, text: h.estimate ? t('Further back than the readings held: the history Binance and Bybit keep, chained back from where the line starts. An estimate of the total, and how far it moved since the reading before.') : t('Open interest at the end of the candle, and how far it moved since the end of the one before.'), color: 'muted', wrap: true, rule: true });
  return lines;
}
