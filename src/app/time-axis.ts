import { tickLabel, timeZone, zoneOffsetMs } from './format.ts';

const DAY = 86_400_000;
const TIME_STEPS = [60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 14400e3, 43200e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
type Step = { unit: 'time' | 'month' | 'year'; count: number };
export interface TimeLabel { t: number; x: number; text: string }

function stepFor(t0: number, t1: number, width: number, minPx: number): Step | null {
  if (![t0, t1, width, minPx].every(Number.isFinite) || t1 <= t0 || width <= 0 || minPx <= 0) return null;
  const want = (t1 - t0) * minPx / width, fixed = TIME_STEPS.find(step => step >= want);
  if (fixed !== undefined) return { unit: 'time', count: fixed };
  // Even February must leave enough room; months are stepped on the calendar, never as thirty-day durations.
  const months = [1, 2, 3, 6].find(count => count * 28 * DAY >= want);
  if (months !== undefined) return { unit: 'month', count: months };
  const years = want / (365 * DAY), power = 10 ** Math.floor(Math.log10(Math.max(1, years)));
  return { unit: 'year', count: [1, 2, 5, 10].find(n => n * power >= years)! * power };
}

/** Read a wall-clock midnight back in the page's zone, including any daylight-saving change since the first tick. */
function midnight(year: number, month: number, day = 1): number {
  return timeZone() === 'utc' ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
}

function ticksFor(t0: number, t1: number, step: Step): number[] {
  const out: number[] = [], wall0 = t0 + zoneOffsetMs(t0);
  if (step.unit === 'time') {
    const offset = -zoneOffsetMs(t0);
    for (let wall = Math.ceil(wall0 / step.count) * step.count; ; wall += step.count) {
      const date = new Date(wall), t = step.count < DAY ? wall + offset : midnight(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      if (t > t1) break;
      if (t >= t0) out.push(t);
    }
  } else {
    const date = new Date(wall0), year = date.getUTCFullYear();
    const first = step.unit === 'month' ? year * 12 + date.getUTCMonth() : year;
    for (let index = Math.ceil(first / step.count) * step.count; ; index += step.count) {
      const t = step.unit === 'month' ? midnight(Math.floor(index / 12), index % 12) : midnight(index, 0);
      if (t > t1) break;
      if (t >= t0) out.push(t);
    }
  }
  return out;
}

/** Shared grid ticks, from minutes through calendar months and years, chosen for the plot's actual width. */
export function timeTicks(t0: number, t1: number, widthPx: number, minPx = 96): number[] {
  const step = stepFor(t0, t1, widthPx, minPx);
  return step ? ticksFor(t0, t1, step) : [];
}

export interface TimeAxisOptions {
  /** The least room a tick has (a narrow plot, as a phone's, asks for less than the map's 96). */
  minPx?: number;
  /** Whether the first label carries its date (the map's does; a chart of a few hours, as the Flow view's, reads by the clock alone and gives the date only where the day changes). */
  dateOnFirst?: boolean;
}

/** Centre only labels whose measured text fits inside the plot and leaves twelve pixels before the next label. */
export function timeAxis(t0: number, t1: number, width: number, measure: (text: string) => number, { minPx = 96, dateOnFirst = true }: TimeAxisOptions = {}): { ticks: number[]; labels: TimeLabel[] } {
  const step = stepFor(t0, t1, width, minPx), labels: TimeLabel[] = [];
  if (!step) return { ticks: [], labels };
  const ticks = ticksFor(t0, t1, step);
  let right = -Infinity, lastDay: number | undefined, lastYear: number | undefined;
  for (const t of ticks) {
    const wall = new Date(t + zoneOffsetMs(t)), day = Math.floor(wall.getTime() / DAY), year = wall.getUTCFullYear();
    // Judged before the label is measured: a date the first label would have carried made it wide, and the ones after it were turned away for its room.
    const marksDay = lastDay === undefined ? dateOnFirst : ticks.length < 3 && day !== lastDay;
    const text = tickLabel(t, step.unit === 'month' ? year !== lastYear : marksDay, step.unit);
    const x = (t - t0) / (t1 - t0) * width, half = measure(text) / 2;
    if (x - half < 4 || x + half > width - 4 || x - half < right + 12) continue;
    labels.push({ t, x, text }); right = x + half; lastDay = day; lastYear = year;
  }
  return { ticks, labels };
}
