import test from 'node:test';
import assert from 'node:assert/strict';
import { lsLanded, lsMessage, lsWindow, type LsHeld } from '../src/app/panes/ls-window.ts';
import type { LsSeries } from '../src/shared/long-short.ts';

const HOUR = 3_600_000, MIN = 60_000, NOW = 1_800_000_000_000, TF = HOUR;
// A day in view, ending a little after now (a live view).
const view = { t0: NOW - 24 * HOUR, t1: NOW + HOUR };

test('the first look asks for a view more on each side than the view needs', () => {
  const ask = lsWindow(null, false, 'k', view, TF, NOW)!;
  assert.ok(ask.from <= view.t0 - 1.5 * 25 * HOUR && ask.from % HOUR === 0);
  assert.equal(ask.to, NOW + TF, 'a live view is read up to now, not into the future');
});

test('zooming and panning inside what is held ask nothing, until the minute refresh', () => {
  const ask = lsWindow(null, false, 'k', view, TF, NOW)!, held: LsHeld = { ident: 'k', ...ask, at: NOW };
  const zoomedIn = { t0: NOW - 12 * HOUR, t1: NOW + HOUR }, zoomedOut = { t0: NOW - 30 * HOUR, t1: NOW + HOUR };
  assert.equal(lsWindow(held, false, 'k', zoomedIn, TF, NOW + 1_000), null);
  assert.equal(lsWindow(held, false, 'k', zoomedOut, TF, NOW + 1_000), null, 'a step out stays inside the margin');
  assert.equal(lsWindow(held, false, 'k', view, TF, NOW + 30_000), null, 'a live end moving on is not a new question');
  assert.notEqual(lsWindow(held, false, 'k', view, TF, NOW + MIN + 1), null, 'a minute on, the refresh');
});

test('a view beyond what is held or other markets ask again; a round under way holds the next back until it ends', () => {
  const ask = lsWindow(null, false, 'k', view, TF, NOW)!, held: LsHeld = { ident: 'k', ...ask, at: NOW };
  assert.notEqual(lsWindow(held, false, 'k', { t0: NOW - 200 * HOUR, t1: NOW + HOUR }, TF, NOW + 1_000), null);
  assert.notEqual(lsWindow(held, false, 'other', view, TF, NOW + 1_000), null);
  assert.equal(lsWindow(held, true, 'k', { t0: NOW - 200 * HOUR, t1: NOW + HOUR }, TF, NOW + 1_000), null, 'one round at a time');
  // A round ends by its own deadline (LS_ROUND_MS) with what came: re-asking while it waits (after 30 s, as before) threw away the venues that
  // had answered, and with two that never did, every round (2026-10-15).
  assert.equal(lsWindow(held, true, 'k', view, TF, NOW + 31_000), null, 'a slow round is not asked over');
  assert.notEqual(lsWindow(held, true, 'other', view, TF, NOW + 1_000), null, 'other markets do not wait for the old round');
});

const S = (id: string, status: LsSeries['status'], n = 1): LsSeries => ({ id, population: 'accounts', periodMs: HOUR, points: Array.from({ length: n }, (_, i) => ({ t: NOW - i * HOUR, long: 0.6 })), status });

test('a round draws each venue as it answers; a venue that never answers costs its own line, never the others', () => {
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP'];
  const answers = new Map([['binance:BTCUSDT', S('binance:BTCUSDT', 'ok')]]);
  assert.deepEqual(lsLanded(ids, [], answers, false).map(s => [s.id, s.status]), [['binance:BTCUSDT', 'ok']], 'the first answer is drawn at once');
  const over = lsLanded(ids, [], answers, true);
  assert.deepEqual(over.map(s => [s.id, s.status, s.points.length]), [['binance:BTCUSDT', 'ok', 1], ['bybit:BTCUSDT', 'failed', 0], ['okx:BTC-USDT-SWAP', 'failed', 0]],
    'at the deadline the missing venues read as failed (the popup says they could not be read), in the order of the markets');
});

test('while a round waits, and after it, what was held stays drawn: stale where its venue did not answer or failed', () => {
  const ids = ['binance:BTCUSDT', 'bybit:BTCUSDT'];
  const before = [S('binance:BTCUSDT', 'ok', 3), S('bybit:BTCUSDT', 'ok', 3)];
  assert.deepEqual(lsLanded(ids, before, new Map(), false), before, 'nothing answered yet: the lines as they were');
  const failedBybit = new Map([['binance:BTCUSDT', S('binance:BTCUSDT', 'ok', 4)], ['bybit:BTCUSDT', S('bybit:BTCUSDT', 'failed', 0)]]);
  assert.deepEqual(lsLanded(ids, before, failedBybit, true).map(s => [s.status, s.points.length]), [['ok', 4], ['stale', 3]], 'a failure does not wipe the readings held');
  assert.deepEqual(lsLanded(ids, before, new Map([['binance:BTCUSDT', S('binance:BTCUSDT', 'ok', 4)]]), true).map(s => [s.status, s.points.length]), [['ok', 4], ['stale', 3]], 'nor does no answer');
  const empty = S('bybit:BTCUSDT', 'empty', 0);
  assert.deepEqual(lsLanded(ids, before, new Map([['bybit:BTCUSDT', empty]]), false)[1], empty, 'an answer that is not a failure is taken as it is');
});

test('with no line to draw the pane says why: still reading, a venue that could not be read, or nothing for this time', () => {
  // In a page OKX answers at once that only a server can read it: the others are still being read, not empty.
  assert.equal(lsMessage([S('okx:BTC-USDT-SWAP', 'serverOnly', 0)], true), 'reading');
  assert.equal(lsMessage([S('binance:BTCUSDT', 'empty', 0), S('bybit:BTCUSDT', 'failed', 0)], false), 'failed', 'a failure is not "no readings"');
  assert.equal(lsMessage([S('binance:BTCUSDT', 'empty', 0), S('okx:BTC-USDT-SWAP', 'serverOnly', 0)], false), 'none');
  assert.equal(lsMessage([S('binance:BTCUSDT', 'stale', 3)], false), 'failed', 'readings held for another time, the update for this one failed');
  assert.equal(lsMessage([S('binance:BTCUSDT', 'ok', 3)], false), 'none', 'readings for another time, none for this one');
});

test('a view shorter than a month asks a window under 30 days, so the venues are read as finely as the candles', () => {
  const DAY = 24 * HOUR;
  for (const days of [12, 25]) {
    const wide = { t0: NOW - days * DAY, t1: NOW + HOUR }, ask = lsWindow(null, false, 'k', wide, TF, NOW)!;
    assert.ok(ask.to - ask.from < 30 * DAY, `${days} days in view: a window of ${(ask.to - ask.from) / DAY} days (from 30 the cache reads daily)`);
    assert.ok(ask.from <= wide.t0, 'the view itself is always asked');
    const held: LsHeld = { ident: 'k', ...ask, at: NOW };
    assert.equal(lsWindow(held, false, 'k', wide, TF, NOW + 1_000), null, 'what is held is enough for it: asked again only with the minute refresh');
  }
  const month = { t0: NOW - 40 * DAY, t1: NOW + HOUR }, ask = lsWindow(null, false, 'k', month, TF, NOW)!;
  assert.ok(ask.from <= month.t0 && ask.to >= NOW, 'a month-long view is read whole (in daily readings)');
});

test('up to 29 days in view, at any timeframe finer than daily, the window and its rounding stay under 30 days', () => {
  const DAY = 24 * HOUR;
  for (const tf of [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 4 * HOUR]) for (const days of [1, 7, 19, 20, 21, 28, 29]) {
    const live = { t0: NOW - days * DAY, t1: NOW + tf }, back = { t0: NOW - 40 * DAY - days * DAY, t1: NOW - 40 * DAY };
    for (const v of [live, back]) {
      const ask = lsWindow(null, false, 'k', v, tf, NOW)!;
      assert.ok(ask.to - ask.from < 30 * DAY && ask.from <= v.t0, `${days} days on ${tf / MIN}-minute candles: ${(ask.to - ask.from) / HOUR} hours`);
    }
  }
});
