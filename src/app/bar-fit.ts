/**
 * How the full top bar fits a window (Karl, 2026-10-25: at about 1,500 px its last deck wrapped alone onto a second row, and on a smaller
 * screen the rows were ragged, with Tools pushed to the right across a gap). The bar's decks are boxes of a fixed natural width; this chooses
 * how they sit in a window of `available` px, as pure numbers so it is tested without a browser:
 *
 * - they fit in one row at their own size: nothing changes (what a large screen has always had);
 * - they fit in one row once the bar is scaled down, to no less than `BAR_ZOOM_FLOOR` (the text-mode theme already runs the bar at 10.5 px,
 *   0.875 of its 12, and it reads well): the bar is `zoom`ed by that much, so its boxes keep their proportions and the window's width is used;
 * - they do not: two rows, broken where the longer of the two is shortest (whole decks, in their order), at their own size, or scaled down
 *   as far as the floor if a row still does not fit.
 */
export const BAR_ZOOM_FLOOR = 0.85;

export interface BarFit {
  /** The scale of the bar, 1 for its own size, never under `BAR_ZOOM_FLOOR`. */
  zoom: number;
  /** The index of the deck that begins the second row, or null for one row. */
  breakBefore: number | null;
}

/** The width of `widths` laid in a row: the boxes, the gaps between them, and the bar's own padding. */
const rowWidth = (widths: readonly number[], gap: number, pad: number): number => widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1) + pad;
/** The scale at which `need` px fit `available`, to a hundredth and never over (so what is scaled always fits), and never over 1. */
const scaleFor = (need: number, available: number): number => need > 0 ? Math.min(1, Math.floor(available / need * 100) / 100) : 1;

/**
 * `widths`: each deck's natural width (px at zoom 1), in order; `gap`: the space between two decks of a row; `pad`: the bar's padding left and
 * right together; `available`: the width of the bar at zoom 1.
 */
export function fitBar(widths: readonly number[], gap: number, pad: number, available: number, floor: number = BAR_ZOOM_FLOOR): BarFit {
  const whole = rowWidth(widths, gap, pad);
  if (!(available > 0) || widths.length < 2 || whole <= available) return { zoom: 1, breakBefore: null };
  const one = scaleFor(whole, available);
  if (one >= floor) return { zoom: one, breakBefore: null };
  let best = 1, need = Infinity;
  for (let k = 1; k < widths.length; k++) {
    const longer = Math.max(rowWidth(widths.slice(0, k), gap, pad), rowWidth(widths.slice(k), gap, pad));
    if (longer < need) { need = longer; best = k; }
  }
  return { zoom: Math.max(floor, scaleFor(need, available)), breakBefore: best };
}
