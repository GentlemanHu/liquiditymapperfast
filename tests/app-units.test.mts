import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, coinText, coinsAt, figure, inCoins, inUnits, readUnits, setUnits, signedAmount, signedFigure, unitFloor, unitHead, unitName } from '../src/app/units.ts';

const intl = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });

test('coin figures write what Intl writes: random amounts from a trillionth to a thousand trillion, both signs', () => {
  let seed = 11;
  const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300_000; i++) {
    const v = 10 ** (-12 + rand() * 27) * (rand() < 0.2 ? -1 : 1);
    assert.equal(coinText(v), intl.format(v), String(v));
  }
});

test('coin figures at the edges: powers of ten, the step into the next unit, ties, Float32 sums', () => {
  const edges = [1, 10, 100, 1000, 1e4, 1e5, 1e6, 1e9, 1e12, 0.1, 0.01, 0.001, 1e-6, 999, 999.4, 999.5, 999.6, 9.995, 9.994, 99.95, 0.0125, 0.35, 5.514,
    13.25, 13.35, 551.4, 5514, 1_234_567, 999_499, 999_500, 999_999, 1.005, 2.675, 0.1 + 0.2, Math.fround(0.3), Math.fround(1234.567), Math.fround(98.76543), 123_456.7, 1e15 - 1];
  for (const v of edges) for (const s of [1, -1]) assert.equal(coinText(v * s), intl.format(v * s), String(v * s));
  for (let k = 1; k < 20_000; k++) { const v = k * 0.005; assert.equal(coinText(v), intl.format(v), String(v)); }
  assert.equal(coinText(0), '0'); assert.equal(coinText(Number.NaN), '–'); assert.equal(coinText(Infinity), '–');
});

test('a fraction of a coin is never written 0', () => {
  for (const v of [0.4, 0.04, 0.000004, 0.000000004]) assert.notEqual(coinText(v), '0');
});

test('the page units: dollars as the page always wrote them, coins with the ticker', () => {
  setUnits('usd');
  assert.equal(inCoins(), false); assert.equal(unitName(), 'USD');
  assert.equal(figure(1_234_567), '1.2M'); assert.equal(figure(999.4), '999'); assert.equal(amount(1_234_567), '$1.2M'); assert.equal(amount(-2500), '$-2.5K', 'as `$${usd(x)}` wrote it'); assert.equal(amount(Number.NaN), '$–');
  assert.equal(signedAmount(12_300_000), '+$12.3M'); assert.equal(signedAmount(-4_100_000), '−$4.1M'); assert.equal(signedAmount(0), '$0');
  assert.equal(signedFigure(1_200_000), '+1.2M'); assert.equal(signedFigure(-4_100_000), '−4.1M'); assert.equal(signedFigure(0), '0');
  assert.equal(inUnits(9000, 90_000), 9000); assert.equal(unitFloor(90_000), 1);
  setUnits('coin');
  assert.equal(inCoins(), true); assert.equal(unitName(), 'BTC');
  assert.equal(figure(13.25), intl.format(13.25)); assert.equal(figure(0.35), '0.35'); assert.equal(figure(5514), '5.51K');
  assert.equal(amount(0.35), '0.35 BTC'); assert.equal(amount(-0.35), '-0.35 BTC');
  assert.equal(signedAmount(13.2), '+13.2 BTC'); assert.equal(signedAmount(-0.35), '−0.35 BTC'); assert.equal(signedAmount(0), '0 BTC');
  assert.equal(signedFigure(13.2), '+13.2'); assert.equal(signedFigure(-0.0125), '−0.0125');
  assert.equal(inUnits(9000, 90_000), 0.1); assert.equal(unitFloor(100_000), 1e-5);
  assert.ok(Number.isNaN(coinsAt(100, 0)));
  setUnits('usd');
});

test('a heading that names the units is written whole while it fits, else as the units alone (a long ticker)', () => {
  const measure = (text: string): number => text.length * 6;
  setUnits('coin');
  assert.equal(unitHead('LEVEL BTC', 54, measure), 'LEVEL BTC', 'nine letters in 54 px: whole');
  assert.equal(unitHead('LEVEL BTC', 53, measure), 'BTC', 'a pixel short: the ticker alone');
  setUnits('usd');
});

test('a saved setting reads as dollars unless it says coins', () => {
  assert.equal(readUnits('coin'), 'coin');
  for (const raw of ['usd', 'COIN', undefined, null, 1, {}]) assert.equal(readUnits(raw), 'usd');
});
