import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeZone, tickLabel } from '../src/app/format.ts';
import { LANGUAGES, setLanguage } from '../src/app/i18n.ts';
import { timeAxis, timeTicks } from '../src/app/time-axis.ts';

const DAY = 86_400_000;
const measure = (text: string): number => text.length * 7;
beforeEach(() => { setTimeZone('utc'); setLanguage('en'); });
afterEach(() => { setTimeZone('local'); setLanguage('en'); });

function fits(t0: number, t1: number, width: number, wide = measure): void {
  const { ticks, labels } = timeAxis(t0, t1, width, wide);
  assert.deepEqual(ticks, timeTicks(t0, t1, width), 'the labels and shared pane grid use the same ticks');
  let right = -Infinity;
  for (const label of labels) {
    const half = wide(label.text) / 2;
    assert.ok(label.x - half >= 4, `${label.text} fits the left edge`);
    assert.ok(label.x + half <= width - 4, `${label.text} fits the right edge`);
    assert.ok(label.x - half >= right + 12, `${label.text} has room after the previous label`);
    right = label.x + half;
  }
}

test('the screenshot range uses one tick per calendar month instead of overlapping weekly dates', () => {
  const t0 = Date.UTC(2026, 0, 1), t1 = Date.UTC(2026, 11, 3), width = 1640;
  const { ticks, labels } = timeAxis(t0, t1, width, measure);
  assert.deepEqual(ticks, Array.from({ length: 12 }, (_, month) => Date.UTC(2026, month, 1)));
  assert.equal(labels[0]!.text, 'Feb 2026', 'the first visible month supplies the year');
  assert.ok(labels.some(label => label.text === 'Mar'), 'monthly ticks omit the redundant day number');
  fits(t0, t1, width);
});

test('zooming out and shrinking the plot keep tick density bounded through the 400-day zoom limit', () => {
  const t0 = Date.UTC(2025, 11, 18);
  for (const width of [1800, 960, 420, 220, 120]) {
    for (const days of [2, 14, 60, 180, 400]) {
      const t1 = t0 + days * DAY, ticks = timeTicks(t0, t1, width);
      assert.ok(ticks.length <= Math.floor(width / 96) + 1, `${days} days in ${width}px stays sparse`);
      for (let i = 1; i < ticks.length; i++) assert.ok((ticks[i]! - ticks[i - 1]!) / (t1 - t0) * width >= 96);
      fits(t0, t1, width);
    }
  }
});

test('month ticks follow unequal calendar months, including leap day, and remain stable while panning', () => {
  const t0 = Date.UTC(2024, 0, 15), t1 = Date.UTC(2024, 5, 15), width = 600;
  const ticks = timeTicks(t0, t1, width);
  assert.deepEqual(ticks, [1, 2, 3, 4, 5].map(month => Date.UTC(2024, month, 1)));
  assert.equal(ticks[1]! - ticks[0]!, 29 * DAY);
  assert.equal(ticks[2]! - ticks[1]!, 31 * DAY);
  assert.deepEqual(timeTicks(t0 + DAY, t1 + DAY, width), ticks, 'panning a day keeps the same calendar grid');
});

test('a year change is identified on monthly labels, and a much wider range uses years alone', () => {
  const { labels } = timeAxis(Date.UTC(2026, 8, 15), Date.UTC(2027, 2, 15), 800, measure);
  assert.ok(labels.some(label => label.text === 'Oct 2026'));
  assert.ok(labels.some(label => label.text === 'Jan 2027'));
  const years = timeAxis(Date.UTC(2010, 6, 1), Date.UTC(2036, 6, 1), 800, measure);
  assert.ok(years.labels.length >= 3);
  assert.ok(years.labels.every(label => /^20\d{2}$/.test(label.text)));
  fits(Date.UTC(2010, 6, 1), Date.UTC(2036, 6, 1), 800);
});

test('actual label widths control collisions and edges, including long localized dates', () => {
  const t0 = Date.UTC(2026, 9, 6, 23), t1 = t0 + 6 * 3_600_000;
  const wide = (text: string): number => text.includes(' ') ? 190 : 105;
  const { ticks, labels } = timeAxis(t0, t1, 720, wide);
  assert.ok(labels.length >= 2 && labels.length < ticks.length, 'long labels are skipped when they do not fit');
  fits(t0, t1, 720, wide);
  for (const { code } of LANGUAGES) {
    setLanguage(code);
    for (const days of [3, 60, 400]) fits(t0, t0 + days * DAY, 360, text => text.length * 14);
    assert.equal(tickLabel(Date.UTC(2026, 9, 1), false, 'month'), new Intl.DateTimeFormat(code, { month: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 9, 1)));
  }
});

test('daily and monthly ticks stay on local midnight across daylight saving changes', () => {
  const old = process.env.TZ;
  process.env.TZ = 'America/New_York'; setTimeZone('local');
  try {
    const ticks = timeTicks(new Date(2026, 2, 1).getTime(), new Date(2026, 2, 16).getTime(), 1600);
    assert.ok(ticks.some((t, i) => i > 0 && t - ticks[i - 1]! === 23 * 3_600_000), 'the spring change has a 23-hour day');
    const months = timeTicks(new Date(2026, 0, 15).getTime(), new Date(2026, 11, 15).getTime(), 1640);
    assert.ok(months.length >= 8);
    for (const t of [...ticks, ...months]) assert.equal(new Date(t).getHours(), 0);
    for (const t of months) assert.equal(new Date(t).getDate(), 1);
  } finally {
    if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
  }
});

test('intraday ticks keep the existing clock labels and invalid or empty plots produce no ticks', () => {
  const t0 = Date.UTC(2026, 9, 6, 10, 7), t1 = t0 + 4 * 3_600_000;
  const { ticks, labels } = timeAxis(t0, t1, 960, measure);
  assert.ok(ticks.length >= 3);
  assert.equal(ticks[1]! - ticks[0]!, 30 * 60_000);
  assert.equal(labels[0]!.text, 'Oct 6 10:30');
  assert.ok(labels.slice(1).every(label => /^\d{2}:\d{2}$/.test(label.text)));
  for (const [start, end, width] of [[t0, t0, 800], [t1, t0, 800], [NaN, t1, 800], [t0, Infinity, 800], [t0, t1, 0], [t0, t1, -10]]) {
    assert.deepEqual(timeTicks(start!, end!, width!), []);
    assert.deepEqual(timeAxis(start!, end!, width!, measure), { ticks: [], labels: [] });
  }
});
