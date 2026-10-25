import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_ZOOM_FLOOR, fitBar } from '../src/app/bar-fit.ts';

/** The decks of the full top bar as measured in Chrome (2026-10-25): Market, Time, Heatmap, Panels, Chart, Alerts and the page's own, with their gaps and padding. */
const DECKS = [238, 139, 298, 270, 384, 106, 117], GAP = 3, PAD = 12;
const NATURAL = DECKS.reduce((a, b) => a + b, 0) + GAP * (DECKS.length - 1) + PAD;

test('a window the decks fit in at their own size leaves the bar as it is', () => {
  assert.equal(NATURAL, 1582);
  for (const width of [NATURAL, 1600, 1920, 2560, 3840]) assert.deepEqual(fitBar(DECKS, GAP, PAD, width), { zoom: 1, breakBefore: null }, `${width}`);
});

test('a window a little too narrow scales the bar to fit one row, by the hundredth below what fits, never over', () => {
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1536), { zoom: 0.97, breakBefore: null });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1500), { zoom: 0.94, breakBefore: null }, 'Karl\'s screenshot: the Tools deck alone on a second row');
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1440), { zoom: 0.91, breakBefore: null });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1366), { zoom: 0.86, breakBefore: null }, 'the commonest laptop width is one row');
  for (let width = 1346; width < NATURAL; width += 7) {
    const fit = fitBar(DECKS, GAP, PAD, width);
    if (fit.breakBefore === null) assert.ok(NATURAL * fit.zoom <= width, `${width}: what is scaled fits`);
  }
});

test('the zoom never rises as the window narrows while the bar is one row, and stays at or over the floor', () => {
  let last = 1;
  for (let width = 1700; width >= 1300; width -= 3) {
    const fit = fitBar(DECKS, GAP, PAD, width);
    assert.ok(fit.zoom >= BAR_ZOOM_FLOOR && fit.zoom <= 1);
    if (fit.breakBefore !== null) break;
    assert.ok(fit.zoom <= last + 1e-9, `${width}`);
    last = fit.zoom;
  }
});

test('under the floor the bar is two rows, broken where the longer row is shortest, at its own size', () => {
  const fit = fitBar(DECKS, GAP, PAD, 1280);
  assert.deepEqual(fit, { zoom: 1, breakBefore: 3 }, 'Market, Time, Heatmap over Panels, Chart, Alerts, Tools');
  const rows = [DECKS.slice(0, 3), DECKS.slice(3)].map(r => r.reduce((a, b) => a + b, 0) + GAP * (r.length - 1) + PAD);
  assert.ok(Math.max(...rows) <= 1280);
  // No other break gives a shorter longer row.
  for (let k = 1; k < DECKS.length; k++) {
    const other = Math.max(DECKS.slice(0, k).reduce((a, b) => a + b, 0) + GAP * (k - 1), DECKS.slice(k).reduce((a, b) => a + b, 0) + GAP * (DECKS.length - k - 1)) + PAD;
    assert.ok(other >= Math.max(...rows), `break before ${k}`);
  }
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1024), { zoom: 1, breakBefore: 3 });
});

test('a window too narrow even for two rows scales them, to the floor at most', () => {
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 800), { zoom: 0.89, breakBefore: 3 });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 600), { zoom: BAR_ZOOM_FLOOR, breakBefore: 3 }, 'the rest wraps as whole decks, as it always did');
});

test('a floor of 1 (the bevel frame, whose pressed borders snap apart under a fractional zoom) never scales: two balanced rows at its own size', () => {
  for (const width of [1500, 1440, 1366, 1280]) {
    const fit = fitBar(DECKS, GAP, PAD, width, 1);
    assert.deepEqual(fit, { zoom: 1, breakBefore: 3 }, `${width}`);
  }
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1600, 1), { zoom: 1, breakBefore: null });
});

test('degenerate inputs leave the bar alone', () => {
  assert.deepEqual(fitBar([], GAP, PAD, 1000), { zoom: 1, breakBefore: null });
  assert.deepEqual(fitBar([500], GAP, PAD, 100), { zoom: 1, breakBefore: null });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 0), { zoom: 1, breakBefore: null }, 'a bar not laid out yet');
  assert.deepEqual(fitBar(DECKS, GAP, PAD, NaN), { zoom: 1, breakBefore: null });
});
