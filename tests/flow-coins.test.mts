import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowMinutes, FlowSeries } from '../src/shared/flow.ts';

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

test('minutes in coins: each minute over its own last price, minutes before the first price over that first price', () => {
  const m = new FlowMinutes({ id: 'x', t0: 0, buy: Float32Array.from([200, 300, 0, 400]), sell: Float32Array.from([100, 0, 0, 100]), px: Float32Array.from([0, 100, 0, 50]),
    lo: Float32Array.from([0, 0, 0, -100]), hi: Float32Array.from([100, 300, 0, 300]) });
  const c = m.coins();
  close(c.deltaAt(0), 1); close(c.deltaAt(1), 1 + 3); close(c.deltaAt(2), 4); close(c.deltaAt(3), 4 + 6);
  close(c.grossAt(3), 3 + 3 + 0 + 10); close(c.lowAt(3), 4 - 2); close(c.highAt(3), 4 + 6);
  assert.equal(m.coins(), c, 'made once');
  close(m.deltaAt(3), 100 + 300 + 300, 'the dollars stay the dollars');
});
