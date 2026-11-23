import test from 'node:test';
import assert from 'node:assert/strict';
import { OI_CLOSE_AT_MS, OI_LATE_MS, closeRead, filedAt } from '../src/shared/oi-close.ts';

const MIN = 60_000, m = 20 * 86_400_000 + 7 * MIN;

/** Steps every 250 ms over [from, to) of `m`, with what each read asked for: [ms into the run, the minute it is filed in]. */
function run(from: number, to: number, closed?: number): { asked: [number, number][]; closed: number | undefined } {
  const asked: [number, number][] = [];
  for (let now = m + from; now < m + to; now += 250) {
    const due = closeRead(now, closed); if (!due) continue;
    closed = due.closed; asked.push([now - m, due.files - m]);
  }
  return { asked, closed };
}

test('a venue read once a minute is read at once, then at each minute\'s close, filed in the minute it closes', () => {
  assert.deepEqual(run(20_000, 3 * MIN).asked, [[20_000, 0], [OI_CLOSE_AT_MS, 0], [MIN + OI_CLOSE_AT_MS, MIN], [2 * MIN + OI_CLOSE_AT_MS, 2 * MIN]]);
  // Started in a minute's first seconds: a reading of its own minute (nothing says the minute before's close was missed: a restart may have
  // written it; Sol 6.2, 2026-11-23), then its close.
  assert.deepEqual(run(4_000, MIN).asked, [[4_000, 0], [OI_CLOSE_AT_MS, 0]]);
  assert.deepEqual(closeRead(m + 4_000, undefined), { files: m, close: false, closed: m - MIN });
  // Started in the close's seconds: that is the close.
  assert.deepEqual(run(58_000, MIN + 30_000).asked, [[58_000, 0]]);
});

test('a close missed by the minute\'s end is asked early in the next minute, and a longer hold reads at once in its own minute', () => {
  const first = run(20_000, 56_000);
  // Held from :56 to the next minute's :01 (the advisor's case): the close of the minute held across.
  assert.deepEqual(run(MIN + 1_000, MIN + 2_000, first.closed).asked, [[MIN + 1_000, 0]]);
  assert.equal(OI_LATE_MS, 10_000);
  // Held past the late window: a reading at once in its own minute; the minute it missed keeps its last reading.
  assert.deepEqual(run(MIN + 15_000, MIN + 58_000, first.closed).asked, [[MIN + 15_000, MIN], [MIN + OI_CLOSE_AT_MS, MIN]]);
});

test('a reading is filed at its own time, never after the end of the minute it was asked for', () => {
  assert.equal(filedAt(m + 57_400, m), m + 57_400);
  assert.equal(filedAt(m + 60_800, m), m + MIN - 1);
  assert.equal(filedAt(m + 3_000, m - MIN), m - 1, 'a late close');
  // Any other read (one at start) a millisecond before the close's, so the close is the minute's row whichever answers first (Sol 6.2).
  assert.equal(filedAt(m + 60_800, m, false), m + MIN - 2);
  assert.equal(filedAt(m + 30_000, m, false), m + 30_000);
});
