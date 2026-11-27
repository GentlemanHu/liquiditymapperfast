import test from 'node:test';
import assert from 'node:assert/strict';
import { gridInCoins, gridRowPrice, rasterFloor } from '../src/app/heatmap/coins.ts';
import { baselineFor, baselineInUnits, colourWindow, heldInUnits, nextBaseline, type Baseline } from '../src/app/heatmap/window.ts';
import { cellColours } from '../src/app/heatmap/canvas.ts';
import type { HeatStyle } from '../src/app/heatmap/gl.ts';
import { buildLut } from '../src/app/heatmap/lut.ts';

// The heatmap in coins (issue 9): the raster's rows each over their own price, and every floor written for dollars a dollar's worth of coin,
// so the picture in coins is the picture in dollars and only the legend's numbers change.

test('a raster in coins: each row over the price in its middle, row 0 the lowest; a row at or below zero holds nothing', () => {
  const w = 3, h = 4, p0 = 100, p1 = 500, grid = new Float32Array(w * h * 2).fill(1000);
  gridInCoins(grid, w, h, p0, p1);
  // Rows of 100: their middles are 150, 250, 350, 450.
  for (let r = 0; r < h; r++) for (let i = 0; i < w * 2; i++) assert.ok(Math.abs(grid[r * w * 2 + i]! - 1000 / (150 + 100 * r)) < 1e-4, `row ${r}`);
  assert.equal(gridRowPrice(0, h, p0, p1), 150);
  assert.equal(gridRowPrice(3, h, p0, p1), 450);
  // The raster reaches a fifth of the view below it: below zero on a coin priced near nothing.
  const low = new Float32Array(2 * 2).fill(5);
  gridInCoins(low, 1, 2, -10, 10);
  assert.deepEqual([...low], [0, 0, 1, 1], 'rows at -5 and 5');
});

test('the floor is a dollar in the raster\'s units: 1 in dollars, a dollar\'s worth of coin at the middle price in coins', () => {
  assert.equal(rasterFloor(false, 80_000, 120_000), 1);
  assert.equal(rasterFloor(true, 80_000, 120_000), 1 / 100_000);
  assert.ok(rasterFloor(true, -5, 5) > 0, 'never zero or below');
  assert.deepEqual(colourWindow(null, 50, 1 / 100_000), { lo: 1 / 100_000, hi: 2 / 100_000 }, 'the placeholder is made of the floor');
  assert.deepEqual(colourWindow(null, 50), { lo: 1, hi: 2 }, 'dollars as before');
});

test('the colour window in coins is the window in dollars over the price, floors included', () => {
  const price = 100_000, k = 1 / price, o = (now: number, coins: boolean) => ({ auto: true, force: false, spanP: 1_000, now, coins, floor: coins ? k : 1 });
  // A sparse view whose p15 is under the dollar floor: the floor decides lo in both units.
  for (const [p15, p96] of [[40_000, 170_000], [0.2, 3], [5, 900]] as const) {
    const usd = nextBaseline(null, { p15, p96 }, o(0, false))!, coins = nextBaseline(null, { p15: p15 * k, p96: p96 * k }, o(0, true))!;
    assert.ok(Math.abs(coins.lo / k - usd.lo) < 1e-9 * usd.lo && Math.abs(coins.hi / k - usd.hi) < 1e-9 * usd.hi, `${p15}..${p96}`);
    assert.equal(coins.coins, true);
    for (const contrast of [-100, 0, 50, 100]) {
      const a = colourWindow(usd, contrast), b = colourWindow(coins, contrast);
      assert.ok(Math.abs(b.lo / k - a.lo) < 1e-6 * a.lo && Math.abs(b.hi / k - a.hi) < 1e-6 * a.hi);
    }
  }
  // A baseline of the other units (the page switched) is never kept or blended: the cells' own is taken, whatever Auto and the view say.
  const usd = nextBaseline(null, { p15: 40_000, p96: 170_000 }, o(0, false))!;
  const settled = nextBaseline(usd, { p15: 40_000, p96: 170_000 }, o(20_000, false))!;
  const switched = nextBaseline(settled, { p15: 0.4, p96: 1.7 }, { ...o(21_000, true), auto: false });
  assert.deepEqual([switched?.lo, switched?.hi, switched?.coins, switched?.since], [0.4, 1.7, true, 21_000]);
});

test('a switch of the units puts the colour window held into the new units at the view\'s middle: same colours, timers kept, no new window', () => {
  const price = 100_000, held = nextBaseline(null, { p15: 40_000, p96: 170_000 }, { auto: false, force: false, spanP: 1_000, now: 0 })!;
  const settled = { ...held, at: 5_000, since: 2_000 }, coins = baselineInUnits(settled, true, price);
  assert.deepEqual([coins.lo, coins.hi, coins.coins, coins.floor, coins.at, coins.since, coins.spanP], [0.4, 1.7, true, 1 / price, 5_000, 2_000, 1_000]);
  for (const contrast of [-100, 0, 50, 100]) {
    const a = colourWindow(settled, contrast), b = colourWindow(coins, contrast);
    assert.ok(Math.abs(b.lo * price - a.lo) < 1e-6 * a.lo && Math.abs(b.hi * price - a.hi) < 1e-6 * a.hi, `contrast ${contrast}: the same window, in coins`);
  }
  const back = baselineInUnits(coins, false, price);
  assert.ok(Math.abs(back.lo - settled.lo) < 1e-6 && Math.abs(back.hi - settled.hi) < 1e-6 && back.coins === false && back.floor === 1, 'and back again');
  assert.equal(baselineInUnits(coins, true, price), coins, 'already in those units');
  assert.equal(baselineInUnits(settled, true, 0), settled, 'no price to put it at: left for the next raster to replace');
  // Held through the switch, Auto off: a raster in the new units changes nothing, as one in the old units would not have.
  assert.equal(nextBaseline(coins, { p15: 0.1, p96: 0.9 }, { auto: false, force: false, spanP: 1_000, now: 40_000, coins: true, floor: 1 / price }), coins);
});

test('across a switch the grid still drawn in the units left keeps the window it had, however the map pans until the new raster comes', () => {
  const usd: Baseline = { lo: 100, hi: 400, at: 1_000, since: 500, spanP: 2_000, coins: false, floor: 1 };
  // Switched to coins at a $50,000 view middle: the page's window is 0.002 BTC, the outgoing one kept as it was.
  const switched = heldInUnits({ baseline: usd, outgoing: null }, true, 50_000);
  assert.deepEqual([switched.baseline?.lo, switched.baseline?.coins, switched.outgoing], [0.002, true, usd]);
  assert.equal(heldInUnits(switched, true, 55_000), switched, 'read again in the same units: nothing changes');
  // Panned to a $55,000 middle while the dollar raster is still drawn: it is coloured by its own $100, not 0.002 BTC back at $55,000 ($110).
  assert.equal(baselineFor(switched, false, 55_000), usd);
  assert.equal(baselineFor(switched, true, 55_000), switched.baseline, 'a grid in the new units: the page\'s');
  // Switched back before the coin raster came: the dollars' own window again, exactly.
  assert.deepEqual(heldInUnits(switched, false, 55_000), { baseline: usd, outgoing: null });
  // Once the new units' raster came the page lets the outgoing one go; a grid in other units then (none is drawn) would take the held one put there.
  assert.ok(Math.abs(baselineFor({ baseline: switched.baseline, outgoing: null }, false, 55_000)!.lo - 110) < 1e-9);
  assert.deepEqual(heldInUnits({ baseline: null, outgoing: null }, true, 50_000), { baseline: null, outgoing: null }, 'no window yet: nothing to carry');
});

/** A grid with cells of every size from a hundredth of a dollar's worth to ten billion. */
function grid(w: number, h: number): Float32Array {
  let x = 12345;
  const rnd = (): number => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const out = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) { if (rnd() < 0.2) continue; out[i * 2] = 10 ** (rnd() * 12 - 2); if (rnd() < 0.6) out[i * 2 + 1] = 10 ** (rnd() * 12 - 2); }
  return out;
}

test('the 2D picture of a grid in coins is the picture of its dollars: the same pixels for every cell, in both styles', () => {
  const w = 61, h = 37, g = grid(w, h), lut = buildLut(false);
  const base: HeatStyle = { bid: [0.1, 0.7, 0.4], bidSoft: [0.05, 0.25, 0.15], ask: [0.9, 0.2, 0.3], askSoft: [0.35, 0.08, 0.12], min: 0.5, max: 5e7, opacity: 1, mode: 'size' };
  // Windows whose low end is under the dollar floor (the floor decides) and above it; a price that is a power of two scales every value
  // exactly, so the coin picture must be the dollar one to the pixel; at another price the colouring tables' steps may move a cell one step.
  for (const mode of ['size', 'sides'] as const) for (const min of [0.5, 2_000]) for (const price of [2 ** 16, 97_431.5]) {
    const k = 1 / price, style = { ...base, mode, min }, coins = g.map(v => v * k);
    const want = new Uint8Array(cellColours(g, w, h, style, lut).buffer);
    const got = new Uint8Array(cellColours(coins, w, h, { ...style, min: min * k, max: style.max * k, floor: k }, lut).buffer);
    let worst = 0, moved = 0;
    for (let i = 0; i < want.length; i++) { const d = Math.abs(want[i]! - got[i]!); worst = Math.max(worst, d); if (d) moved++; }
    if (price === 2 ** 16) assert.equal(worst, 0, `${mode} min ${min}: the same pixels`);
    else assert.ok(worst <= 2 && moved <= want.length * 0.01, `${mode} min ${min} at ${price}: within a step (worst ${worst}, ${moved} bytes)`);
  }
  // Without the floor in coins, a window under a dollar would have been read as a dollar: the floor is what keeps the picture.
  const k = 2 ** -16, coins = g.map(v => v * k), style = { ...base, min: 0.5 * k, max: 5e7 * k };
  assert.notDeepEqual(new Uint8Array(cellColours(coins, w, h, style, lut).buffer), new Uint8Array(cellColours(coins, w, h, { ...style, floor: k }, lut).buffer));
});
