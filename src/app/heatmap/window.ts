/**
 * The colour window: which cell sizes (USD, or coins while the page writes sizes in coins: app/units.ts) the colour ramp spans. Its baseline
 * comes from the percentiles of the cells on screen (the page's own auto-contrast), and the Contrast slider slides it along the size axis,
 * so the same ramp is spent on thinner liquidity (to the right) or only on the biggest walls (to the left).
 */
export interface SizeWindow { lo: number; hi: number }

/**
 * The slider: 50 is the baseline, 100 slides the window down by three quarters of its own width (the log of hi / lo) to reach thinner
 * liquidity, 0 slides it up by the same, and below 0 it keeps going the same way, so the biggest walls come out paler and paler
 * (the original range stopped at 0, which was not far enough when many venues are added together and the walls are huge).
 */
export const CONTRAST = { min: -100, max: 100, neutral: 50 } as const;

/** A contrast value as the slider can hold it; anything else (a saved value from somewhere unexpected) is the neutral one. */
export function clampContrast(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.max(CONTRAST.min, Math.min(CONTRAST.max, Math.round(n))) : CONTRAST.neutral;
}

/**
 * The window for a baseline and a slider position (a placeholder window until there is a baseline to move). `floor`: a dollar in the units the
 * cells are in (heatmap/coins.ts `rasterFloor`: 1 in dollars, a dollar's worth of coin in coins), which the placeholder is made of.
 */
export function colourWindow(baseline: SizeWindow | null, contrast: number, floor = 1): SizeWindow {
  if (!baseline) return { lo: floor, hi: 2 * floor };
  const shift = -((clampContrast(contrast) - CONTRAST.neutral) / CONTRAST.neutral) * Math.log(baseline.hi / baseline.lo) * 0.75;
  return { lo: baseline.lo * Math.exp(shift), hi: baseline.hi * Math.exp(shift) };
}

/**
 * The window taken from the cells on screen, and the view it was taken for: when (`at`, `since`: the last new view) and the price span; and the
 * units the cells were in (app/units.ts: `coins`, else dollars) with a dollar in them (`floor`, heatmap/coins.ts `rasterFloor`).
 */
export interface Baseline extends SizeWindow { at: number; since: number; spanP: number; coins?: boolean; floor?: number }

/** How long a new view's baseline keeps following the cells while its history loads, and how often Auto blends it toward them after that. */
export const SETTLE_MS = 15_000, BLEND_MS = 10_000;

/**
 * A baseline put into other units (app/units.ts) at `price`, the view's middle: its dollars over the price for coins, its coins times the price
 * for dollars, its floor a dollar's worth there, its timers kept. The page puts the baseline it holds into the new units the moment they are
 * switched, so the colours stay where they were (with Auto off a window is held, and a new one would jump); a baseline already in `coins`'s
 * units, or no price to put it there at, comes back as it is.
 */
export function baselineInUnits(b: Baseline, coins: boolean, price: number): Baseline {
  if ((b.coins === true) === coins || !(price > 0)) return b;
  const put = (v: number): number => coins ? v / price : v * price;
  return { ...b, lo: put(b.lo), hi: put(b.hi), coins, floor: coins ? 1 / price : 1 };
}

/**
 * The colour window held across a switch of the units: the baseline in the page's units, and the one it was in the units the page has just
 * left (`outgoing`), kept until a raster in the new units comes (the page then lets it go), for the grid still drawn in those units.
 */
export interface HeldWindow { baseline: Baseline | null; outgoing: Baseline | null }

/**
 * The held window once the page's units are `coins` (or dollars): as it is in the same units; put into the new ones at `price`, the view's
 * middle, with the baseline it was kept as `outgoing`; or, switched back before the new units' raster came, the outgoing baseline itself again,
 * exactly as it was, however the view moved meanwhile.
 */
export function heldInUnits(h: HeldWindow, coins: boolean, price: number): HeldWindow {
  const b = h.baseline;
  if (!b || (b.coins === true) === coins) return h;
  if (h.outgoing && (h.outgoing.coins === true) === coins) return { baseline: h.outgoing, outgoing: null };
  const put = baselineInUnits(b, coins, price);
  return put === b ? h : { baseline: put, outgoing: b };
}

/**
 * The baseline a grid in `coins` (or dollars) is coloured by: the held one where the grid is in its units; for a grid still in the units the
 * page has just left, the baseline it had then (`outgoing`), never the new one put back at a view that has moved since (a $100 window put into
 * coins at a $50,000 middle and back at $55,000 would be $110); the held one put there at `price` only where no outgoing one is held.
 */
export function baselineFor(h: HeldWindow, coins: boolean, price: number): Baseline | null {
  const b = h.baseline;
  if (!b || (b.coins === true) === coins) return b;
  return h.outgoing && (h.outgoing.coins === true) === coins ? h.outgoing : baselineInUnits(b, coins, price);
}

/**
 * The baseline after a raster with percentiles `s`. A new view (`force`: recentred, another market, venues or size; or a price span 2x off
 * the baseline's) takes a new one, with Auto off too: a cell holds every price of its row, so cell sizes follow the zoom, and a window kept
 * from another view saturates everything or nothing. It follows the cells for `SETTLE_MS` after that, while the view's history loads (the
 * first raster can hold little more than the live column). Then Auto blends it halfway toward the cells every `BLEND_MS`; Auto off holds it.
 * `coins` and `floor`: the units the cells are in and a dollar in them (app/units.ts; 1 in dollars), so a window in coins is the window in
 * dollars over the price. The page puts its baseline into the new units at a switch (`baselineInUnits`); one still in other units than the
 * cells' (there was no price to put it there at) is never kept or blended: a new one is taken.
 */
export function nextBaseline(b: Baseline | null, s: { p15: number; p96: number }, o: { auto: boolean; force: boolean; spanP: number; now: number; coins?: boolean; floor?: number }): Baseline | null {
  if (!(s.p96 > 0)) return b;
  const coins = o.coins === true, floor = o.floor ?? 1, hi = s.p96, lo = Math.max(floor, Math.min(s.p15, hi / 4));
  const zoomed = b !== null && o.spanP > 0 && b.spanP > 0 && Math.abs(Math.log(o.spanP / b.spanP)) > Math.LN2;
  const otherUnits = b !== null && (b.coins === true) !== coins;
  if (!b || o.force || zoomed || otherUnits) return { lo, hi, at: o.now, since: o.now, spanP: o.spanP, coins, floor };
  if (o.now - b.since < SETTLE_MS) return { ...b, lo, hi, at: o.now, floor };
  if (!o.auto || o.now - b.at <= BLEND_MS) return b;
  const blend = (from: number, to: number): number => Math.exp(Math.log(from) * 0.5 + Math.log(to) * 0.5);
  return { ...b, lo: blend(b.lo, lo), hi: blend(b.hi, hi), at: o.now };
}
