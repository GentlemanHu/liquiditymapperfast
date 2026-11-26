import test from 'node:test';
import assert from 'node:assert/strict';
import { CANDLE_GROWTH_MS, LOOK_GAP_MS, alertEnded, alertLive, linePrice, reached, type LiveCandle, type PriceLook } from '../src/app/draw/alerts.ts';
import { newDrawing, type Drawing } from '../src/app/draw/model.ts';

const T = Date.UTC(2026, 10, 26, 12), M = 60_000, H = 3_600_000;
const bell = (d: Drawing, extra: Partial<Drawing> = {}): Drawing => ({ ...d, alert: true, ...extra });
const level = (p: number, extra: Partial<Drawing> = {}): Drawing => bell(newDrawing('level', [{ t: T - H, p }], T), extra);
const zone = (lo: number, hi: number, t0 = T - H, t1 = T + H, extra: Partial<Drawing> = {}): Drawing => bell(newDrawing('zone', [{ t: t0, p: lo }, { t: t1, p: hi }], T), extra);
const look = (price: number, at: number, candle: LiveCandle | null = null, market = 'binance:BTCUSDT'): PriceLook => ({ market, price, at, candle });
const ids = (r: { id: string }[]): string[] => r.map(x => x.id);

test('a level goes off when the price moves through it or touches it, never while it stays on one side or starts on it', () => {
  const d = level(100);
  assert.deepEqual(ids(reached(look(99, T), look(101, T + 1_000), [d])), [d.id], 'up through it');
  assert.deepEqual(ids(reached(look(101, T), look(99, T + 1_000), [d])), [d.id], 'down through it');
  assert.deepEqual(ids(reached(look(99, T), look(100, T + 1_000), [d])), [d.id], 'up to it');
  assert.deepEqual(reached(look(98, T), look(99.9, T + 1_000), [d]), [], 'still below');
  assert.deepEqual(reached(look(100, T), look(101, T + 1_000), [d]), [], 'a price at the level before is on neither side');
  assert.deepEqual(reached(null, look(101, T), [d]), [], 'the first price is no move');
  assert.equal(reached(look(99, T), look(101, T + 1_000), [d])[0]!.price, 100, 'it names the level');
  assert.deepEqual(reached(look(99, T), look(101, T + 1_000), [{ ...d, alert: false }, { ...d, hidden: true }]), [], 'no bell, or hidden: nothing');
});

test('two readings of different markets, too far apart or out of order are never compared', () => {
  const d = level(100);
  assert.deepEqual(reached(look(99, T, null, 'binance:BTCUSDT'), look(101, T + 1_000, null, 'bybit:BTCUSDT'), [d]), [], 'a spot price then a perpetual\'s');
  assert.deepEqual(reached(look(99, T), look(101, T + LOOK_GAP_MS + 1), [d]), [], 'the feed or the tab was away');
  assert.deepEqual(ids(reached(look(99, T), look(101, T + LOOK_GAP_MS), [d])), [d.id], 'a minute apart still counts');
  assert.deepEqual(reached(look(99, T + 1_000), look(101, T), [d]), [], 'a clock that went back');
  assert.deepEqual(reached(look(0, T), look(101, T + 1_000), [d]), [], 'no price before');
});

test('a wick between two readings counts only as a high or low of the same live candle that grew between them', () => {
  const d = level(100);
  const c = (high: number, low: number, key = 'm|1m|1', before = 'b0'): LiveCandle => ({ key, high, low, before });
  assert.deepEqual(ids(reached(look(99, T, c(99.5, 98)), look(99.2, T + 1_000, c(100.4, 98)), [d])), [d.id], 'the high grew through the level between two prices under it');
  assert.deepEqual(reached(look(99, T, c(101, 98)), look(99.2, T + 1_000, c(101, 98)), [d]), [], 'a high from before the bell was judged (armed inside the candle\'s range) is not a move');
  assert.deepEqual(reached(look(99, T, c(99.5, 98)), look(99.2, T + 1_000, c(100.4, 98, 'm|5m|1')), [d]), [], 'another timeframe\'s candle');
  assert.deepEqual(reached(look(99, T, c(99.5, 98)), look(99.2, T + 1_000, c(100.4, 98, 'm|1m|1', 'b1')), [d]), [], 'the candle before it changed: a reloaded history');
  assert.deepEqual(reached(look(99, T, c(99.5, 98)), look(99.2, T + CANDLE_GROWTH_MS + 1, c(100.4, 98)), [d]), [], 'too long between the readings');
  const low = level(97);
  assert.deepEqual(ids(reached(look(98, T, c(99, 97.5)), look(98.1, T + 1_000, c(99, 96.9)), [low])), [low.id], 'the low grew down through a level');
});

test('a zone goes off when the price enters it from outside, from either side, while the zone exists', () => {
  const z = zone(100, 110);
  assert.deepEqual(reached(look(99, T), look(100.5, T + 1_000), [z]).map(r => [r.id, r.price]), [[z.id, 100]], 'from below, at its bottom');
  assert.deepEqual(reached(look(115, T), look(109, T + 1_000), [z]).map(r => [r.id, r.price]), [[z.id, 110]], 'from above, at its top');
  assert.deepEqual(ids(reached(look(99, T), look(120, T + 1_000), [z])), [z.id], 'through it in one move');
  assert.deepEqual(reached(look(105, T), look(108, T + 1_000), [z]), [], 'moving inside it');
  assert.deepEqual(reached(look(105, T), look(112, T + 1_000), [z]), [], 'leaving it');
  const later = zone(100, 110, T + M, T + H);
  assert.deepEqual(reached(look(99, T), look(101, T + 1_000), [later]), [], 'a zone that starts later');
  const ended = zone(100, 110, T - 2 * H, T - H);
  assert.deepEqual(reached(look(99, T), look(101, T + 1_000), [ended]), [], 'a zone that ended');
  assert.deepEqual(ids(reached(look(99, T), look(101, T + 1_000), [{ ...ended, extendRight: true }])), [ended.id], 'one that runs on to the right does not end');
});

test('a trend line goes off when the price changes side of the line\'s price, a flat price under a falling line included', () => {
  const falling = bell(newDrawing('trend', [{ t: T - M, p: 101 }, { t: T + M, p: 99 }], T));
  assert.equal(linePrice(falling, T), 100);
  const step = M / 2; // the line falls 0.5 a step, two readings well within a minute
  assert.deepEqual(ids(reached(look(99.5, T), look(99.5, T + step), [falling])), [falling.id], 'the price held at 99.5 as the line fell to it');
  assert.deepEqual(reached(look(98, T), look(98, T + step), [falling]), [], 'still under the line (it is at 99.5 by then)');
  const backwards = bell(newDrawing('trend', [{ t: T + M, p: 99 }, { t: T - M, p: 101 }], T));
  assert.deepEqual(ids(reached(look(99.5, T), look(99.5, T + step), [backwards])), [backwards.id], 'a line placed right to left reads the same');
  const ended = bell(newDrawing('trend', [{ t: T - 3 * H, p: 110 }, { t: T - H, p: 100 }], T));
  assert.equal(alertLive(ended, T), false);
  assert.deepEqual(reached(look(99, T), look(101, T + 1_000), [ended]), [], 'a segment that ended');
  assert.equal(alertLive({ ...ended, extendRight: true }, T), true, 'run on to the right, it goes on');
  const upright = bell(newDrawing('trend', [{ t: T, p: 90 }, { t: T, p: 110 }], T));
  assert.equal(Number.isNaN(linePrice(upright, T)), true); assert.equal(alertLive(upright, T), false, 'a line with no length in time has no price');
});

test('a bell that can never go off again is told apart: a zone or a line that ended without running on; a level never ends', () => {
  assert.equal(alertEnded(zone(100, 110, T - 2 * H, T - H), T), true);
  assert.equal(alertEnded(zone(100, 110, T - 2 * H, T - H, { extendRight: true }), T), false);
  assert.equal(alertEnded(zone(100, 110), T), false);
  assert.equal(alertEnded(level(100), T + 1_000 * H), false);
  const ray = level(100, { extendLeft: false });
  assert.equal(alertLive(ray, T - 2 * H), false, 'a ray begins at its point');
  assert.equal(alertLive(ray, T), true);
  assert.equal(alertEnded(bell(newDrawing('vline', [{ t: T, p: 1 }], T)), T), false, 'a kind without a bell');
});
