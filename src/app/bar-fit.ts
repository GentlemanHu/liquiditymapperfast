/**
 * How the full top bar fits a window (Karl, 2026-10-25: at about 1,500 px its last deck wrapped alone onto a second row, and on a smaller
 * screen the rows were ragged, with Tools pushed to the right across a gap; 2026-10-27: below that the rows still looked unorganised, and a
 * narrow window gave a third row of one deck across the bar). The bar's decks are boxes of a fixed natural width; this chooses how they sit
 * in a window of `available` px, as pure numbers so it is tested without a browser:
 *
 * - they fit in one row at their own size: nothing changes (what a large screen has always had);
 * - they fit in one row once the bar is scaled down, to no less than `BAR_ZOOM_FLOOR` (the text-mode theme already runs the bar at 10.5 px,
 *   0.875 of its 12, and it reads well): the bar is `zoom`ed by that much, so its boxes keep their proportions and the window's width is used;
 * - they do not: the fewest rows that fit at the floor or over, whole decks in their order, broken where the longest row is shortest (so no
 *   row is one small deck left over), at their own size or scaled down as far as the floor if the longest still does not fit. Each row is
 *   then filled by its decks growing in proportion (toolbar.ts, styles.css).
 */
export const BAR_ZOOM_FLOOR = 0.85;

export interface BarFit {
  /** The scale of the bar, 1 for its own size, never under `BAR_ZOOM_FLOOR`. */
  zoom: number;
  /** The index of each deck that begins a row after the first, in order: none for one row. */
  breaks: readonly number[];
}

/** The width of `widths` laid in a row: the boxes, the gaps between them, and the bar's own padding. */
const rowWidth = (widths: readonly number[], gap: number, pad: number): number => widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1) + pad;
/** The scale at which `need` px fit `available`, to a hundredth and never over (so what is scaled always fits), and never over 1. */
const scaleFor = (need: number, available: number): number => need > 0 ? Math.min(1, Math.floor(available / need * 100) / 100) : 1;

/** The rows of `widths` broken before each index of `breaks`. */
export const rowsOf = <T>(items: readonly T[], breaks: readonly number[]): T[][] => [0, ...breaks].map((from, k) => items.slice(from, breaks[k] ?? items.length));

/** Every way to break `n` decks into `rows` rows: the increasing indexes, from `from`, of the decks that begin a row. */
function* splits(n: number, rows: number, from = 1): Generator<number[]> {
  if (rows === 1) { yield []; return; }
  for (let k = from; k <= n - rows + 1; k++) for (const rest of splits(n, rows - 1, k + 1)) yield [k, ...rest];
}

/**
 * `widths`: each deck's natural width (px at zoom 1), in order; `gap`: the space between two decks of a row; `pad`: the bar's padding left and
 * right together; `available`: the width of the bar at zoom 1.
 */
export function fitBar(widths: readonly number[], gap: number, pad: number, available: number, floor: number = BAR_ZOOM_FLOOR): BarFit {
  const whole = rowWidth(widths, gap, pad);
  if (!(available > 0) || widths.length < 2 || whole <= available) return { zoom: 1, breaks: [] };
  const one = scaleFor(whole, available);
  if (one >= floor) return { zoom: one, breaks: [] };
  for (let rows = 2; ; rows++) {
    let breaks: number[] = [], need = Infinity;
    for (const b of splits(widths.length, rows)) {
      const longest = Math.max(...rowsOf(widths, b).map(r => rowWidth(r, gap, pad)));
      if (longest < need) { need = longest; breaks = b; }
    }
    const zoom = scaleFor(need, available);
    // Every deck a row of its own and still too wide: that, at the floor (the window is narrower than any page is laid out for).
    if (zoom >= floor || rows === widths.length) return { zoom: Math.max(floor, zoom), breaks };
  }
}

/**
 * The order of the decks when the bar is in rows (Karl, 2026-10-27, measured over 16 themes and languages): Alerts beside Heatmap. In the
 * decks' own order two rows came out uneven (the longer 38 % longer on average, so one row's decks stretched far more than the other's);
 * this order makes them even (6 %, at most 12 %), the evenest any order with Market first and the page's own deck last gives, and it puts
 * the context and its colouring on the first row (Market, Time, Heatmap, Alerts) and the switches of what is drawn on the second (Panels,
 * Chart). One row keeps the decks' own order.
 */
export const ROWS_ORDER: readonly string[] = ['market', 'time', 'heat', 'alerts', 'panels', 'chart', 'tools'];

export interface BarArrangement {
  fit: BarFit;
  /** The decks as they stand, each the index of one in the order given; `fit.breaks` are positions in this. */
  order: readonly number[];
}

/**
 * How the decks `ids` (in their own order, of `widths`) sit: one row in their own order where that fits at the floor or over, else rows in
 * `rowsOrder` (decks it does not name follow, in their own order), broken as `fitBar` breaks them.
 */
export function arrangeBar(ids: readonly string[], widths: readonly number[], gap: number, pad: number, available: number, floor: number = BAR_ZOOM_FLOOR, rowsOrder: readonly string[] = ROWS_ORDER): BarArrangement {
  const own = ids.map((_, k) => k), one = fitBar(widths, gap, pad, available, floor);
  if (!one.breaks.length) return { fit: one, order: own };
  const rank = (k: number): number => { const r = rowsOrder.indexOf(ids[k]!); return r < 0 ? rowsOrder.length + k : r; };
  const order = [...own].sort((a, b) => rank(a) - rank(b));
  return { fit: fitBar(order.map(k => widths[k]!), gap, pad, available, floor), order };
}
