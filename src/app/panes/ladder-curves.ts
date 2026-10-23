import type { InfoLine } from '../infobox.ts';
import { contrastRatio, mixHex, type Palette } from '../theme.ts';
import { hueGap, nearDirection } from '../cvd/colors.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { t } from '../i18n.ts';
import { distanceText } from './ladder-info.ts';
import type { Grouped } from './levels-data.ts';

/**
 * The Compact book's venue lines: the running total from the mark outward drawn for each of the largest venues on its own, over the total's
 * area, on a linear scale of their own (`lineFraction`). Which venues, and in what order, is the flow column's ranking applied
 * to books: each book's traded volume over the column's ranking window, then (a book with no trades held) its liquidity in view. Everything
 * here is pure; the pane draws it.
 */

/** How long the lines keep their venues and colours while the same books are on (a line that changed colour each frame would be unreadable). */
export const CURVE_HOLD_MS = 60_000;
/** How close (px) the pointer must be to a line, across, to pick it. */
export const CURVE_HIT_PX = 5;

/**
 * Where `v` sits across the lines' axis, 0 (the wall) to 1 (`full`, the largest of their running totals in view). The axis is linear: a log
 * one (three decades) was tried first and crowded the lines against the right wall instead of the left (Karl, 2026-10-12).
 */
export function lineFraction(v: number, full: number): number {
  return v > 0 && full > 0 ? Math.min(1, v / full) : 0;
}
/** Round values on the lines' axis for its gridlines: steps of 1, 2 or 5 times a power of ten, at most `most` of them, all short of `full`. */
export function lineTicks(full: number, most = 4): number[] {
  if (!(full > 0)) return [];
  const p = 10 ** Math.floor(Math.log10(full / most)), step = [1, 2, 5, 10].map(m => m * p).find(s => full / s <= most + 1)!;
  const out: number[] = [];
  for (let k = 1; k * step < full && out.length < most; k++) out.push(k * step);
  return out;
}

/**
 * One venue's running total from the mark outward, by the rule of the whole book's (`cumulative` in levels-data.ts): bids from the mark's bin
 * downward, asks from it upward, the mark's own bin counting for both. Summed over the venues it is the whole book's.
 */
export function venueCumulative(g: Pick<Grouped, 'nBins' | 'bid' | 'ask'>, index: number, markBin: number): { bid: Float32Array; ask: Float32Array } {
  // One grouping serves every draw of a frame (a pointer move, a cue's decay): the totals are shared, read and never written.
  const key = `${index}:${markBin}`;
  let memo = walked.get(g);
  const hit = memo?.get(key);
  if (hit) return hit;
  const { nBins } = g, bid = new Float32Array(nBins), ask = new Float32Array(nBins), b = g.bid[index], a = g.ask[index];
  let run = 0;
  if (b) for (let i = Math.min(nBins - 1, markBin); i >= 0; i--) { run += b[i]!; bid[i] = run; }
  run = 0;
  if (a) for (let i = Math.max(0, markBin); i < nBins; i++) { run += a[i]!; ask[i] = run; }
  const made = { bid, ask };
  if (!memo) { memo = new Map(); walked.set(g, memo); }
  if (memo.size >= WALKED_MEMO) memo.delete(memo.keys().next().value!);
  memo.set(key, made);
  return made;
}
const walked = new WeakMap<object, Map<string, { bid: Float32Array; ask: Float32Array }>>();
/** Venues the lines are drawn for (at most eight) at the mark's bin now and a bin or two off it. */
const WALKED_MEMO = 32;

/**
 * A venue the lines are drawn for: its book, its traded volume over the ranking window (null: no trades held for it) and its place.
 * `shallow`: ranked in, but its book reaches too few rows for a line (`CURVE_MIN_ROWS`), so the next book took its line; it is named, not drawn.
 */
export interface CurveVenue { id: string; volume: number | null; rank: number; shallow?: true }

/**
 * The fewest rows from the mark (at the Group step) a book must reach on at least one side to get a line. MEXC's page feed sends its best 20
 * levels, about 1 bp: at a step of 50 its line was one row, invisible, and took one of the five places (Karl, 2026-10-16). Three rows of 50
 * on BTC are about 18 bp, so Bybit's and Bitget's books (25 to 50 bp) keep theirs: a share of the view would drop the venues that trade most.
 */
export const CURVE_MIN_ROWS = 3;

/** Whole rows of `step` from the mark that a book's reach spans on its longer side (0 without one). */
export function reachRows(cover: { lo: number; hi: number } | null, mark: number, step: number): number {
  if (!cover || !(step > 0) || !(mark > 0)) return 0;
  return Math.max(0, Math.floor(Math.max(cover.hi - mark, mark - cover.lo) / step));
}

/** How far a book reaches either side of the mark, in percent ("−0.25% … +0.25%"). */
export function reachText(cover: { lo: number; hi: number }, mark: number): string {
  const pct = (price: number): string => distanceText(price, mark).split(' · ')[0]!;
  return `${pct(cover.lo)} … ${pct(cover.hi)}`;
}

/**
 * The `n` venues to draw: those with traded volume first, the most first, then those with none held by their liquidity in view, the most
 * first (a book with neither is left out). Ties go to the id, so a stable input gives a stable order. A book `drawable` turns down keeps its
 * place in the order, marked `shallow`, and does not count toward `n`.
 */
export function rankCurveVenues(ids: readonly string[], volume: (id: string) => number | null, liquidity: (id: string) => number, n: number, drawable: (id: string) => boolean = () => true): CurveVenue[] {
  const rows = ids.map(id => ({ id, volume: volume(id), liquidity: liquidity(id) }))
    .filter(r => (r.volume !== null && r.volume > 0) || r.liquidity > 0)
    .map(r => ({ ...r, volume: r.volume !== null && r.volume > 0 ? r.volume : null }));
  rows.sort((a, b) => (a.volume === null) !== (b.volume === null) ? (a.volume === null ? 1 : -1)
    : a.volume !== null && b.volume !== null && a.volume !== b.volume ? b.volume - a.volume
      : a.volume === null && a.liquidity !== b.liquidity ? b.liquidity - a.liquidity : a.id < b.id ? -1 : 1);
  const out: CurveVenue[] = [];
  let drawn = 0;
  for (const [i, r] of rows.entries()) {
    if (drawn >= n) break;
    if (drawable(r.id)) { out.push({ id: r.id, volume: r.volume, rank: i + 1 }); drawn++; }
    else out.push({ id: r.id, volume: r.volume, rank: i + 1, shallow: true });
  }
  return out;
}

/**
 * Holds the ranking for `CURVE_HOLD_MS` while the same books are on and the count and the ranking window are the same; asked again after
 * that, or at once when any of them changes (a held ranking's volumes would otherwise be named with another window). The volumes on a held
 * ranking are those of when it was made.
 */
export class CurveRanking {
  #key = ''; #at = -Infinity; #venues: CurveVenue[] = [];
  /** `make` is called only when the ranking is due: it ranks the venues now. */
  apply(now: number, ids: readonly string[], n: number, make: () => CurveVenue[], window = ''): CurveVenue[] {
    const key = `${n}|${window}|${[...ids].sort().join(',')}`;
    if (key !== this.#key || now - this.#at >= CURVE_HOLD_MS || (!this.#venues.length && n > 0)) { this.#key = key; this.#at = now; this.#venues = make(); }
    return this.#venues;
  }
  /** Rank again at the next call. */
  reset(): void { this.#key = ''; this.#at = -Infinity; this.#venues = []; }
}

/**
 * Line colours, by place: hues around the colour wheel in a fixed order of preference (blue, orange, purple, yellow, cyan, magenta, …),
 * never one within 30 degrees of the theme's buy or sell colour (the hue tells the lines apart, it never says direction) and none within
 * 30 degrees of one already taken, each pushed toward the text colour until it stands 3:1 clear of the panel. Past what the hues give,
 * greys of different strength. The venue itself is named by its mark in the header.
 */
// No pure red or green: those read as sell and buy whatever the theme (and are the pair a red-green deficiency cannot tell apart).
const HUES = [205, 35, 275, 55, 90, 315, 180, 240, 15, 295, 150, 255];
const hsl = (h: number, s: number, l: number): string => {
  const f = (n: number): string => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l), v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(v * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
};
const legible = (color: string, p: Pick<Palette, 'panel' | 'text'>): string => {
  let amount = 0, tone = color;
  while (amount < 1 && contrastRatio(tone, p.panel) < 3) { amount = Math.min(1, amount + 0.05); tone = mixHex(color, p.text, amount); }
  return tone;
};
const colourCache = new WeakMap<Palette, string[]>();
export function curveColors(p: Palette, n = 8): string[] {
  const held = colourCache.get(p);
  if (held && held.length >= n) return held.slice(0, n);
  const out: string[] = [], hues: number[] = [];
  for (const h of HUES) {
    if (out.length >= n) break;
    const c = hsl(h, 0.72, p.dark ? 0.62 : 0.46);
    if (nearDirection(c, p) || hues.some(other => hueGap(h, other) < 30)) continue;
    const tone = legible(c, p);
    // Pushing toward the text colour can bring a hue close to the buy or sell colour's (a dark text on a pale hue): such a one is left out too.
    if (nearDirection(tone, p) || out.includes(tone)) continue;
    out.push(tone); hues.push(h);
  }
  // The text colour faded, then plain greys (a theme whose text is tinted, as the terminal's green, gets those).
  const greys = [0, 0.2, 0.35, 0.5].map(amount => mixHex(p.text, p.panel, amount)).concat(p.dark ? ['#e0e0e0', '#b8b8b8', '#909090', '#a4a4a4'] : ['#3a3a3a', '#5c5c5c', '#7a7a7a', '#4b4b4b']);
  for (const tone of greys) {
    if (out.length >= n) break;
    const grey = legible(tone, p);
    if (!out.includes(grey) && !nearDirection(grey, p)) out.push(grey);
  }
  colourCache.set(p, out);
  return out.slice(0, n);
}

/** The line nearest the pointer across (`xs`: each line's x on the pointer's row, null where it is not drawn), within `tol` px; ties to the earlier (higher ranked) line. */
export function nearestCurve(xs: readonly (number | null)[], x: number, tol = CURVE_HIT_PX): number | null {
  let best: number | null = null, gap = Infinity;
  xs.forEach((cx, i) => { if (cx === null) return; const d = Math.abs(cx - x); if (d <= tol && d < gap) { gap = d; best = i; } });
  return best;
}

/**
 * How much of its strength a venue line keeps where it lies over a bar. What is read there is the bar (its pieces carry the venues' names and
 * sizes), and a line across them made the labels unreadable (Karl, 2026-10-23): over a bar the line is a faint trace under the labels, in the
 * clear it is whole, and the line under the pointer is whole everywhere.
 */
export const CURVE_OVER_BAR_SHARE = 0.35;

/** One row a venue line stands on: its screen row `r`, its x there, and the y of the row's edge nearer the mark and of the edge farther from it. */
export interface LineStep { r: number; x: number; near: number; far: number }

/** A venue line's strokes cut at the bars: those over a bar and those in the clear, each a run of x, y pairs (consecutive strokes of one kind are one run). */
export interface CutLine { over: number[][]; free: number[][] }

/**
 * One side of a venue line (its rows from the mark outward, as the pane draws it: from the axis `axis` to the first row's x when the line starts at
 * the mark, then along each row's edge to its x and across the row) cut into the strokes that lie over a bar and those that do not. `ends[r]` is where
 * the bar of screen row `r` ends (NaN or absent: no bar), `dr` the way `r` runs outward (-1 up the screen for the asks, 1 down for the bids). A stroke
 * across a row is over its bar when its x falls short of the bar's end; one along the edge between two rows is over where either of them has a bar
 * (a seam between rows is no clearer than its clearer side is).
 */
export function cutAtBars(steps: readonly LineStep[], axis: number | null, ends: ArrayLike<number>, dr: 1 | -1): CutLine {
  const over: number[][] = [], free: number[][] = [];
  let run: number[] | null = null, runOver = false;
  const line = (x0: number, y0: number, x1: number, y1: number, isOver: boolean): void => {
    if (run && runOver === isOver && run[run.length - 2] === x0 && run[run.length - 1] === y0) { run.push(x1, y1); return; }
    run = [x0, y0, x1, y1]; runOver = isOver; (isOver ? over : free).push(run);
  };
  const endOf = (r: number): number => { const e = ends[r]; return e === undefined || Number.isNaN(e) ? -Infinity : e; };
  // Along the edge between rows `ra` and `rb`, at height `y`: over a bar short of the farther end of the two bars, in the clear beyond it.
  const along = (xa: number, xb: number, y: number, ra: number, rb: number): void => {
    if (xa === xb) return;
    const e = Math.max(endOf(ra), endOf(rb)), lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    if (e <= lo) { line(xa, y, xb, y, false); return; }
    if (e >= hi) { line(xa, y, xb, y, true); return; }
    if (xa < xb) { line(xa, y, e, y, true); line(e, y, xb, y, false); } else { line(xa, y, e, y, false); line(e, y, xb, y, true); }
  };
  steps.forEach((s, j) => {
    const prev = j > 0 ? steps[j - 1]! : null;
    if (prev) along(prev.x, s.x, s.near, prev.r, s.r);
    else if (axis !== null) along(axis, s.x, s.near, s.r - dr, s.r);
    line(s.x, s.near, s.x, s.far, s.x < endOf(s.r));
  });
  return { over, free };
}

/** What is known about one venue's line at one row, to say it. */
export interface CurveFacts {
  id: string; name: string; rank: number;
  /** The row: from `low` up one `step`, an ask or a bid; the mark the book is centred on. */
  low: number; step: number; ask: boolean; mark: number;
  /** This venue's running total from the mark to this row, and everyone's; its size at this row. */
  venueCum: number; totalCum: number; venueLevel: number;
  /** Its traded volume over the ranking window (null: none held) and that window as words ("1 h"). */
  volume: number | null; window: string;
  /** What the lines' full width stands for (they share a scale of their own, not the total's). */
  full: number;
  /**
   * Where this venue's book stops on this side, when the row lies past it (the dashed part of its line), else null or absent. Past it the
   * exchange publishes nothing, so the running total is the least it can be, and its share and its size here are not known.
   */
  reach?: number | null;
}

export function curveLines(f: CurveFacts): InfoLine[] {
  const past = f.reach !== null && f.reach !== undefined;
  return [
    { text: f.name, bold: true, mark: f.id },
    { label: t('Price'), text: `${fmtPrice(f.low, f.step)} – ${fmtPrice(f.low + f.step, f.step)}` },
    { label: t('Side'), text: f.ask ? t('Ask: sellers waiting') : t('Bid: buyers waiting'), color: f.ask ? 'above' : 'below' },
    ...(past ? [
      { text: t('Its published book ends at {price} ({distance}): the dashed line holds the total it reached.', { price: fmtPrice(f.reach!, f.step), distance: distanceText(f.reach!, f.mark) }), color: 'muted' as const, wrap: true },
      { label: t('From the mark'), text: t('at least {value}', { value: `$${usd(f.venueCum)}` }), bold: true },
    ] : [
      { label: t('From the mark'), text: `$${usd(f.venueCum)}`, bold: true },
      { label: t('Share of the depth shown'), text: `${f.totalCum > 0 ? Math.round(f.venueCum / f.totalCum * 100) : 0}%` },
      { label: t('At this price'), text: `$${usd(f.venueLevel)}` },
    ]),
    { label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) },
    { label: t('Lines, full width'), text: `$${usd(f.full)}`, color: 'muted' },
    f.volume !== null
      ? { label: t('Traded, last {window}', { window: f.window }), text: `$${usd(f.volume)} · #${f.rank}`, rule: true }
      : { text: t('No trades held for this book: placed by its liquidity in view.'), color: 'muted', rule: true, wrap: true },
  ];
}
