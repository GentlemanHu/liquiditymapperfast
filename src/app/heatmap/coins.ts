/**
 * The heatmap in coins (units.ts, issue 9). The raster worker turns its grid into coins when asked (`gridInCoins`), before its percentiles,
 * so the colour window is taken from coins and the picture keeps its look; every floor the colour window and the renderers keep for dollars
 * is a dollar's worth of coin at the raster's middle price there (`rasterFloor`). Pure, so a Node test reads it: the worker touches `self` as
 * it loads, and it has its own copy of the page's modules, so the units come in each request, never from units.ts.
 */

/** The price row `y` of a grid of `h` rows over [p0, p1) stands for: its middle (row 0 the lowest price, as the raster kernel lays them out). */
export const gridRowPrice = (y: number, h: number, p0: number, p1: number): number => p0 + (y + 0.5) * (p1 - p0) / h;

/**
 * A raster grid of `w` x `h` cells (two floats each, bids then asks; row 0 the lowest price) over the prices [p0, p1), turned into coins in
 * place: each row's cells over the price in the row's middle (`gridRowPrice`), the price its liquidity is valued at to within half a row (a
 * row is about a screen pixel). The kernel's own cut of faint smoothed cells stays a dollar cut: it ran on the dollars. A row at a price of
 * zero or below (the raster reaches a fifth of the view past it, below zero on a coin priced near nothing) holds no coins.
 */
export function gridInCoins(grid: Float32Array, w: number, h: number, p0: number, p1: number): Float32Array {
  for (let r = 0; r < h; r++) {
    const price = gridRowPrice(r, h, p0, p1), k = price > 0 ? 1 / price : 0, end = (r + 1) * w * 2;
    for (let i = r * w * 2; i < end; i++) grid[i] = grid[i]! * k;
  }
  return grid;
}

/**
 * A floor the colour window keeps for dollars (`Math.max(1, ...)`, the shader's `max(min, 1.0)`) in a raster's units: 1 in dollars, in coins
 * a dollar's worth at the middle of the prices it covers, [p0, p1) (a coin's price changes little across a view), so a coin raster is
 * coloured as its dollar one is.
 */
export function rasterFloor(coins: boolean, p0: number, p1: number): number {
  if (!coins) return 1;
  const mid = (p0 + p1) / 2;
  return mid > 0 ? 1 / mid : 1e-12;
}
