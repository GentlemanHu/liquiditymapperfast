import test from 'node:test';
import assert from 'node:assert/strict';
import { lsFollowDelay, lsLanded, lsMessage, lsPeriods, lsReach, lsWindow, type LsHeld } from '../src/app/panes/ls-window.ts';
import { LS_VIEW_READINGS, LS_WINDOW_READINGS, lsPeriodOf, type LsSeries } from '../src/shared/long-short.ts';

const HOUR = 3_600_000, MIN = 60_000, DAY = 24 * HOUR, NOW = 1_800_000_000_000, TF = HOUR;
// A day in view, ending a little after now (a live view).
const view = { t0: NOW - 24 * HOUR, t1: NOW + HOUR };
const IDS = ['binance:BTCUSDT', 'bybit:BTCUSDT', 'okx:BTC-USDT-SWAP', 'bitget:BTCUSDT', 'gateio:BTC_USDT'];
/** What the pane holds after asking `v`: the window and each market's period for that view. */
const heldOf = (v: { t0: number; t1: number }, tf: number, ids: readonly string[] = IDS, now = NOW): LsHeld => {
  const periods = lsPeriods(ids, tf, v);
  return { ident: 'k', ...lsWindow(null, false, 'k', v, tf, now, periods)!, at: now, periods };
};
const name = (ms: number): string => ms >= DAY ? `${ms / DAY}d` : ms >= HOUR ? `${ms / HOUR}h` : `${ms / MIN}m`;

test('the first look asks for more on each side than the view needs', () => {
  const ask = lsWindow(null, false, 'k', view, TF, NOW, lsPeriods(IDS, TF, view))!;
  assert.ok(ask.from <= view.t0 - 0.75 * 25 * HOUR && ask.from % HOUR === 0);
  assert.equal(ask.to, NOW + TF, 'a live view is read up to now, not into the future');
});

test('zooming and panning inside what is held ask nothing, until the minute refresh', () => {
  const held = heldOf(view, TF);
  const zoomedIn = { t0: NOW - 12 * HOUR, t1: NOW + HOUR }, zoomedOut = { t0: NOW - 27 * HOUR, t1: NOW + HOUR };
  for (const v of [zoomedIn, zoomedOut]) assert.equal(lsWindow(held, false, 'k', v, TF, NOW + 1_000, lsPeriods(IDS, TF, v)), null, 'inside the margin, every venue hourly either way');
  assert.equal(lsWindow(held, false, 'k', view, TF, NOW + 30_000, lsPeriods(IDS, TF, view)), null, 'a live end moving on is not a new question');
  assert.notEqual(lsWindow(held, false, 'k', view, TF, NOW + MIN + 1, lsPeriods(IDS, TF, view)), null, 'a minute on, the refresh');
});

test('a line\'s period follows the zoom alone: an hourly chart reads every venue hourly up to 104 days in view, wherever the view stands', () => {
  // Karl, 2026-11-23: the pane opened fine and turned coarse a little zoom or move later. The window asked around the view chose the period
  // (daily from a 30-day window): a 718-hour view asked 719 hours (hourly), a 0.14 % zoom out or a 2-hour pan asked 720 (daily), every venue at once.
  for (const hours of [718, 719, 720, 744, 1_104, 2_500]) {
    const end = NOW + 2 * HOUR, v = { t0: end - hours * HOUR, t1: end };
    for (const shift of [0, -2 * HOUR, -10 * MIN, -3 * DAY, -40 * DAY, -400 * DAY]) {
      const moved = { t0: v.t0 + shift, t1: v.t1 + shift }, periods = lsPeriods(IDS, TF, moved);
      assert.deepEqual([...periods.values()].map(name), ['1h', '1h', '1h', '1h', '1h'], `${hours} hours in view, moved ${shift / HOUR} h`);
      const ask = lsWindow(null, false, 'k', moved, TF, NOW, periods)!;
      assert.ok(ask.from <= moved.t0 - hours * HOUR / 2 && ask.to >= Math.min(moved.t1, NOW), 'the view and half a view before it are asked');
      assert.ok(ask.to - ask.from <= LS_WINDOW_READINGS * HOUR, 'within what one window is read in');
    }
  }
  // Past 2,500 hourly readings in view each venue takes its next period that keeps to them (OKX has none between an hour and a day).
  const wide = lsPeriods(IDS, TF, { t0: NOW - 2_501 * HOUR, t1: NOW });
  assert.deepEqual([...wide.values()].map(name), ['2h', '4h', '1d', '2h', '4h']);
});

test('at every timeframe and zoom the readings in view keep to LS_VIEW_READINGS where the venue has a period for it, and the window to LS_WINDOW_READINGS', () => {
  for (const tf of [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 4 * HOUR, DAY]) for (const days of [0.1, 1, 4.6, 14.6, 29, 30, 31, 46, 90, 104, 105, 200, 400, 2_000, 8_000]) {
    const v = { t0: NOW - days * DAY, t1: NOW + tf }, periods = lsPeriods(IDS, tf, v), ask = lsWindow(null, false, 'k', v, tf, NOW, periods)!;
    for (const [id, p] of periods) {
      const venue = id.slice(0, id.indexOf(':'));
      assert.ok(p >= lsPeriodOf(venue, tf)!, `${venue} never finer than its period for the candle`);
      assert.ok((v.t1 - v.t0) / p <= LS_VIEW_READINGS || p === DAY, `${venue}: ${days} days on ${name(tf)} in ${name(p)}`);
      assert.ok((ask.to - ask.from) / p <= LS_WINDOW_READINGS, `${venue}: the window of ${days} days on ${name(tf)} in ${name(p)}`);
    }
    if (days < 8_000) assert.ok(ask.from <= v.t0, `${days} days on ${name(tf)}: the view itself is always asked`);
  }
});

test('a zoom across a period\'s edge asks at once, back in and out alike, so a pan never changes a line\'s period', () => {
  // A 120-day view is read every two to 24 hours; back to 90 days every venue is hourly again: the held coarse steps once stayed drawn until
  // the minute refresh (2026-10-23).
  const wideHeld = heldOf({ t0: NOW - 120 * DAY, t1: NOW + 2 * DAY }, TF), back = { t0: NOW - 90 * DAY, t1: NOW + 2 * DAY };
  assert.ok(wideHeld.from <= back.t0 - 45 * DAY && wideHeld.to >= NOW, 'the wide window covers the narrower view');
  assert.ok(lsWindow(wideHeld, false, 'k', back, TF, NOW + 1_000, lsPeriods(IDS, TF, back)), 'asked at once');
  assert.equal(lsWindow(wideHeld, false, 'k', back, TF, NOW + 1_000), null, 'without the periods, coverage alone');
  assert.equal(lsWindow(wideHeld, true, 'k', back, TF, NOW + 1_000, lsPeriods(IDS, TF, back)), null, 'a round under way is waited for: the view is looked at again when it lands');
  // On five-minute candles a ten-day view reads every venue every 15 minutes (OKX hourly); five days are read every five minutes.
  const daysHeld = heldOf({ t0: NOW - 10 * DAY, t1: NOW + HOUR }, 5 * MIN), five = { t0: NOW - 5 * DAY, t1: NOW + HOUR };
  assert.deepEqual([...daysHeld.periods!.values()].map(name), ['15m', '15m', '1h', '15m', '15m']);
  assert.notEqual(lsWindow(daysHeld, false, 'k', five, 5 * MIN, NOW + 1_000, lsPeriods(['bitget:BTCUSDT'], 5 * MIN, five)), null, 'Bitget alone finer is enough');
  // Eight days are five-minutely (2,304 readings), nine every 15 minutes: zoomed out across that edge, asked at once although what is held
  // covers the view (kept five-minutely, the next pan out of what is held turned the line 15-minutely: review 2026-11-23).
  const fineHeld = heldOf({ t0: NOW - 8 * DAY, t1: NOW + HOUR }, 5 * MIN), out = { t0: NOW - 9 * DAY, t1: NOW + HOUR }, outPeriods = lsPeriods(IDS, 5 * MIN, out);
  assert.deepEqual([[...fineHeld.periods!.values()].map(name), [...outPeriods.values()].map(name)], [['5m', '5m', '5m', '5m', '5m'], ['15m', '15m', '1h', '15m', '15m']]);
  assert.notEqual(lsWindow(fineHeld, false, 'k', out, 5 * MIN, NOW + 1_000, outPeriods), null, 'the coarser period asked at the zoom');
  const outHeld = heldOf(out, 5 * MIN), panned = { t0: out.t0 - 2 * DAY, t1: out.t1 - 2 * DAY };
  assert.deepEqual([...lsPeriods(IDS, 5 * MIN, panned).values()], [...outHeld.periods!.values()], 'the pan after it asks the same periods');
});

test('right after a round, the same view asks nothing, nor does a live view a minute short of the refresh', () => {
  for (const [v, tf] of [[{ t0: NOW - 20 * DAY, t1: NOW + 2 * DAY }, TF], [{ t0: NOW - 10 * HOUR, t1: NOW + HOUR }, 5 * MIN], [view, TF], [{ t0: NOW - 200 * DAY, t1: NOW + 2 * DAY }, 5 * MIN]] as const) {
    const held = heldOf(v, tf), VENUES = lsPeriods(IDS, tf, v);
    assert.equal(lsWindow(held, false, 'k', v, tf, NOW + 1_000, VENUES), null, 'the window just asked is the one this view asks');
    // The live window's end moves on with now: its readings can only stay as they are or turn coarser, never a reason to ask.
    const crept = { t0: v.t0 + 30_000, t1: v.t1 + 30_000 };
    assert.equal(lsWindow(held, false, 'k', crept, tf, NOW + 30_000, VENUES), null, 'a live view half a minute on');
  }
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

test('a venue still being read says "reading", never "none", and keeps the lines drawn while it is read', () => {
  const pendingEmpty: LsSeries = { ...S('bybit:BTCUSDT', 'empty', 0), pending: true };
  assert.equal(lsMessage([pendingEmpty], false), 'reading', 'the round is over, the venue is still being read');
  assert.equal(lsMessage([{ ...S('bybit:BTCUSDT', 'ok', 2), pending: true }], false), 'reading', 'readings held for another time while the venue is read: still reading, never "no readings"');
  const before = [S('bybit:BTCUSDT', 'ok', 3)];
  const kept = lsLanded(['bybit:BTCUSDT'], before, new Map([['bybit:BTCUSDT', pendingEmpty]]), false)[0]!;
  assert.deepEqual([kept.points.length, kept.status, kept.pending], [3, 'ok', true], 'nothing held for this window yet: the lines drawn stay');
  // S(…, n) has readings at NOW, NOW - 1 h, …: one reading reaches as far as three.
  const partial: LsSeries = { ...S('bybit:BTCUSDT', 'ok', 1), pending: true };
  assert.equal(lsLanded(['bybit:BTCUSDT'], before, new Map([['bybit:BTCUSDT', partial]]), true)[0]!.points.length, 3, 'as far as the line with fewer readings (its older ones still being read): the fuller line stays');
  const further: LsSeries = { ...partial, points: [{ t: NOW + HOUR, long: 0.6 }] };
  assert.equal(lsLanded(['bybit:BTCUSDT'], before, new Map([['bybit:BTCUSDT', further]]), true)[0], further, 'one reaching further is drawn as answered');
  const older: LsSeries = { ...partial, points: [{ t: NOW - 5 * HOUR, long: 0.6 }] };
  const keptLine = lsLanded(['bybit:BTCUSDT'], [{ ...before[0]!, points: [...before[0]!.points].reverse() }], new Map([['bybit:BTCUSDT', older]]), false)[0]!;
  assert.deepEqual([keptLine.points.length, keptLine.pending], [3, true], 'an older stretch while the rest is read: the line drawn keeps its newest hours');
});

test('a round that ended with a venue pending is asked again when it is due, not a minute later', () => {
  const VENUES = lsPeriods(IDS, TF, view), held: LsHeld = { ...heldOf(view, TF), soon: NOW + 5_000 };
  assert.equal(lsWindow(held, false, 'k', view, TF, NOW + 4_000, VENUES), null, 'not yet');
  assert.notEqual(lsWindow(held, false, 'k', view, TF, NOW + 5_000, VENUES), null, 'due');
  assert.equal(lsWindow(held, true, 'k', view, TF, NOW + 5_000, VENUES), null, 'never over a round under way');
});

test('a venue still being read is asked again a little later each time, up to every 8 s', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(lsFollowDelay), [2_000, 4_000, 8_000, 8_000, 8_000]);
});

test('a line kept while its venue was read turns stale, no longer pending, when the round ends without an answer or with a failure', () => {
  // Found in review: the copy kept `pending`, and a blank pane said "Reading…" for a venue nothing was reading any more.
  const keptLine: LsSeries = { ...S('bybit:BTCUSDT', 'ok', 3), pending: true };
  for (const answers of [new Map<string, LsSeries>(), new Map([['bybit:BTCUSDT', S('bybit:BTCUSDT', 'failed', 0)]])]) {
    const s = lsLanded(['bybit:BTCUSDT'], [keptLine], answers, true)[0]!;
    assert.deepEqual([s.status, 'pending' in s, s.points.length], ['stale', false, 3]);
    assert.equal(lsMessage([s], false), 'failed');
  }
});

test('lines of different periods compare by how far they are drawn: a daily reading stands for its day', () => {
  const DAY = 24 * HOUR, today = Math.floor(NOW / DAY) * DAY;
  const hourly: LsSeries = { id: 'binance:BTCUSDT', population: 'accounts', periodMs: HOUR, status: 'ok', points: [{ t: NOW - HOUR, long: 0.6 }, { t: NOW, long: 0.61 }] };
  const daily: LsSeries = { id: 'binance:BTCUSDT', population: 'accounts', periodMs: DAY, status: 'ok', pending: true, points: [{ t: today - DAY, long: 0.6 }, { t: today, long: 0.62 }] };
  assert.equal(lsReach(daily), today + DAY);
  assert.equal(lsLanded(['binance:BTCUSDT'], [hourly], new Map([['binance:BTCUSDT', daily]]), false)[0], daily, 'zoomed out to days: the daily line, though its newest reading is stamped at midnight');
  const oldHourly: LsSeries = { ...hourly, pending: true, points: [{ t: NOW - 30 * HOUR, long: 0.6 }] };
  assert.equal(lsLanded(['binance:BTCUSDT'], [{ ...daily, pending: undefined }], new Map([['binance:BTCUSDT', oldHourly]]), false, { view })[0]!.periodMs, DAY, 'zoomed in, the finer series holds only an old stretch out of view: the daily line stays while it is read');
});

test('zoomed back in, a finer line takes the coarser one\'s place as soon as it has a step in view, though the coarser one reaches further', () => {
  // The daily step of today reaches midnight tonight, past the newest hourly reading: compared by how far they reach, the daily line stayed
  // drawn over a pending hourly answer of a whole day, and stale over it when the round then failed (2026-11-23).
  const today = Math.floor(NOW / DAY) * DAY;
  const daily: LsSeries = { id: 'binance:BTCUSDT', population: 'accounts', periodMs: DAY, status: 'ok', points: [{ t: today - DAY, long: 0.6 }, { t: today, long: 0.62 }] };
  const hours: LsSeries = { id: 'binance:BTCUSDT', population: 'accounts', periodMs: HOUR, status: 'ok', pending: true, points: Array.from({ length: 24 }, (_, i) => ({ t: NOW - (23 - i) * HOUR, long: 0.6 })) };
  assert.ok(lsReach(daily) > lsReach(hours));
  assert.equal(lsLanded(['binance:BTCUSDT'], [daily], new Map([['binance:BTCUSDT', hours]]), false, { view })[0], hours, 'pending, in view: drawn');
  const failed = lsLanded(['binance:BTCUSDT'], [hours], new Map([['binance:BTCUSDT', { ...daily, status: 'failed' as const, points: [] }]]), true, { view })[0]!;
  assert.deepEqual([failed.periodMs, failed.status], [HOUR, 'stale'], 'a failure after it keeps the hourly line, stale');
  // A coarser answer still reaches as far before it replaces a finer line (a zoom out past the switch, read in its older stretch first).
  const oldDaily: LsSeries = { ...daily, pending: true, points: [{ t: today - 3 * DAY, long: 0.6 }] };
  assert.deepEqual(lsLanded(['binance:BTCUSDT'], [{ ...hours, pending: undefined }], new Map([['binance:BTCUSDT', oldDaily]]), false, { view }).map(s => [s.periodMs, s.pending]), [[HOUR, true]]);
});

test('an answer for a zoom since left never replaces the line in the period the view asks now; a replay and the view\'s edge count what is drawn', () => {
  // Review 2026-11-23: OKX drawn five-minutely at eight days, a zoom out to 12 days asked hourly, back at eight before it answered: the
  // hourly answer (reaching further) replaced the five-minute line until the next round read it again.
  const id = 'okx:BTC-USDT-SWAP', five: LsSeries = { id, population: 'accounts', periodMs: 5 * MIN, status: 'ok', points: Array.from({ length: 12 }, (_, i) => ({ t: NOW - (11 - i) * 5 * MIN, long: 0.6 })) };
  const hourly: LsSeries = { id, population: 'accounts', periodMs: HOUR, status: 'ok', points: [{ t: NOW - HOUR, long: 0.6 }, { t: NOW, long: 0.62 }] };
  const want = new Map([[id, 5 * MIN]]);
  assert.equal(lsLanded([id], [five], new Map([[id, hourly]]), false, { view, want })[0], five, 'the five-minute line stays');
  assert.equal(lsLanded([id], [five], new Map([[id, hourly]]), false, { view })[0], hourly, 'without the view\'s periods, by reach as before');
  const settled = lsLanded([id], [{ ...five, pending: true }], new Map([[id, { ...hourly, status: 'failed' as const, points: [] }]]), true, { view, want })[0]!;
  assert.deepEqual([settled.periodMs, settled.status, settled.pending], [5 * MIN, 'ok', true], 'the round over: kept as it was, still pending (the pane asks again soon)');
  // A replay at 12:02 draws a five-minute reading of 12:00 only from 12:05: it does not yet replace the hourly line.
  const noon = Math.floor(NOW / DAY) * DAY + 12 * HOUR, hours: LsSeries = { ...hourly, points: [{ t: noon - 2 * HOUR, long: 0.6 }, { t: noon - HOUR, long: 0.61 }] };
  const fine: LsSeries = { ...five, pending: true, points: [{ t: noon, long: 0.6 }] }, around = { t0: noon - 3 * HOUR, t1: noon + HOUR };
  assert.equal(lsLanded([id], [hours], new Map([[id, fine]]), false, { view: around, cut: noon + 2 * MIN })[0]!.periodMs, HOUR);
  assert.equal(lsLanded([id], [hours], new Map([[id, fine]]), false, { view: around, cut: noon + 5 * MIN })[0], fine);
  // A step that ends where the view begins draws nothing in it.
  assert.equal(lsLanded([id], [hours], new Map([[id, { ...fine, points: [{ t: around.t0 - 5 * MIN, long: 0.6 }] }]]), false, { view: around })[0]!.periodMs, HOUR);
});

test('a pan never changes a period, even where floating point leaves the view\'s length a fraction of a millisecond off its edge', () => {
  // Review 2026-11-23: 2,500 hours and 0.000244 ms read OKX daily, the same view panned 150 px on 300 hourly.
  const t1 = Date.UTC(2026, 10, 23, 13), edge = { t0: t1 - 2_500 * HOUR - 0.000244, t1 };
  assert.deepEqual([...lsPeriods(IDS, TF, edge).values()].map(name), ['1h', '1h', '1h', '1h', '1h']);
  for (let k = 0; k < 400; k++) {
    const dt = (k - 200) * 7_919.37, moved = { t0: edge.t0 + dt, t1: edge.t1 + dt };
    assert.deepEqual([...lsPeriods(IDS, TF, moved).values()], [...lsPeriods(IDS, TF, edge).values()]);
  }
});

test('a failure or a question never answered counts for the period it was asked in', () => {
  // Review 2026-11-23: a failure had no period (0) and read as a zoom since left, so the line stayed "ok"; a timed-out question of a zoom
  // since left marked the current line stale.
  const id = 'bybit:BTCUSDT', fifteen: LsSeries = { id, population: 'accounts', periodMs: 15 * MIN, status: 'ok', points: [{ t: NOW - 15 * MIN, long: 0.6 }, { t: NOW, long: 0.6 }] };
  const failed = (periodMs: number): LsSeries => ({ id, population: null, periodMs, points: [], status: 'failed' });
  const want = new Map([[id, 15 * MIN]]);
  assert.equal(lsLanded([id], [fifteen], new Map([[id, failed(15 * MIN)]]), true, { view, want, asked: want })[0]!.status, 'stale', 'failed in this zoom\'s period: stale');
  assert.equal(lsLanded([id], [fifteen], new Map([[id, failed(5 * MIN)]]), true, { view, want, asked: new Map([[id, 5 * MIN]]) })[0], fifteen, 'failed for a zoom since left: as it was');
  assert.equal(lsLanded([id], [fifteen], new Map(), true, { view, want, asked: new Map([[id, 5 * MIN]]) })[0], fifteen, 'never answered, for a zoom since left: as it was');
  assert.equal(lsLanded([id], [fifteen], new Map(), true, { view, want, asked: want })[0]!.status, 'stale', 'never answered in this zoom\'s period: stale');
});

test('a replay judges a step by the readings it draws, and a line with nothing in view gives way to an answer with something', () => {
  // Review 2026-11-23: at a 13:02 cut a pending answer with 12:45 and 13:00 extended the 12:45 step to 13:00, though the paint ends it at 12:50.
  const noon = Math.floor(NOW / DAY) * DAY + 12 * HOUR, id = 'binance:BTCUSDT';
  const hourly: LsSeries = { id, population: 'accounts', periodMs: HOUR, status: 'ok', points: [{ t: noon - HOUR, long: 0.6 }, { t: noon, long: 0.6 }] };
  const fine: LsSeries = { id, population: 'accounts', periodMs: 5 * MIN, status: 'ok', pending: true, points: [{ t: noon + 45 * MIN, long: 0.6 }, { t: noon + 60 * MIN, long: 0.6 }] };
  const late = { t0: noon + 51 * MIN, t1: noon + 59 * MIN };
  assert.equal(lsLanded([id], [hourly], new Map([[id, fine]]), false, { view: late, cut: noon + 62 * MIN })[0]!.periodMs, HOUR, 'nothing of it drawn in view yet');
  // Panned into history at the same zoom: the live line has nothing there, the archive's answer (reaching less far) has.
  const live: LsSeries = { id, population: 'accounts', periodMs: HOUR, status: 'ok', points: [{ t: NOW - HOUR, long: 0.6 }, { t: NOW, long: 0.6 }] };
  const old: LsSeries = { ...live, pending: true, points: [{ t: NOW - 40 * DAY, long: 0.6 }, { t: NOW - 39 * DAY, long: 0.6 }] };
  const back = { t0: NOW - 41 * DAY, t1: NOW - 38 * DAY };
  assert.equal(lsLanded([id], [live], new Map([[id, old]]), false, { view: back })[0], old);
  assert.deepEqual(lsLanded([id], [live], new Map([[id, old]]), false, { view })[0]!.points, live.points, 'in the live view, the live line stays');
});

test('an answer in another period than this zoom\'s, from a server that read its own, leaves the line in this zoom\'s period while it shows', () => {
  // Review round 3: a server from before read a 32-day window daily though hourly was asked (a pan of a 16-day view): it replaced the hourly
  // line that still covered the view. Judged by the period that came back; a line with nothing in view gives way all the same.
  const id = 'bybit:BTCUSDT', want = new Map([[id, HOUR]]);
  const hourly: LsSeries = { id, population: 'accounts', periodMs: HOUR, status: 'ok', points: Array.from({ length: 30 }, (_, i) => ({ t: NOW - (29 - i) * HOUR, long: 0.6 })) };
  const today = Math.floor(NOW / DAY) * DAY, daily: LsSeries = { ...hourly, periodMs: DAY, points: [{ t: today - DAY, long: 0.6 }, { t: today, long: 0.61 }] };
  assert.equal(lsLanded([id], [hourly], new Map([[id, daily]]), true, { view, want, asked: want })[0], hourly);
  const away = { t0: NOW - 60 * DAY, t1: NOW - 30 * DAY }, oldDaily: LsSeries = { ...daily, points: [{ t: today - 45 * DAY, long: 0.6 }] };
  assert.equal(lsLanded([id], [hourly], new Map([[id, oldDaily]]), true, { view: away, want, asked: want })[0], oldDaily, 'the hourly line has nothing there: the daily answer, not a blank');
});

test('in a replay, an answer reaches only as far as what it has published, and a stale one with nothing to draw leaves the line that has', () => {
  // Review round 3: zoomed out from eight days to nine in a replay, the 15-minute answer's readings after the cut out-reached the visible
  // five-minute line and blanked it, and stayed blank when its read then failed.
  const id = 'bybit:BTCUSDT', cut = NOW - 2 * HOUR, around = { t0: cut - 6 * HOUR, t1: cut };
  const five: LsSeries = { id, population: 'accounts', periodMs: 5 * MIN, status: 'ok', points: Array.from({ length: 60 }, (_, i) => ({ t: cut - 5 * HOUR + i * 5 * MIN, long: 0.6 })) };
  const later: LsSeries = { id, population: 'accounts', periodMs: 15 * MIN, status: 'ok', pending: true, points: [{ t: cut + 15 * MIN, long: 0.6 }, { t: cut + 30 * MIN, long: 0.6 }] };
  const landed = lsLanded([id], [five], new Map([[id, later]]), false, { view: around, cut })[0]!;
  assert.deepEqual([landed.periodMs, landed.pending], [5 * MIN, true], 'the five-minute line stays while it is read');
  const stale = lsLanded([id], [five], new Map([[id, { ...later, pending: undefined, status: 'stale' as const }]]), true, { view: around, cut })[0]!;
  assert.deepEqual([stale.periodMs, stale.status], [5 * MIN, 'stale'], 'its read failed: the five-minute line, stale');
});
