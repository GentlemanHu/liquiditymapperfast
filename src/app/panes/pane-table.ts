import { mixHex, type Palette } from '../theme.ts';
import type { Pt } from '../touch.ts';
import { layoutInfo, type InfoColor, type InfoLine, type InfoRow } from '../infobox.ts';

/**
 * The table a pane under the map draws on itself: several things of one kind read at one moment (the Depth pane's bands, the venues of the Funding, Open
 * Interest and Long/Short panes), while its chart shows their history or their sum, and under its rows what the pane's card says of that moment that the
 * rows do not (`TableSpec.lines`: the sum, who opened and closed, the rank, how it was read). Beside the plot where the columns right of it leave room, the
 * last columns going first; else over the plot's left end on a plate while the pointer (or a pinned finger) is on the pane, so it never covers the newest
 * candles and leaves the chart clear at rest; a plate keeps every column, or as many as its `plateMin` says. In a short pane the rows close up (15 px down
 * to 12) and the titles, then the foot, are left out; where even a row each does not fit, there is no table. The card's lines hang under the foot, whole or
 * not at all, and never move the rows: the table's rows, columns and place are what they are without them, so a moment with more lines or fewer (a pointer
 * moving between candles, or onto the table, which reads the newest) shifts nothing a row can be clicked on (review 2026-11-21). A pane hides its hover card
 * only beside a table that is complete (`TablePlace.complete`: its titles, its foot, the columns the card needs and every line), since that table says all
 * the card would (Karl, 2026-11-21: the card had gone wherever a table was drawn, and with it what only the card said); beside a partial table, with Table
 * off, or with no table, the card is there.
 */

/** One cell: its words and, where it has one, its colour (else the text colour). */
export interface TableCell { text: string; color?: string | undefined }

export interface TableSpec {
  /** The column titles, the first over the rows' names (usually empty). */
  heads: readonly string[];
  /** A row a thing, a cell a column, the first cell its name. */
  rows: readonly (readonly TableCell[])[];
  /** What is said under the rows (the time read, the units). */
  foot: string;
  /** The fewest columns kept beside the plot: fewer would not say what the table is for, and it goes on a plate. */
  minCols: number;
  /**
   * The fewest columns a plate keeps, the last going first (at least `minCols`); by default every column, and a plate that cannot hold them
   * all is left out (the pane's card says it). The tables whose last column is × give it `heads.length - 1`, so that column never takes the
   * table away from a pane it fitted before.
   */
  plateMin?: number;
  /** The row lit as the one chosen; -1 for none. */
  focus: number;
  /**
   * What the pane's card says of the moment read that the rows do not (`tableLines`), drawn under the foot after a hairline: a label at the left
   * and its value at the lines' right edge, a plain line at the left, a long sentence wrapped to the lines' width, the card's own hairlines kept.
   * None, or empty, where the rows say all the card does.
   */
  lines?: readonly InfoLine[];
  /**
   * The fewest columns a complete table keeps: those that say something the card says (Funding's APR and premium, Long/Short's shares, Depth's
   * bands and ×), by default all of them. A table whose card's figures are all in its lines (Open Interest, the Liquidity Tracker and Delta, whose
   * card speaks of the total) gives 1: the columns after it are the table's own, and one that goes (the × first) leaves the table complete.
   */
  cardCols?: number;
}

/** The pane's room, in plot coordinates: its width and height, the plot's width, the price axis's and whether a pointer (or a finger) is on the pane. */
export interface TableRoom { w: number; h: number; plotW: number; axisW: number; pointing: boolean }

/**
 * Where a table goes: the row height, what of it fits, its left edge and width, whether it is on a plate, its top, its first row, each column's right edge
 * and its height (titles, rows and foot), all as they are without the card's lines; the card's lines as laid out under the foot (none where they were left
 * out), the width they take (never narrower than the rows) and the height (their hairline included); and whether it is complete.
 */
export interface TablePlace {
  rowH: number; titles: boolean; foot: boolean; cols: number; left: number; plate: boolean; width: number; y0: number; first: number; rights: number[]; height: number;
  summary: readonly InfoRow[]; summaryW: number; summaryH: number; complete: boolean;
}

/** The colours a table is painted in: the side colours colour the card's lines (a palette without them paints those in the text colour). */
export type TablePalette = Pick<Palette, 'panel' | 'line' | 'text' | 'muted'> & Partial<Pick<Palette, 'bid' | 'ask' | 'candleUp' | 'candleDown'>>;

const GAP = 7, PAD = 5;
const ROW_HEIGHTS = [15, 14, 13, 12] as const;
/** The room under the rows for the hairline that sets the card's lines apart, and for each hairline of the card's own between them. */
const SEP = 5, RULE = 4;

/**
 * The most rows a table gives things of its own in a pane `h` px high, where there can be more of them than rows (the markets of the Liquidity
 * Tracker and the Delta pane): those that fit at 13 px with the titles and the foot, at most eight. The pane gives the largest a row each and
 * adds up the rest in the last one, so the table is never left out for having too many rows (`placeTable` draws none where a row each does not fit).
 */
export const tableRowCap = (h: number): number => Math.max(0, Math.min(8, Math.floor((h - 4) / 13) - 2));

/** A figure of a table in a side's colour, a little towards the text colour so that it reads at this size. */
export const tableInk = (side: string, p: Pick<Palette, 'text'>): string => mixHex(side, p.text, 0.2);

/**
 * The lines of a pane's card that its table says under its rows: all but those the card leaves out (`InfoLine.table`: what the rows, the foot or
 * the header say already, and what explains rather than reads), without a venue mark (the label or the words name the venue) and as one piece
 * of words where the card draws it in pieces.
 */
export function tableLines(lines: readonly InfoLine[] | null | undefined): InfoLine[] {
  return (lines ?? []).filter(line => line.table !== false).map(line => {
    const copy = { ...line };
    delete copy.mark; delete copy.runs;
    return copy;
  });
}

/** The card's lines under a heading that says what they are of (the total, a venue, a band), or none where there are none. */
export const headed = (heading: string, lines: readonly InfoLine[]): InfoLine[] => lines.length ? [{ text: heading, bold: true }, ...lines] : [];

/**
 * How many times the larger of two sides (bids and asks, longs and shorts, buys and sells) is the smaller, and which one leads: 1 the first, -1
 * the second, 0 where the ratio is written 1.00×. Null where there is nothing to compare (both empty, or a side not read); Infinity where only
 * one side has something.
 */
export function sideRatio(first: number, second: number): { ratio: number; lead: 1 | -1 | 0 } | null {
  if (!Number.isFinite(first) || !Number.isFinite(second) || first < 0 || second < 0 || (first <= 0 && second <= 0)) return null;
  const big = Math.max(first, second), small = Math.min(first, second), ratio = small > 0 ? big / small : Infinity;
  return { ratio, lead: Math.round(ratio * 100) <= 100 ? 0 : first > second ? 1 : -1 };
}

/** A ratio as the tables write it: two decimals under 10, one under 100, whole under 1000, then >999× (a cell stays narrow); ∞ where the other side has none. */
export const ratioFigure = (ratio: number): string => !Number.isFinite(ratio) ? '∞' : ratio >= 999.5 ? '>999×' : `${ratio < 9.995 ? ratio.toFixed(2) : ratio < 99.95 ? ratio.toFixed(1) : Math.round(ratio)}×`;

/** The × cell of a table: the ratio in the leading side's colour (the first side's is `p.bid`), muted where neither leads, a dash where there is nothing to compare. */
export function ratioCell(first: number, second: number, p: Pick<Palette, 'bid' | 'ask' | 'text' | 'muted'>): TableCell {
  const r = sideRatio(first, second);
  if (!r) return { text: '–', color: p.muted };
  return { text: ratioFigure(r.ratio), color: r.lead ? tableInk(r.lead > 0 ? p.bid : p.ask, p) : p.muted };
}

/**
 * Where a table goes in `room`, or null where it does not fit. `measure` is the width of a text in the pane's font (`bold`: in its heavier face). The rows
 * go where they went before the card's lines: beside the plot where the columns right of it leave room (as many columns as fit, down to `minCols`), else,
 * under a pointer, on a plate over the plot's left end (down to `plateMin` columns), in the middle of the pane's height, their titles and then their foot
 * left out where it is short. The lines go under the foot where the pane has room below and, beside the plot, the strip (on a plate, 60 % of the plot)
 * has room across: as wide as the widest one that does not wrap and never narrower than the rows, their sentences wrapped to that. Complete: the titles,
 * the foot and the columns the card needs (`cardCols`), with every line.
 */
export function placeTable(measure: (text: string, bold?: boolean) => number, room: TableRoom, spec: Pick<TableSpec, 'heads' | 'rows' | 'minCols' | 'plateMin' | 'lines' | 'cardCols'>): TablePlace | null {
  const k = spec.rows.length, n = spec.heads.length, lines = spec.lines ?? [];
  let rowH = 0, titles = true, foot = true;
  fit: for (const [withTitles, withFoot] of [[true, true], [false, true], [false, false]] as const) {
    for (const h of ROW_HEIGHTS) if ((k + (withTitles ? 1 : 0) + (withFoot ? 1 : 0)) * h + 4 <= room.h) { rowH = h; titles = withTitles; foot = withFoot; break fit; }
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
    // On a plate the last columns go first too, down to `plateMin` (every column unless the table says otherwise).
    const least = Math.min(n, Math.max(spec.minCols, spec.plateMin ?? n));
    for (cols = n; cols > least && width(cols) > room.plotW * 0.6;) cols--;
    if (width(cols) > room.plotW * 0.6) return null;
  }
  // In the middle of the pane's height, every pane's table alike.
  const height = (k + (titles ? 1 : 0) + (foot ? 1 : 0)) * rowH, y0 = Math.round(room.h / 2 - height / 2), first = y0 + (titles ? rowH : 0);
  const rights: number[] = [];
  for (let c = 0, x = left + PAD; c < cols; c++) { x += widths[c]!; rights.push(x); x += GAP; }
  const rowsOnly = { rowH, titles, foot, cols, left, plate, width: width(cols), y0, first, rights, height, summary: [], summaryW: width(cols), summaryH: 0 };
  // Complete only with the titles over the figures, the foot that says the moment read and the columns that say what the card says.
  const framed = titles && foot && cols >= Math.min(n, Math.max(spec.minCols, spec.cardCols ?? n));
  if (!lines.length || !framed) return { ...rowsOnly, complete: framed && !lines.length };
  // A wrapped line's label stays on a row of its own, so it must fit across too.
  const natural = Math.max(0, ...lines.map(line => line.wrap === true ? (line.label !== undefined ? measure(line.label) : 0)
    : (line.label !== undefined ? measure(line.label) + 2 * GAP : 0) + measure(line.text, line.bold === true)));
  const summaryW = Math.max(rowsOnly.width, natural + 2 * PAD);
  if (summaryW > (plate ? room.plotW * 0.6 : free - 4)) return { ...rowsOnly, complete: false };
  const summary = layoutInfo((text, bold) => measure(text, bold), lines, summaryW - 2 * PAD).rows;
  // The first line's hairline is the one over them.
  const summaryH = SEP + summary.length * rowH + summary.filter((row, i) => row.rule && i > 0).length * RULE;
  if (y0 + height + summaryH > room.h - 2) return { ...rowsOnly, complete: false };
  return { ...rowsOnly, summary, summaryW, summaryH, complete: true };
}

/** The heavier face of a canvas font ("11px sans" -> "600 11px sans"), for the card's bold lines. */
const boldFont = (font: string): string => /^(?:bold|[1-9]00)\s/.test(font) ? font : `600 ${font}`;
/** A card line's colour in a table: the side colours as the table's figures have them (`tableInk`), the muted one, else the text colour. */
function inkOf(color: InfoColor, p: TablePalette): string {
  const side = color === 'below' ? p.bid : color === 'above' ? p.ask : color === 'buy' ? p.candleUp : color === 'sell' ? p.candleDown : undefined;
  return side ? tableInk(side, p) : color === 'muted' ? p.muted : p.text;
}

/**
 * Draw a placed table: the plate under it if it has one (under the card's lines too), the titles, a row each (the chosen one lit, the one `hover` less so),
 * the foot, and the card's lines under a hairline (labels muted at the left, their values at the lines' right edge in their colours, bold where the card
 * has them bold).
 */
export function paintTable(ctx: CanvasRenderingContext2D, p: TablePalette, at: TablePlace, spec: TableSpec, hover: number): void {
  const k = spec.rows.length, wide = at.summary.length ? Math.max(at.width, at.summaryW) : at.width, tall = at.height + (at.summary.length ? at.summaryH : 0);
  if (at.plate) { ctx.fillStyle = p.panel; ctx.globalAlpha = 0.9; ctx.fillRect(at.left, at.y0 - 2, wide, tall + 4); ctx.globalAlpha = 1; ctx.strokeStyle = p.line; ctx.strokeRect(at.left + 0.5, at.y0 - 1.5, wide - 1, tall + 3); }
  ctx.textAlign = 'right'; ctx.fillStyle = p.muted;
  if (at.titles) for (let c = 1; c < at.cols; c++) ctx.fillText(spec.heads[c]!, at.rights[c]!, at.y0 + at.rowH / 2);
  for (let j = 0; j < k; j++) {
    const y = at.first + j * at.rowH, row = spec.rows[j]!, mid = y + at.rowH / 2;
    if (j === spec.focus || j === hover) { ctx.fillStyle = p.text; ctx.globalAlpha = j === spec.focus ? 0.1 : 0.05; ctx.fillRect(at.left + 2, y, at.width - 4, at.rowH); ctx.globalAlpha = 1; }
    ctx.textAlign = 'left'; ctx.fillStyle = row[0]!.color ?? (j === spec.focus ? p.text : p.muted); ctx.fillText(row[0]!.text, at.left + PAD, mid);
    ctx.textAlign = 'right';
    for (let c = 1; c < at.cols; c++) { ctx.fillStyle = row[c]!.color ?? p.text; ctx.fillText(row[c]!.text, at.rights[c]!, mid); }
  }
  ctx.textAlign = 'left'; ctx.fillStyle = p.muted;
  if (at.foot && spec.foot) ctx.fillText(spec.foot, at.left + PAD, at.first + k * at.rowH + at.rowH / 2);
  if (at.summary.length) {
    const base = ctx.font, heavy = boldFont(base), right = at.left + at.summaryW - PAD;
    const rule = (yy: number): void => { ctx.globalAlpha = 0.5; ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(at.left + PAD, Math.round(yy) + 0.5); ctx.lineTo(right, Math.round(yy) + 0.5); ctx.stroke(); ctx.globalAlpha = 1; };
    let y = at.y0 + at.height;
    rule(y + SEP / 2); y += SEP;
    at.summary.forEach((row, i) => {
      if (row.rule && i > 0) { rule(y + RULE / 2); y += RULE; }
      const mid = y + at.rowH / 2;
      if (row.label !== undefined) { ctx.textAlign = 'left'; ctx.fillStyle = p.muted; ctx.fillText(row.label, at.left + PAD, mid); }
      if (row.text) {
        ctx.font = row.bold ? heavy : base; ctx.fillStyle = inkOf(row.color, p);
        if (row.label !== undefined) { ctx.textAlign = 'right'; ctx.fillText(row.text, right, mid); } else { ctx.textAlign = 'left'; ctx.fillText(row.text, at.left + PAD, mid); }
        ctx.font = base;
      }
      y += at.rowH;
    });
  }
}

/** What a table needs of its pane. */
export interface TableHost { canvas: HTMLCanvasElement; left: () => number; rangeGesture: () => boolean; invalidate: () => void }

/**
 * A pane's table and the pointer over it. It owns the pointer over it (the time is not read there, so that it can be read); with `onRow`, a row under
 * the pointer is lit and takes a click or a tap.
 */
export class PaneTable {
  #at: TablePlace | null = null;
  #rows = 0;
  #hover = -1;
  /** When a finger last chose a row: the click the browser sends after that tap is the same choice, not a second one. */
  #tappedAt = -Infinity;

  constructor(private readonly host: TableHost, private readonly onRow: ((row: number) => void) | null = null) {
    if (!onRow) return;
    host.canvas.addEventListener('click', e => {
      if (host.rangeGesture() || (e as PointerEvent).pointerType === 'touch' || performance.now() - this.#tappedAt < 800) return;
      const r = host.canvas.getBoundingClientRect(), row = this.#rowAt(e.clientX - r.left - host.left(), e.clientY - r.top);
      if (row >= 0) onRow(row);
    });
    host.canvas.addEventListener('pointerleave', () => this.#light(-1));
  }

  /** No table this frame (a pane calls it before it draws, so that one it does not draw takes no pointer). */
  clear(): void { this.#at = null; }

  /** Draw it where it fits; where it went, or null where it does not. The card's bold lines are measured in the font's heavier face. */
  draw(ctx: CanvasRenderingContext2D, p: TablePalette, room: TableRoom, spec: TableSpec): TablePlace | null {
    const base = ctx.font, heavy = boldFont(String(base));
    const measure = (text: string, bold = false): number => {
      if (!bold) return ctx.measureText(text).width;
      ctx.font = heavy; const width = ctx.measureText(text).width; ctx.font = base;
      return width;
    };
    const at = placeTable(measure, room, spec);
    this.#at = at; this.#rows = spec.rows.length;
    if (at) paintTable(ctx, p, at, spec, this.#hover);
    return at;
  }

  /**
   * Whether the pointer at `x` (plot coordinates) is over the table's rows (its titles to its foot). Not its card's lines: owning them would clear the time
   * read, so the lines (of that time) would go, and a pointer that stayed would read the time again and bring them back, every move (review 2026-11-21).
   */
  owns(x: number, pointer: { y: number } | null): boolean {
    const at = this.#at;
    if (!at || !pointer) { this.#light(-1); return false; }
    const y = pointer.y - this.host.canvas.getBoundingClientRect().top;
    if (this.onRow) { const row = this.#rowAt(x, y); this.#light(row); if (row >= 0) this.host.canvas.style.cursor = 'pointer'; }
    return x >= at.left && x <= at.left + at.width && y >= at.first - at.rowH && y <= at.first + (this.#rows + 1) * at.rowH;
  }

  /** Whether a press at `x` is the table's: over a table whose rows take a click; one only read lets a drag move the time axis as over the plot. */
  takesPress(x: number, pointer: { y: number } | null): boolean { return !!this.onRow && this.owns(x, pointer); }

  /** Whether a finger's tap at `p` (plot coordinates) chose a row. */
  tap(p: Pt): boolean {
    if (!this.onRow) return false;
    const row = this.#rowAt(p.x, p.y);
    if (row < 0) return false;
    this.#tappedAt = performance.now(); this.onRow(row);
    return true;
  }

  #light(row: number): void { if (row !== this.#hover) { this.#hover = row; this.host.invalidate(); } }
  #rowAt(x: number, y: number): number {
    const at = this.#at;
    if (!at || x < at.left || x > at.left + at.width) return -1;
    const row = Math.floor((y - at.first) / at.rowH);
    return row >= 0 && row < this.#rows ? row : -1;
  }
}
