import test from 'node:test';
import assert from 'node:assert/strict';
import { AGE_FLOOR, LABEL_FLOOR, ageAlpha, ageRanks, carriedLines, carryPairs, runPieces, seriesOf } from '../src/app/traded/carry.ts';
import { DRAWN_SHARE, MAX_BAR_ROWS, candleLevels, carriesOf, gatedCarries, linesWindows, periodWindows, recordedWindowLevels, touchedAt, type HeldValueArea } from '../src/app/traded/levels.ts';
import type { CandleRow } from '../src/app/store.ts';
import { dayWindows, type ProfileWindow, type SessionDef } from '../src/app/traded/sessions.ts';
import { TRADED_DEFAULTS, readTraded } from '../src/app/traded/settings.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const at = (day: number, hh = 0, mm = 0): number => Date.UTC(2026, 9, day, hh, mm);   // October 2026: the 12th is a Monday
const iso = (t: number): string => new Date(t).toISOString().slice(0, 16);
const kind = (period: 'day' | 'week' | 'month' | 'sessions', extra: { zone?: string; sessions?: SessionDef[] } = {}) => ({ period, zone: extra.zone ?? 'UTC', sessions: extra.sessions ?? [] });
const def = (id: string, start: string, end: string, extra: Partial<SessionDef> = {}): SessionDef => ({ id, name: id, zone: 'UTC', start, end, on: true, weekdays: false, ...extra });
const pair = (c: { source: ProfileWindow; current: ProfileWindow }): string[] => [iso(c.source.from), iso(c.source.to), iso(c.current.from), iso(c.current.to)];

test('the window under way carries the one just before it, however many windows are drawn', () => {
  const now = at(14, 15, 30);
  const [c] = carriesOf(kind('day'), 'utc', now);
  assert.deepEqual(pair(c!), ['2026-10-13T00:00', '2026-10-14T00:00', '2026-10-14T00:00', '2026-10-15T00:00']);
  // Count 1: a single day is drawn, and yesterday's levels still come across it.
  const shown = linesWindows({ ...TRADED_DEFAULTS, ...kind('day'), count: 1 }, 'utc', now - 3 * DAY, now + 5 * MIN, now);
  assert.deepEqual(shown.map(w => iso(w.from)), ['2026-10-14T00:00']);
  assert.equal(c!.current.key, shown[0]!.key);
  // Each kind has its own pair; a week is Monday to Monday, a month the calendar month.
  assert.deepEqual(pair(carriesOf(kind('week'), 'utc', now)[0]!), ['2026-10-05T00:00', '2026-10-12T00:00', '2026-10-12T00:00', '2026-10-19T00:00']);
  assert.deepEqual(pair(carriesOf(kind('month'), 'utc', now)[0]!), ['2026-09-01T00:00', '2026-10-01T00:00', '2026-10-01T00:00', '2026-11-01T00:00']);
});

test('the immediate predecessor or nothing: an older window is never put in its place', () => {
  const now = at(14, 15, 30), days = dayWindows('UTC', now - 6 * DAY, now + 1);
  assert.equal(carryPairs(days, now).length, 1);
  // The 13th is missing from the calendar though the 10th, 11th and 12th are there: no carry, not the 12th's.
  const cut = days.filter(w => w.from !== at(13));
  assert.deepEqual(carryPairs(cut, now), []);
  // The oldest window held has no predecessor.
  assert.deepEqual(carryPairs(days.filter(w => w.from === at(14)), now), []);
  // A source from the recording must have begun inside what it keeps: pairing is on the whole calendar and the gate comes after, so a source
  // that fails it leaves nothing at all (the window before it is not offered).
  const lines = (...ks: ('day' | 'week' | 'month' | 'sessions')[]) => ({ lines: ks, source: 'recorded' as const, zone: 'UTC', sessions: [def('london', '07:00', '16:00')] });
  const found = (s: ReturnType<typeof lines>, keeps: number, at = now): string[] => gatedCarries(s, 'utc', at, at, keeps).map(c => seriesOf(c.source) + ' ' + iso(c.source.from));
  assert.deepEqual(found(lines('day'), 7 * DAY), ['day|UTC 2026-10-13T00:00'], 'a server holds yesterday');
  assert.deepEqual(found(lines('day'), DAY), [], 'a page that keeps a day has no previous day');
  assert.deepEqual(found(lines('week'), 7 * DAY), [], 'a server holds the week under way alone: no previous week');
  assert.deepEqual(found(lines('sessions'), 7 * DAY), ['session|london 2026-10-13T07:00']);
  assert.deepEqual(found(lines('sessions'), DAY), []);
  // The first hour after a 23-hour day would let a day through a one-day retention by the window test alone; the kind's count does not.
  const berlin = { ...lines('day'), zone: 'Europe/Berlin' }, hourAfter = Date.UTC(2026, 2, 29, 22, 30);
  assert.deepEqual(found(berlin, DAY, hourAfter), []);
  // Months are always candles; candles carry whatever the recording keeps.
  assert.deepEqual(found(lines('month'), DAY), ['month|UTC 2026-09-01T00:00']);
  assert.deepEqual(found({ ...lines('week', 'day'), source: 'candles' as never }, DAY), ['week|UTC 2026-10-05T00:00', 'day|UTC 2026-10-13T00:00']);
});

test('a carry draws the source\'s levels across the whole period under way, the same whether or not price has traded through them', () => {
  const now = at(14, 15, 30), [c] = carriesOf(kind('day'), 'utc', now), levels = { poc: 80_650, vah: 80_980, val: 79_980 };
  const lines = carriedLines(levels, c!.current, { poc: true, va: true });
  assert.deepEqual(lines.map(l => [l.what, l.price]), [['vah', 80_980], ['val', 79_980], ['poc', 80_650]]);
  assert.ok(lines.every(l => l.from === at(14) && l.to === at(15)), 'from the start of the period under way to its end (not only the part elapsed)');
  // The lines' own switches choose which are carried.
  assert.deepEqual(carriedLines(levels, c!.current, { poc: true, va: false }).map(l => l.what), ['poc']);
  assert.deepEqual(carriedLines(levels, c!.current, { poc: false, va: true }).map(l => l.what), ['vah', 'val']);
  assert.deepEqual(carriedLines(levels, c!.current, { poc: false, va: false }), []);
  // Nothing in a carry reads a price: whether the level was touched is not a question it asks (the untouched run of older windows is another line).
});

test('the source\'s untouched run is hidden only over the window under way, so what lies outside it keeps its dots', () => {
  // Days: the run starts where the carry does and goes on to the right edge; the carry runs to the window's end, which can be before the edge.
  assert.deepEqual(runPieces(100, 300, { from: 100, to: 250 }), [[250, 300]], 'what is left of the run past the window\'s end');
  assert.deepEqual(runPieces(100, 300, { from: 100, to: 400 }), [], 'the carry covers it all');
  // Sessions: the next one began later, so the run crosses the gap before it.
  assert.deepEqual(runPieces(100, 300, { from: 180, to: 400 }), [[100, 180]], 'the gap between two sessions');
  assert.deepEqual(runPieces(100, 300, { from: 180, to: 250 }), [[100, 180], [250, 300]]);
  // A run that ended before the window under way, or begins after it.
  assert.deepEqual(runPieces(100, 150, { from: 180, to: 250 }), [[100, 150]]);
  assert.deepEqual(runPieces(260, 300, { from: 180, to: 250 }), [[260, 300]]);
  // No carry: the whole run; no run: nothing.
  assert.deepEqual(runPieces(100, 300, null), [[100, 300]]);
  assert.deepEqual(runPieces(100, 100, null), []);
});

test('a touch is read only from candles that were over at the moment a replay shows', () => {
  const candle = (t: number, high: number, low: number): CandleRow => [t, 100, high, low, 100, 1];
  const candles = [candle(at(14, 0), 101, 99), candle(at(14, 1), 101, 99), candle(at(14, 2), 120, 99), candle(at(14, 3), 101, 99)];
  // Live, the candle at 02:00 reaches 110 (it opens at 02:00).
  assert.equal(touchedAt(110, at(14), candles, 0), at(14, 2));
  // Replaying 02:30, that candle is still forming: its high is from the future, so there is no touch yet; at 03:00 it is over.
  assert.equal(touchedAt(110, at(14), candles, 0, { by: at(14, 2, 30), barMs: HOUR }), null);
  assert.equal(touchedAt(110, at(14), candles, 0, { by: at(14, 3), barMs: HOUR }), at(14, 2));
});

test('a session that overlaps its own next occurrence (daylight saving) is refused, never paired', () => {
  // 03:15 to 02:30 the next day in New York: on the day the clocks jump forward the skipped 02:30 lands at 03:30, after the next one began.
  const odd = [def('odd', '03:15', '02:30', { zone: 'America/New_York' })];
  const found = carriesOf(kind('sessions', { sessions: odd }), 'utc', Date.UTC(2026, 2, 8, 7, 20));   // 03:20 EDT on 8 March 2026
  assert.deepEqual(found, []);
  // A day later it pairs again.
  assert.equal(carriesOf(kind('sessions', { sessions: odd }), 'utc', Date.UTC(2026, 2, 9, 12)).length, 1);
});

test('sessions are series of their own: overlapping ones carry independently, and nothing is carried between two sessions', () => {
  const sessions = [def('london', '07:00', '16:00'), def('ny', '12:00', '21:00'), def('asia', '00:00', '09:00')];
  const found = (now: number) => carriesOf(kind('sessions', { sessions }), 'utc', now).map(c => `${seriesOf(c.current)} ${iso(c.source.from)} -> ${iso(c.current.from)}`);
  // 13:00 on the 14th: London and New York are both under way.
  assert.deepEqual(found(at(14, 13)), ['session|london 2026-10-13T07:00 -> 2026-10-14T07:00', 'session|ny 2026-10-13T12:00 -> 2026-10-14T12:00']);
  // 05:00: only Asia is under way; the others have no window under way (London begins at 07:00).
  assert.deepEqual(found(at(14, 5)), ['session|asia 2026-10-13T00:00 -> 2026-10-14T00:00']);
  // 17:00, between London and New York's end and Asia's start: New York alone.
  assert.deepEqual(found(at(14, 17)), ['session|ny 2026-10-13T12:00 -> 2026-10-14T12:00']);
  // 22:00: no session under way: no carry.
  assert.deepEqual(found(at(14, 22)), []);
  // A session switched off has none.
  assert.deepEqual(carriesOf(kind('sessions', { sessions: [def('london', '07:00', '16:00', { on: false })] }), 'utc', at(14, 13)), []);
});

test('weekends, weekday sessions and overnight sessions', () => {
  // A Monday to Friday session carries the previous Friday's across Monday's, and nothing at the weekend.
  const us = [def('us', '09:30', '16:00', { zone: 'America/New_York', weekdays: true })];
  const monday = carriesOf(kind('sessions', { sessions: us }), 'utc', at(26, 15));
  assert.deepEqual(monday.map(pair), [['2026-10-23T13:30', '2026-10-23T20:00', '2026-10-26T13:30', '2026-10-26T20:00']], 'EDT is UTC-4 until 1 November');
  assert.deepEqual(carriesOf(kind('sessions', { sessions: us }), 'utc', at(24, 15)), [], 'Saturday: no session under way');
  assert.deepEqual(carriesOf(kind('sessions', { sessions: us }), 'utc', at(25, 15)), [], 'Sunday: none either');
  // Tuesday carries Monday's, Wednesday Tuesday's.
  assert.equal(iso(carriesOf(kind('sessions', { sessions: us }), 'utc', at(27, 15))[0]!.source.from), '2026-10-26T13:30');
  // An overnight session (22:00 to 06:00 the next day) is under way at 03:00 and began the evening before; its predecessor is the night before that.
  const night = [def('night', '22:00', '06:00')];
  assert.deepEqual(carriesOf(kind('sessions', { sessions: night }), 'utc', at(14, 3)).map(pair), [['2026-10-12T22:00', '2026-10-13T06:00', '2026-10-13T22:00', '2026-10-14T06:00']]);
  assert.deepEqual(carriesOf(kind('sessions', { sessions: night }), 'utc', at(14, 12)), [], 'by day: between two nights');
  // In Tokyo (UTC+9, no daylight saving) the same night is 13:00 to 21:00 UTC.
  const tokyo = [def('night', '22:00', '06:00', { zone: 'Asia/Tokyo' })];
  assert.deepEqual(carriesOf(kind('sessions', { sessions: tokyo }), 'utc', at(13, 20)).map(pair), [['2026-10-12T13:00', '2026-10-12T21:00', '2026-10-13T13:00', '2026-10-13T21:00']]);
  // A session whose end equals its start is a whole day: back to back, so each one carries the one before.
  const whole = [def('all', '00:00', '00:00')];
  assert.deepEqual(carriesOf(kind('sessions', { sessions: whole }), 'utc', at(14, 15)).map(pair), [['2026-10-13T00:00', '2026-10-14T00:00', '2026-10-14T00:00', '2026-10-15T00:00']]);
});

test('daylight saving and month boundaries: periods meet where the clocks say, and a boundary instant belongs to the new window', () => {
  // Berlin's clocks went back on 25 October 2026: that day is 25 hours long and its predecessor ends where it begins.
  const fall = carriesOf(kind('day', { zone: 'Europe/Berlin' }), 'utc', at(25, 12));
  assert.deepEqual(fall.map(pair), [['2026-10-23T22:00', '2026-10-24T22:00', '2026-10-24T22:00', '2026-10-25T23:00']]);
  const next = carriesOf(kind('day', { zone: 'Europe/Berlin' }), 'utc', at(26, 12));
  assert.deepEqual(next.map(pair), [['2026-10-24T22:00', '2026-10-25T23:00', '2026-10-25T23:00', '2026-10-26T23:00']], 'the 25-hour day is the source');
  // They went forward on 29 March 2026: 23 hours.
  const spring = carriesOf(kind('day', { zone: 'Europe/Berlin' }), 'utc', Date.UTC(2026, 2, 29, 12));
  assert.deepEqual(spring.map(pair), [['2026-03-27T23:00', '2026-03-28T23:00', '2026-03-28T23:00', '2026-03-29T22:00']]);
  // A week across the change is Monday to Monday in the zone: 169 hours.
  const week = carriesOf(kind('week', { zone: 'Europe/Berlin' }), 'utc', at(28, 12));
  assert.deepEqual(week.map(pair), [['2026-10-18T22:00', '2026-10-25T23:00', '2026-10-25T23:00', '2026-11-01T23:00']], 'the week of the change');
  // Months: the last instant of October is October's, the first of November is November's (half-open windows).
  const last = carriesOf(kind('month'), 'utc', Date.UTC(2026, 9, 31, 23, 59, 59, 999));
  assert.deepEqual(last.map(pair), [['2026-09-01T00:00', '2026-10-01T00:00', '2026-10-01T00:00', '2026-11-01T00:00']]);
  const first = carriesOf(kind('month'), 'utc', Date.UTC(2026, 10, 1));
  assert.deepEqual(first.map(pair), [['2026-10-01T00:00', '2026-11-01T00:00', '2026-11-01T00:00', '2026-12-01T00:00']]);
  // A year end, and February in a non-leap year.
  assert.deepEqual(carriesOf(kind('month'), 'utc', Date.UTC(2027, 0, 1, 0, 1)).map(pair), [['2026-12-01T00:00', '2027-01-01T00:00', '2027-01-01T00:00', '2027-02-01T00:00']]);
  assert.deepEqual(carriesOf(kind('month'), 'utc', Date.UTC(2027, 2, 1, 0, 1)).map(pair), [['2027-02-01T00:00', '2027-03-01T00:00', '2027-03-01T00:00', '2027-04-01T00:00']]);
  // A midnight exactly: the day that begins then.
  assert.deepEqual(carriesOf(kind('day'), 'utc', at(14)).map(pair), [['2026-10-13T00:00', '2026-10-14T00:00', '2026-10-14T00:00', '2026-10-15T00:00']]);
  assert.deepEqual(carriesOf(kind('day'), 'utc', at(14) - 1).map(pair), [['2026-10-12T00:00', '2026-10-13T00:00', '2026-10-13T00:00', '2026-10-14T00:00']]);
});

test('a gap in a calendar kind is not an immediate predecessor, but a session\'s previous one may be days back', () => {
  const w = (key: string, from: number, to: number): ProfileWindow => ({ key, name: '', from, to });
  const now = at(14, 12);
  // Days that do not meet.
  assert.deepEqual(carryPairs([w('day|UTC|1', at(11), at(12)), w('day|UTC|2', at(14), at(15))], now), []);
  // Overlapping days (a bad calendar) are not predecessors either.
  assert.deepEqual(carryPairs([w('day|UTC|1', at(12), at(14, 6)), w('day|UTC|2', at(14), at(15))], now), []);
  // Sessions of one definition with days between them (a weekend) are.
  assert.equal(carryPairs([w('session|a|1', at(9, 9), at(9, 17)), w('session|a|2', at(14, 9), at(14, 17))], now).length, 1);
  // ... but not one that runs into the next.
  assert.deepEqual(carryPairs([w('session|a|1', at(9, 9), at(14, 10)), w('session|a|2', at(14, 9), at(14, 17))], now), []);
  // Windows that have not begun are not under way.
  assert.deepEqual(carryPairs([w('day|UTC|1', at(13), at(14)), w('day|UTC|2', at(14), at(15))], at(13, 12)), []);
});

test('replay: the windows are those at the moment shown, and a window that has not begun there carries nothing', () => {
  const now = at(14, 15, 30), replay = at(10, 6, 0);
  const live = carriesOf(kind('day'), 'utc', now), then = carriesOf(kind('day'), 'utc', replay);
  assert.deepEqual(then.map(pair), [['2026-10-09T00:00', '2026-10-10T00:00', '2026-10-10T00:00', '2026-10-11T00:00']]);
  assert.notDeepEqual(live, then);
  // The calendar is laid out from the replay's moment: the same pairs as when it was live then.
  assert.deepEqual(carryPairs(periodWindows(kind('day'), 'utc', at(1), at(20)), replay).map(pair), then.map(pair));
  // The week at the moment has begun, the next has not.
  assert.deepEqual(carriesOf(kind('week'), 'utc', at(18, 23, 59)).map(pair), [['2026-10-05T00:00', '2026-10-12T00:00', '2026-10-12T00:00', '2026-10-19T00:00']]);
  assert.deepEqual(carriesOf(kind('week'), 'utc', at(19)).map(pair), [['2026-10-12T00:00', '2026-10-19T00:00', '2026-10-19T00:00', '2026-10-26T00:00']]);
});

test('the recording\'s answer for a source: a late revision replaces it, one from before the window ended or thinly recorded draws nothing', () => {
  const to = at(14), held = (change: Partial<HeldValueArea> = {}): HeldValueArea => ({ from: at(13), to, minutes: 1_440, covered: 0.97, poc: 100, vah: 104, val: 97, asOf: to + 30 * MIN, ...change });
  const now = to + HOUR;
  assert.deepEqual(recordedWindowLevels(held(), { to }, now), { levels: { poc: 100, vah: 104, val: 97 }, upTo: to + 30 * MIN });
  // No answer yet, an empty window.
  assert.equal(recordedWindowLevels(undefined, { to }, now), null);
  assert.equal(recordedWindowLevels(held({ poc: null }), { to }, now), null);
  // An answer from before the window ended may lack its last trades: it waits for the next.
  assert.equal(recordedWindowLevels(held({ asOf: to - MIN }), { to }, now), null);
  // The next, a revision with late trades: its levels replace the first's.
  assert.deepEqual(recordedWindowLevels(held({ asOf: to + 50 * MIN, poc: 101, vah: 105 }), { to }, now)?.levels, { poc: 101, vah: 105, val: 97 });
  // Under nine in ten of the window recorded: not drawn, at nine in ten drawn. Without the source's estimate, the minutes of the best venue.
  assert.equal(recordedWindowLevels(held({ covered: DRAWN_SHARE - 0.01 }), { to }, now), null);
  assert.ok(recordedWindowLevels(held({ covered: DRAWN_SHARE }), { to }, now));
  assert.equal(recordedWindowLevels(held({ covered: undefined, minutes: 1_000 }), { to }, now), null);
  assert.ok(recordedWindowLevels(held({ covered: undefined, minutes: 1_400 }), { to }, now));
});

test('older windows among those shown fade a little by their rank in their own series, the two newest in full', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 6, 20].map(ageAlpha), [1, 1, 0.9, 0.8, 0.7, 0.6, AGE_FLOOR]);
  assert.ok(ageAlpha(100) >= AGE_FLOOR && AGE_FLOOR > 0.5, 'none disappears');
  assert.ok(LABEL_FLOOR > AGE_FLOOR, 'a name is read, a line is seen: names fade less');
  const w = (key: string, from: number): ProfileWindow => ({ key, name: '', from, to: from + HOUR });
  const ranks = ageRanks([w('day|UTC|1', 1), w('day|UTC|3', 3), w('day|UTC|2', 2), w('session|s1|9', 9), w('session|s2|5', 5), w('session|s2|4', 4)]);
  assert.deepEqual([...ranks].sort(), [['day|UTC|1', 2], ['day|UTC|2', 1], ['day|UTC|3', 0], ['session|s1|9', 0], ['session|s2|4', 1], ['session|s2|5', 0]]);
});

test('the setting reads as a switch, on until chosen otherwise', () => {
  assert.equal(TRADED_DEFAULTS.carry, true);
  assert.equal(readTraded({}).carry, true, 'a save from before it');
  assert.equal(readTraded({ carry: false }).carry, false);
  assert.equal(readTraded({ carry: 'no' }).carry, true, 'not a switch: the default');
  assert.equal(readTraded(JSON.parse(JSON.stringify(readTraded({ carry: false })))).carry, false, 'and it round trips');
});

test('rows far finer than the prices (no price known yet) draw nothing instead of filling millions of rows a bar', () => {
  const bars: CandleRow[] = [[at(14), 80_000, 80_100, 79_900, 80_050, 10]];
  const fine = candleLevels(bars, at(14), at(14) + 5 * MIN, 5 * MIN, 1e-9, 0.7, at(15));
  assert.deepEqual([fine.levels, fine.covered, fine.rows.size], [null, 0, 0]);
  assert.ok(candleLevels(bars, at(14), at(14) + 5 * MIN, 5 * MIN, 20, 0.7, at(15)).levels, 'rows of the usual size are worked out');
  // A bar of a coin that fell ninety-odd per cent is many times today's price high: 90,000 rows of a step of 0.0022 is still worked out, a million is not.
  assert.ok(candleLevels(bars, at(14), at(14) + 5 * MIN, 5 * MIN, 200 / 90_000, 0.7, at(15)).levels);
  assert.ok(MAX_BAR_ROWS > 90_000 && MAX_BAR_ROWS < 1_000_000);
  assert.equal(candleLevels(bars, at(14), at(14) + 5 * MIN, 5 * MIN, 200 / 1_000_000, 0.7, at(15)).levels, null);
});
