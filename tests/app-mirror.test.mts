import test from 'node:test';
import assert from 'node:assert/strict';
import { bandVerdict, mirrorLines, mirrorStats, percentText, ratioText } from '../src/app/mirror.ts';
import { depthBandVerdict } from '../src/app/hover-rows.ts';

test('the mirror price is the hovered price reflected about the mid', () => {
  const s = mirrorStats(100, 103, 50, 40)!;
  assert.equal(s.mirror, 97);
  assert.equal(s.distance, 3);
  assert.equal(s.hoveredSide, 'above');
  assert.ok(Math.abs(s.distanceBp - 300) < 1e-9);
  const below = mirrorStats(100, 96, 50, 40)!;
  assert.equal(below.mirror, 104);
  assert.equal(below.hoveredSide, 'below');
});

test('this side is the hovered side: above hovers read the above total, below hovers the below total', () => {
  const up = mirrorStats(100, 105, 90, 30)!;
  assert.deepEqual([up.hovered, up.opposite, up.dominant, up.ratio], [90, 30, 'this', 3]);
  const down = mirrorStats(100, 95, 90, 30)!;
  assert.deepEqual([down.hovered, down.opposite, down.dominant, down.ratio], [30, 90, 'opposite', 3]);
});

test('ratio is larger over smaller, balanced within 2 %, and empty sides are handled', () => {
  assert.equal(mirrorStats(100, 101, 113, 100)!.dominant, 'this');
  assert.ok(Math.abs(mirrorStats(100, 101, 100, 113)!.ratio - 1.13) < 1e-12);
  assert.equal(mirrorStats(100, 101, 100, 101)!.dominant, 'balanced');
  assert.equal(mirrorStats(100, 101, 0, 0)!.dominant, 'none');
  const one = mirrorStats(100, 101, 10, 0)!;
  assert.equal(one.ratio, Infinity);
  assert.equal(one.dominant, 'this');
});

test('no mirror at the mid itself or without a valid mid', () => {
  assert.equal(mirrorStats(100, 100, 1, 1), null);
  assert.equal(mirrorStats(0, 5, 1, 1), null);
  assert.equal(mirrorStats(100, Number.NaN, 1, 1), null);
});

test('the order book\'s box says each band by its price side, then the heavier side in its colour, as the profile\'s box does', () => {
  const above = mirrorLines(mirrorStats(85_000, 85_300, 100e6, 113e6)!, 'Binance');
  assert.deepEqual(above.map(l => [l.text, l.color]), [['Binance', undefined], ['±300.00 (35 bp) from 85,000.0', 'muted'], ['Asks  $100M', 'above'], ['Bids  $113M', 'below'], ['Bids 1.13× the asks', 'below']]);
  assert.equal(above.at(-1)!.bold, true);
  // Named by price side, never this side or the opposite: the pointer below the price with the same bands says the same.
  const below = mirrorLines(mirrorStats(85_000, 84_700, 100e6, 113e6)!);
  const said = (l: { text: string; color?: string; bold?: boolean }): unknown[] => [l.text, l.color, l.bold];
  assert.deepEqual(below.slice(1).map(said), above.slice(2).map(said), 'the same words in the same colours on either side of the price');
  assert.deepEqual(mirrorLines(mirrorStats(100, 101, 113, 100)!).at(-1), { text: 'Asks 1.13× the bids', color: 'above', bold: true, wrap: true }, 'the asks heavier');
  assert.equal(above.at(-1)!.wrap, true, 'wraps in a narrow book, as the profile box\'s verdict does');
  assert.deepEqual(mirrorLines(mirrorStats(100, 101, 5, 5)!).at(-1), { text: 'Bids and asks about even', bold: true, wrap: true }, 'within 2 %, in no side\'s colour');
  assert.deepEqual(mirrorLines(mirrorStats(100, 101, 5, 0)!).at(-1), { text: 'Only asks', color: 'above', bold: true, wrap: true }, 'not a ratio over nothing');
  assert.deepEqual(mirrorLines(mirrorStats(100, 101, 0, 5)!).at(-1), { text: 'Only bids', color: 'below', bold: true, wrap: true });
  assert.deepEqual(mirrorLines(mirrorStats(100, 101, 0, 0)!).at(-1), { text: 'No bids or asks', color: 'muted', wrap: true });
  assert.equal(mirrorLines(mirrorStats(100, 101, 5, 4, true)!).at(-1)!.text, 'part of the range is outside the data');
});

test('the order book\'s box and the profile\'s agree on every pair of bands, with the colour each draws it in', () => {
  const amounts = [0, -1, NaN, Infinity, 1, 4.9e6, 10e6, 10.1e6, 10.2e6, 14e6, 25e6, 1e13];
  for (const bid of amounts) for (const ask of amounts) {
    const book = bandVerdict(bid, ask), profile = depthBandVerdict(bid, ask, '1%'), where = `bids ${bid}, asks ${ask}`;
    assert.equal(book.text.toLowerCase(), profile.text.replace('Within ≈±1%: ', '').toLowerCase(), where);
    assert.equal(book.color, profile.color, `${where}: colour`);
    assert.deepEqual([book.bold, book.wrap, book.rule], [profile.bold, profile.wrap, profile.rule], `${where}: bold, wrap and rule`);
  }
});

test('ratios print with two decimals below ten and one above', () => {
  assert.equal(ratioText(1.13), '1.13x');
  assert.equal(ratioText(2), '2.00x');
  assert.equal(ratioText(12.46), '12.5x');
  assert.equal(ratioText(Infinity), 'all of it');
});

test('the band labels print the distance from the mid as a percentage with sensible precision', () => {
  assert.equal(percentText(mirrorStats(85_000, 85_000 + 4_930, 1, 1)!), '5.8%');
  assert.equal(percentText(mirrorStats(85_000, 85_000 - 300, 1, 1)!), '0.35%');
  assert.equal(percentText(mirrorStats(100, 110, 1, 1)!), '10.0%');
});
