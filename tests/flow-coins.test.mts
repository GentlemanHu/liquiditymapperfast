import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowMinutes, FlowSeries } from '../src/shared/flow.ts';
import { windowCoinDelta } from '../src/app/sound/alerts.ts';

const close = (a: number, b: number, msg?: string): void => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${msg ?? ''} ${a} vs ${b}`);

test('a series kept in coins: each second over its own price, a second without one over the last price before it', () => {
  const s = new FlowSeries();
  s.keepCoins(true);
  s.set(100, 1000, 400, 100);   // +6 coins net, 14 gross
  s.set(101, 0, 0, 0);
  s.set(102, 300, 900, 0);      // no price: the last one (100) holds: -6 net, 12 gross
  s.set(103, 2000, 0, 200);     // +10 net, 10 gross
  const c = s.coins!;
  close(c.delta(100, 103), 6 - 6 + 10); close(c.gross(100, 103), 14 + 12 + 10);
  close(c.delta(103, 103), 10); close(s.delta(100, 103), 600 - 600 + 2000, 'the dollars stay the dollars');
});

test('a second set again is worked out again from its new totals and price, and later running sums follow', () => {
  const s = new FlowSeries();
  s.keepCoins(true);
  s.set(10, 100, 0, 100); s.set(11, 100, 0, 100); s.set(12, 100, 0, 100);
  s.set(11, 300, 100, 200);    // the open second grew and its price moved: +1 net, 2 gross
  const c = s.coins!;
  close(c.delta(10, 12), 1 + 1 + 1); close(c.gross(10, 12), 1 + 2 + 1); close(c.cumDelta(12) - c.cumDelta(10), 2);
  s.set(11, 300, 100, 100);    // the same dollars at another price: only the coins change
  close(c.delta(11, 11), 2); close(s.delta(11, 11), 200);
});

test('coins kept from a loaded history equal coins kept second by second', () => {
  const buy = [500, 0, 250, 1000, 0, 0, 90], sell = [100, 0, 750, 0, 0, 30, 0], px = [100, 0, 125, 0, 0, 0, 90];
  const live = new FlowSeries(); live.keepCoins(true);
  buy.forEach((b, i) => live.set(1000 + i, b, sell[i]!, px[i]!));
  const loaded = new FlowSeries(); loaded.load(1000, buy, sell, px); loaded.keepCoins(true);
  const reloaded = new FlowSeries(); reloaded.keepCoins(true); reloaded.load(1000, buy, sell, px);
  for (let a = 1000; a <= 1006; a++) for (let b = a; b <= 1006; b++) {
    close(loaded.coins!.delta(a, b), live.coins!.delta(a, b), `delta ${a}-${b}`);
    close(reloaded.coins!.gross(a, b), live.coins!.gross(a, b), `gross ${a}-${b}`);
  }
  loaded.keepCoins(false);
  assert.equal(loaded.coins, undefined);
});

test('a price revised on a second is the price of the unpriced seconds after it: theirs follow (review 1)', () => {
  const s = new FlowSeries(); s.keepCoins(true);
  s.set(10, 100, 0, 100); s.set(11, 100, 0, 0); s.set(12, 50, 0, 0);
  close(s.coins!.delta(11, 12), 1.5);
  s.set(10, 100, 0, 200);   // the same dollars, another price
  close(s.coins!.delta(10, 10), 0.5); close(s.coins!.delta(11, 12), 0.75, 'the seconds without a price of their own follow');
  const again = new FlowSeries(); again.load(10, [100, 100, 50], [0, 0, 0], [200, 0, 0]); again.keepCoins(true);
  for (let a = 10; a <= 12; a++) close(again.coins!.delta(a, 12), s.coins!.delta(a, 12), `from ${a}`);
});

test('seconds as they come and a series worked out again agree to the bit on a price a float32 rounds (review 1)', () => {
  const live = new FlowSeries(); live.keepCoins(true);
  live.set(500, 1_005_000.09, 0, 100_000.01);
  const rebuilt = new FlowSeries(); rebuilt.set(500, 1_005_000.09, 0, 100_000.01); rebuilt.keepCoins(true);
  assert.equal(live.coins!.delta(500, 500), rebuilt.coins!.delta(500, 500));
});

test('a history longer than the ring keeps the price before its first second held, within reach (review 1)', () => {
  const n = 131_072 + 1, buy = new Float64Array(n), sell = new Float64Array(n), px = new Float32Array(n);
  buy[0] = 100; px[0] = 100;          // skipped, but its price stands for the next second
  buy[1] = 100;                       // no price of its own
  buy[2] = 200; px[2] = 200;
  const s = new FlowSeries(); s.load(0, buy, sell, px); s.keepCoins(true);
  close(s.coins!.delta(1, 1), 1, 'over the skipped second\'s price, not the next one');
  close(s.coins!.delta(2, 2), 1);
});

test('a price that rolls off the ring stays the price of the unpriced seconds after it: a twin worked out again agrees (review 2)', () => {
  const s = new FlowSeries(); s.keepCoins(true);
  s.set(0, 100, 0, 100);       // priced
  s.set(1, 100, 0, 0);         // no price: 100's, 1 coin
  s.set(131_072, 1, 0, 1);     // the ring moves on: second 0 rolls off, second 1 stays
  const live = s.coins!.delta(1, 1);
  s.keepCoins(false); s.keepCoins(true);
  close(live, 1); close(s.coins!.delta(1, 1), live);
});

test('coins taken without a twin (an alert) price a second by the twin\'s rule, the price the ring let go included (review 3)', () => {
  const s = new FlowSeries();
  s.set(0, 100, 0, 100);       // priced
  s.set(1, 200, 0, 0);         // no price: 100's, 2 coins
  s.set(131_072, 1, 0, 1);     // second 0 rolls off
  assert.equal(s.coinPriceAt(1), 100, 'the price kept from the second that rolled off');
  close(windowCoinDelta(s, 1, 1), 2);
  s.keepCoins(true);
  close(s.coins!.delta(1, 1), windowCoinDelta(s, 1, 1), 'the same as the twin worked out then');
  assert.equal(s.coinPriceAt(131_071), 0, 'a second with no price within reach (two hours back): none');
});

test('the coins stay one object across a load, and are let go with keepCoins(false) (review 1)', () => {
  const s = new FlowSeries(); s.keepCoins(true);
  const twin = s.coins!;
  s.load(0, [100, 100], [0, 0], [100, 50]);
  assert.equal(s.coins, twin); close(twin.delta(0, 1), 3);
  s.keepCoins(false); assert.equal(s.coins, undefined);
});

test('minutes in coins: each minute over its own last price or the last before it; a minute before any price has none (as the seconds)', () => {
  const m = new FlowMinutes({ id: 'x', t0: 0, buy: Float32Array.from([200, 300, 0, 400]), sell: Float32Array.from([100, 0, 0, 100]), px: Float32Array.from([0, 100, 0, 50]),
    lo: Float32Array.from([0, 0, 0, -100]), hi: Float32Array.from([100, 300, 0, 300]) });
  const c = m.coins();
  close(c.deltaAt(0), 0); close(c.deltaAt(1), 3); close(c.deltaAt(2), 3); close(c.deltaAt(3), 3 + 6);
  close(c.grossAt(3), 0 + 3 + 0 + 10); close(c.lowAt(3), 3 - 2); close(c.highAt(3), 3 + 6);
  assert.equal(m.coins(), c, 'made once');
  m.dropCoins(); assert.notEqual(m.coins(), c, 'let go, then made again');
  close(m.deltaAt(3), 100 + 300 + 300, 'the dollars stay the dollars');
});
