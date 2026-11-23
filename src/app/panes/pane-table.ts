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
 * not at all. The table stands in the middle of the pane's height with the lines it says at rest under it (the newest moment's with no pointer anywhere,
 * the largest block of late as they come and go: `PaneTable`), so that a table with lines does not stand low (Karl, 2026-11-21), and those lines are held
 * while a pointer reads another moment or rests on the pane: a moment with more lines or fewer (a pointer moving between candles, or onto the table, which
 * reads the newest) shifts nothing a row can be clicked on (review 2026-11-21); the columns and the place across are what they are without any lines. A
 * pane hides its hover card only beside a table that is complete (`TablePlace.complete`: its titles, its foot, the columns the card needs and every line),
 * since that table says all the card would (Karl, 2026-11-21: the card had gone wherever a table was drawn, and with it what only the card said); beside a
 * partial table, with Table off, or with no table, the card is there. The Depth pane alone hides its card wherever its table is drawn (Karl, 2026-11-22:
 * with Table on, no pop-up; the pop-up only with Table off), a short pane saying in one row the one thing only the lines said there (`TableSpec.brief`).
 */

/** One cell: its words and, where it has one, its colour (else the text colour). */
export interface TableCell {
  text: string; color?: string | undefined;
  /** Where the figure stands in its own history, 0..1: a short bar under it across the column, filled from the left that far, in its colour. */
  bar?: number | undefined;
  /** The figure in the heavier face (a reading past the history's 95th percentile, or under its 5th). */
  bold?: boolean | undefined;
}

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
  /** A row lit as one under the pointer is (the band under the pointer on the plot), unless the pointer is over another row. */
  lit?: number;
  /**
   * What the pane's card says of the moment read that the rows do not (`tableLines`), drawn under the foot after a hairline: a label at the left
   * and its value at the lines' right edge, a plain line at the left, a long sentence wrapped to the lines' width, the card's own hairlines kept.
   * None, or empty, where the rows say all the card does.
   */
  lines?: readonly InfoLine[];
  /**
   * The lines in brief: said in place of `lines` where those do not fit under the rows (a short pane), laid out as they are and, like them, whole or
   * not at all; a table that says them is not complete. The Depth pane's one row for the band's rank, or for the take profits (Karl, 2026-11-22:
   * with Table on that pane shows no card, so a short pane says the one thing only its lines said in one row).
   */
  brief?: readonly InfoLine[];
  /**
   * Whether the table keeps room under its rows for one row of `brief` (a hairline and a row): its rows close up for it first (down to 12 px, with
   * their titles and foot) where the pane holds them and it, and stand in the middle with that room under them in every frame. Set by the table, never
   * by the moment (a moment with no brief must not move the rows): the Depth pane's, so its rank row has a place in the pane's usual height.
   */
  briefRoom?: boolean;
  /**
   * The fewest columns a complete table keeps: those that say something the card says (Funding's APR and premium, Long/Short's shares, Depth's
   * bands and ×), by default all of them. A table whose card's figures are all in its lines (Open Interest, the Liquidity Tracker and Delta, whose
   * card speaks of the total) gives 1: the columns after it are the table's own, and one that goes (the × first) leaves the table complete.
   */
  cardCols?: number;
  /**
   * What the table is of beyond its titles (the market, the timeframe, a venue, a band): where it changes, the room held for its lines at rest starts
   * afresh (`PaneTable`), so that a table switched to another coin, timeframe or venue does not stand for minutes where the last one's lines left it.
   */
  restKey?: string;
  /**
   * The lines a pointer would bring, for a table that says none at rest (the Flow history's card is a row's, and no row is pointed at then): the rows keep
   * the room of the longest under them at rest (`PaneTable#takeRest`), so that pointing at a row lays its lines under the rows with the whole in the middle,
   * rather than hanging below rows centred alone (Karl, 2026-11-22); none where the longest would not fit (it goes on the card then, and rows held high for a
   * shorter one would stand over an empty gap). Lines too wide for the strip go on the card whatever the room, so they set none.
   */
  restLines?: readonly (readonly InfoLine[])[];
}

/**
 * The pane's room, in plot coordinates: its width and height, the plot's width, the price axis's and whether a pointer (or a finger) is on the pane;
 * `rest`: whether the table reads the moment it reads at rest, no pointer anywhere (the map's or another pane's too) having chosen another
 * (`state.hover` null). Left out: as if a pointer had, so the rows are not centred with what it says then.
 */
export interface TableRoom { w: number; h: number; plotW: number; axisW: number; pointing: boolean; rest?: boolean }

/**
 * Where a table goes: the row height, what of it fits, its left edge and width, whether it is on a plate, its top, its first row, each column's right edge
 * and its height (titles, rows and foot), all as they are without the card's lines but for the top and the first row, which stand where the room held
 * for the lines said at rest leaves the whole in the middle (`placeTable`'s `lift`); the card's lines of the moment read as laid out under the foot
 * (none where they were left out), the width they take (never narrower than the rows) and the height (their hairline included); and whether it is
 * complete.
 */
export interface TablePlace {
  rowH: number; titles: boolean; foot: boolean; cols: number; left: number; plate: boolean; width: number; y0: number; first: number; rights: number[]; height: number;
  /** Each column's width (its widest title or figure), for what is drawn across a column behind a figure (`TableCell.bar`). */
  widths?: number[];
  summary: readonly InfoRow[]; summaryW: number; summaryH: number; complete: boolean;
}

/** The colours a table is painted in: the side colours colour the card's lines (a palette without them paints those in the text colour). */
export type TablePalette = Pick<Palette, 'panel' | 'line' | 'text' | 'muted'> & Partial<Pick<Palette, 'bid' | 'ask' | 'candleUp' | 'candleDown'>>;

const GAP = 7, PAD = 5;
const ROW_HEIGHTS = [15, 14, 13, 12] as const;
/**
 * The lines a table says at rest change with the newest moment: on a one-minute chart the Open Interest card says six lines as a candle opens and
 * up to nine before it closes (who opened and closed comes in), and a note flashes for a frame; the Liquidity Tracker's Ratio line comes and goes at
 * 1.00× (watched at rest, 2026-11-21: held to each moment's lines, Open Interest's rows moved 97 times in 22 minutes); its figures widen and narrow,
 * and with them its columns. The rows keep the largest room for lines that stood `REST_STAND_MS` within the last `REST_HOLD_MS` (`PaneTable#takeRest`):
 * a larger one lifts them once it has stood, a smaller one lets them down only once the larger has not been asked for that long.
 */
export const REST_STAND_MS = 2_000, REST_HOLD_MS = 180_000;
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

type Measure = (text: string, bold?: boolean) => number;
type PlaceSpec = Pick<TableSpec, 'heads' | 'rows' | 'minCols' | 'plateMin' | 'lines' | 'brief' | 'briefRoom' | 'cardCols'>;

/**
 * Where a table goes in `room`, or null where it does not fit. `measure` is the width of a text in the pane's font (`bold`: in its heavier face). The rows
 * go where they went before the card's lines: beside the plot where the columns right of it leave room (as many columns as fit, down to `minCols`), else,
 * under a pointer, on a plate over the plot's left end (down to `plateMin` columns), their titles and then their foot left out where it is short. They
 * stand in the middle of the pane's height with `lift` px kept under them: room for the lines the table says at rest, as `PaneTable` holds it
 * (`restLift`), taken as it is, so that a table and its lines stand in the middle at rest (Karl, 2026-11-21: with its lines under it a table stood low)
 * and nothing of the moment read (its lines, its figures' widths and so its columns) moves the rows; kept inside the pane. The lines go under the foot
 * where the pane has room below and, beside the plot, the strip (on a plate, 60 % of the plot) has room across: as wide as the widest one that does not
 * wrap and never narrower than the rows, their sentences wrapped to that; where they do not fit, the lines in brief (`TableSpec.brief`) the same way.
 * Complete: the titles, the foot and the columns the card needs (`cardCols`), with every line.
 */
export function placeTable(measure: Measure, room: TableRoom, spec: PlaceSpec, lift = 0): TablePlace | null {
  const at = rowsIn(measure, room, spec);
  if (!at) return null;
  const { rowH, titles, foot, cols, left, plate, widths, width, height, framed, under, kept } = at, lines = spec.lines ?? [];
  // A table that keeps room for its brief stands with at least that room under it, whatever stood at rest (`TableSpec.briefRoom`).
  const under0 = Math.max(lift, kept ? SEP + rowH : 0);
  const y0 = under0 > 0 ? Math.max(0, Math.round(room.h / 2 - (height + under0) / 2)) : Math.round(room.h / 2 - height / 2);
  const first = y0 + (titles ? rowH : 0), rights: number[] = [];
  for (let c = 0, x = left + PAD; c < cols; c++) { x += widths[c]!; rights.push(x); x += GAP; }
  const rowsOnly = { rowH, titles, foot, cols, left, plate, width, y0, first, rights, height, widths: widths.slice(0, cols), summary: [], summaryW: width, summaryH: 0 };
  if (!lines.length || !framed) return { ...rowsOnly, complete: framed && !lines.length };
  const fits = (shown: readonly InfoLine[] | undefined): ReturnType<typeof under> => {
    const laid = shown?.length ? under(shown) : null;
    return laid && y0 + height + laid.summaryH <= room.h - 2 ? laid : null;
  };
  const laid = fits(lines);
  if (laid) return { ...rowsOnly, ...laid, complete: true };
  const brief = fits(spec.brief);
  return brief ? { ...rowsOnly, ...brief, complete: false } : { ...rowsOnly, complete: false };
}

/**
 * How much room a table keeps under its rows so that they and `rest`, the lines it says at rest, stand in the middle of the pane together: the height
 * those lines take where they would be drawn with the rows so placed (the titles, the foot, the columns the card needs, room across and in the height),
 * else the height their brief takes (`restBrief`, `TableSpec.brief`) where that is drawn instead, else 0. `PaneTable` works it out at rest only and
 * holds it; `placeTable` takes it as it is.
 */
export function restLift(measure: Measure, room: TableRoom, spec: PlaceSpec, rest: readonly InfoLine[], restBrief: readonly InfoLine[] = []): number {
  const at = rowsIn(measure, room, spec);
  return at ? liftUnder(at, room, rest, restBrief) : 0;
}

/** `restLift` for rows already placed. */
function liftUnder(at: NonNullable<ReturnType<typeof rowsIn>>, room: TableRoom, rest: readonly InfoLine[], brief: readonly InfoLine[] = []): number {
  for (const shown of [rest, brief]) {
    const laid = at.framed && shown.length ? at.under(shown) : null;
    if (laid && leaves(room, at.height, laid.summaryH)) return laid.summaryH;
  }
  return 0;
}

/** The room the longest of `alternatives` takes under rows already placed where it stands inside the pane with them, else 0 (`TableSpec.restLines`). */
function longestUnder(at: NonNullable<ReturnType<typeof rowsIn>>, room: TableRoom, alternatives: readonly (readonly InfoLine[])[]): number {
  let most = 0;
  for (const shown of alternatives) { const laid = at.framed && shown.length ? at.under(shown) : null; if (laid) most = Math.max(most, laid.summaryH); }
  return most > 0 && leaves(room, at.height, most) ? most : 0;
}

/** Whether rows `height` px high, centred with `lift` px under them, stand inside the pane. */
const leaves = (room: TableRoom, height: number, lift: number): boolean => Math.round(room.h / 2 - (height + lift) / 2) + height + lift <= room.h - 2;

/**
 * The rows of a table in `room` as `placeTable` places them but for their height in the pane: the row height, what of it fits, its columns and place
 * across, its height, whether it is framed as a complete table must be, and how lines would be laid out under it. Null where no table fits.
 */
function rowsIn(measure: Measure, room: TableRoom, spec: PlaceSpec) {
  const k = spec.rows.length, n = spec.heads.length;
  const widths = spec.heads.map((head, c) => Math.max(measure(head), ...spec.rows.map(row => measure(row[c]?.text ?? '', row[c]?.bold === true))));
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
  // Complete only with the titles over the figures, the foot that says the moment read and the columns that say what the card says.
  const enough = cols >= Math.min(n, Math.max(spec.minCols, spec.cardCols ?? n));
  let rowH = 0, titles = true, foot = true, kept = false;
  // Room kept for the brief (`TableSpec.briefRoom`): the titles, the rows, the foot, a hairline and one row more, closed up together where they fit,
  // and only for a table framed to say it (one that is not says no lines, so its rows would close up for nothing).
  if (spec.briefRoom && enough) for (const h of ROW_HEIGHTS) if ((k + 3) * h + SEP + 4 <= room.h) { rowH = h; kept = true; break; }
  if (!rowH) fit: for (const [withTitles, withFoot] of [[true, true], [false, true], [false, false]] as const) {
    for (const h of ROW_HEIGHTS) if ((k + (withTitles ? 1 : 0) + (withFoot ? 1 : 0)) * h + 4 <= room.h) { rowH = h; titles = withTitles; foot = withFoot; break fit; }
  }
  if (!rowH) return null;
  const height = (k + (titles ? 1 : 0) + (foot ? 1 : 0)) * rowH;
  const framed = titles && foot && enough;
  /** Lines laid out under the rows, as wide as the widest that does not wrap and never narrower than the rows; null where the strip is narrower. */
  const under = (shown: readonly InfoLine[]): Pick<TablePlace, 'summary' | 'summaryW' | 'summaryH'> | null => {
    // A wrapped line's label stays on a row of its own, so it must fit across too.
    const natural = Math.max(0, ...shown.map(line => line.wrap === true ? (line.label !== undefined ? measure(line.label) : 0)
      : (line.label !== undefined ? measure(line.label) + 2 * GAP : 0) + measure(line.text, line.bold === true)));
    const summaryW = Math.max(width(cols), natural + 2 * PAD);
    if (summaryW > (plate ? room.plotW * 0.6 : free - 4)) return null;
    const summary = layoutInfo((text, bold) => measure(text, bold), shown, summaryW - 2 * PAD).rows;
    // The first line's hairline is the one over them.
    return { summary, summaryW, summaryH: SEP + summary.length * rowH + summary.filter((row, i) => row.rule && i > 0).length * RULE };
  };
  return { rowH, titles, foot, cols, left, plate, widths, width: width(cols), height, framed, under, kept: kept && framed };
}

/** The heavier face of a canvas font ("11px sans" -> "600 11px sans"), for the card's bold lines. */
const boldFont = (font: string): string => /^(?:bold|[1-9]00)\s/.test(font) ? font : `600 ${font}`;
/** A text's width in the canvas's font (`bold`: in its heavier face), the font left as it was. */
const measureOn = (ctx: CanvasRenderingContext2D): Measure => {
  const base = ctx.font, heavy = boldFont(String(base));
  return (text, bold = false) => {
    if (!bold) return ctx.measureText(text).width;
    ctx.font = heavy; const width = ctx.measureText(text).width; ctx.font = base;
    return width;
  };
};
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
    for (let c = 1; c < at.cols; c++) {
      const cell = row[c]!, base = ctx.font;
      ctx.fillStyle = cell.color ?? p.text;
      // How unusual the figure is: a faint fill behind it, from the column's left edge as far across as its rank (a spreadsheet's data bar).
      if (cell.bar !== undefined && Number.isFinite(cell.bar)) {
        const right = at.rights[c]!, w = at.widths?.[c] ?? 0, pad = Math.max(1, Math.round(at.rowH * 0.12));
        ctx.globalAlpha = 0.2; ctx.fillRect(right - w - 2, y + pad, Math.max(1, (w + 4) * Math.max(0, Math.min(1, cell.bar))), at.rowH - 2 * pad); ctx.globalAlpha = 1;
      }
      if (cell.bold) ctx.font = boldFont(base);
      ctx.fillText(cell.text, at.rights[c]!, mid);
      ctx.font = base;
    }
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
  /**
   * The room kept under the rows (px) for the lines the table says at rest (`TableRoom.rest`, and no pointer on the pane), so that its rows and those
   * lines stand in the middle (`restLift`, `placeTable`): the largest that stood lately (`REST_HOLD_MS`), so that the newest moment's lines and figures
   * coming and going do not move the rows at rest either, and kept as it is while a pointer reads another moment or rests on the pane, so that nothing
   * of that moment (its lines, its columns) nor what the newest comes to say meanwhile moves a row under it. Worked out where a pointer would put the
   * table, so a plate (drawn under a pointer only) has it too; kept through `clear()`.
   */
  #lift = 0;
  /** The room that stood at rest, largest first, each with when it last stood: the largest of the last `REST_HOLD_MS` is the first. */
  #stood: { lift: number; at: number }[] = [];
  /** The room the last frame at rest asked for, since when that much has been asked for, and when it was last asked for. */
  #saying: { lift: number; since: number; last: number } | null = null;
  /** The table those were said by (the pane's height, the titles, `TableSpec.restKey`): another starts afresh. */
  #restKey = '';
  /** Since when, at rest, the rows have not left the largest room held (more rows came in), or null while they do. */
  #misfit: number | null = null;

  constructor(private readonly host: TableHost, private readonly onRow: ((row: number) => void) | null = null, private readonly now: () => number = () => performance.now()) {
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

  /**
   * Draw it where it fits; where it went, or null where it does not. The card's bold lines are measured in the font's heavier face. At rest its lines
   * set the room its rows keep under them from then on (`#lift`).
   */
  draw(ctx: CanvasRenderingContext2D, p: TablePalette, room: TableRoom, spec: TableSpec): TablePlace | null {
    const measure = measureOn(ctx);
    if (room.rest === true && !room.pointing) this.#takeRest(measure, room, spec);
    const at = placeTable(measure, room, spec, this.#lift);
    this.#at = at; this.#rows = spec.rows.length;
    if (at) paintTable(ctx, p, at, spec, this.#hover >= 0 ? this.#hover : spec.lit ?? -1);
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

  /**
   * A frame at rest where the pane draws no table, as Funding where its table would not fit beside the plot (it asks the other venues nothing then):
   * its lines still set the room a plate keeps under its rows when a pointer brings one, as `draw` does for every other pane.
   */
  observe(ctx: CanvasRenderingContext2D, room: TableRoom, spec: TableSpec): void {
    if (room.rest === true && !room.pointing) this.#takeRest(measureOn(ctx), room, spec);
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

  /**
   * A frame at rest: the room its lines ask for (`restLift`, where a pointer would put the table, so a plate too; 0 where they would not be drawn: a
   * column short, a pane too low) counts once it has stood `REST_STAND_MS` (at once where none has), and the largest that stood within `REST_HOLD_MS` is
   * the room the rows keep. What the frame before asked for stood until this frame where it had stood by then, as far as frames tell (none came between,
   * however long: a pointer on the pane for minutes), and what is asked for again goes on standing. A room the rows at rest no longer leave (more of
   * them came in: the Liquidity Tracker's markets as they load) goes once they have not left it for `REST_STAND_MS`, as those lines could not be drawn
   * under them: held, it kept a table at the top of its pane with nothing under it (2026-11-21); a single frame with a row more only twitches the rows
   * inside the pane (review round 2: dropped at once, it moved them 45 px and back). Another table (a pane resized, other titles, another `restKey`:
   * a coin, a timeframe, a venue, a band) starts afresh; a block of no lines is only a smaller one (Funding says nothing for a moment as an hour turns,
   * before that hour's row comes in: 2026-11-21 22:00Z).
   */
  #takeRest(measure: Measure, room: TableRoom, spec: TableSpec): void {
    const lines = spec.lines ?? [], now = this.now(), rows = rowsIn(measure, { ...room, pointing: true }, spec);
    const key = `${room.h}\u0001${spec.heads.join('\u0001')}\u0001${spec.restKey ?? ''}`;
    if (key !== this.#restKey) { this.#restKey = key; this.#stood = []; this.#saying = null; this.#misfit = null; }
    const lift = rows ? Math.max(liftUnder(rows, room, lines, spec.brief ?? []), longestUnder(rows, room, spec.restLines ?? [])) : 0, said = this.#saying;
    if (said && (said.lift === lift ? now : said.last) - said.since >= REST_STAND_MS) this.#stand(said.lift, now);
    this.#saying = said?.lift === lift ? { lift, since: said.since, last: now } : { lift, since: now, last: now };
    const stood = this.#stood;
    while (stood.length && stood[0]!.at < now - REST_HOLD_MS) stood.shift();
    // A room the rows here have not left for REST_STAND_MS goes, and any after it they do not leave either (the rooms only shrink down the line).
    if (rows && stood.length && !leaves(room, rows.height, stood[0]!.lift)) {
      this.#misfit ??= now;
      if (now - this.#misfit >= REST_STAND_MS) { while (stood.length && !leaves(room, rows.height, stood[0]!.lift)) stood.shift(); this.#misfit = null; }
    } else this.#misfit = null;
    if (!stood.length) this.#stand(lift, now);
    this.#lift = stood[0]!.lift;
  }

  /** `lift` stood until `at`: it outlasts the smaller rooms before it, which can no longer be the largest of a span it is in. */
  #stand(lift: number, at: number): void {
    const stood = this.#stood;
    while (stood.length && stood[stood.length - 1]!.lift <= lift) stood.pop();
    stood.push({ lift, at });
  }

  #light(row: number): void { if (row !== this.#hover) { this.#hover = row; this.host.invalidate(); } }
  #rowAt(x: number, y: number): number {
    const at = this.#at;
    if (!at || x < at.left || x > at.left + at.width) return -1;
    const row = Math.floor((y - at.first) / at.rowH);
    return row >= 0 && row < this.#rows ? row : -1;
  }
}
