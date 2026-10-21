import { UNRECORDED_MS, type DeltaTrack } from '../delta/candles.ts';
import { OI_GAP_MS, oiIntervals } from '../../shared/oi-profile.ts';
import type { OiBar } from '../store.ts';
import type { InfoLine } from '../infobox.ts';
import { rowBody, type ColumnWords, type TradedRows } from '../traded.ts';
import type { ProfileMetric } from './registry.ts';
import { valueArea } from '../../shared/profile.ts';
import { clock, startOfDay } from '../format.ts';
import { t } from '../i18n.ts';

/**
 * The volume profile along the top of the map, with no canvas: the column beside the map turned onto the time axis. The column adds up a
 * measure by price over what is on the chart; this adds up the same measure, over the same stretch, by time: one bar for each stretch of a
 * round length (a bucket), its two sides in the column's places and colours, its busiest bucket the point of control, and the value area the
 * buckets around that one holding the column's share. The rows are `TradedRows` with time for price (`step` is the bucket's length in ms,
 * bucket `i` starts at (bin0 + i) * step), so the column's header, sums and words read them unchanged.
 */

const SECOND = 1000, MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** The bucket lengths, finest first: a second up to a day, each a round number on the clock and at most two and a half times the one before. */
export const BUCKETS_MS: readonly number[] = [SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY];
/**
 * How wide a bucket is drawn: about as thick as the column's rows, whose step follows the price zoom at a third of the plot's height in
 * rows (`#tradedStep` in heat-pane.ts, about three pixels), and never under two, where a bar would be a sliver between its gaps.
 */
export const BUCKET_PX = 3, MIN_BUCKET_PX = 2;

/**
 * Why the buckets are coarser than the zoom asks: `data`, the data is no finer (the flow before the last day is held a minute at a time,
 * open interest is read about once a minute), so a finer bucket would hold a whole minute or nothing; `finest`, zoomed in past a second.
 */
export type BucketLimit = 'data' | 'finest' | null;

/**
 * The bucket for a view `spanMs` wide on `plotW` pixels: the round length nearest to `BUCKET_PX` wide (as `niceStep` snaps the column's rows),
 * the next coarser where that is under `MIN_BUCKET_PX`, and never finer than `floorMs`, the data's own resolution, which is then said.
 */
export function bucketFor(spanMs: number, plotW: number, floorMs = 0): { step: number; limit: BucketLimit } {
  const perPx = spanMs / Math.max(1, plotW), want = perPx * BUCKET_PX;
  let i = 0;
  for (let k = 1; k < BUCKETS_MS.length; k++) if (Math.abs(Math.log(BUCKETS_MS[k]! / want)) < Math.abs(Math.log(BUCKETS_MS[i]! / want))) i = k;
  while (i < BUCKETS_MS.length - 1 && BUCKETS_MS[i]! < perPx * MIN_BUCKET_PX) i++;
  const zoomed = i;
  while (i < BUCKETS_MS.length - 1 && BUCKETS_MS[i]! < floorMs) i++;
  const step = BUCKETS_MS[i]!;
  return { step, limit: i > zoomed ? 'data' : i === 0 && step > 1.5 * want ? 'finest' : null };
}

/** The bucket length alone (`bucketFor`). */
export const bucketMs = (spanMs: number, plotW: number, floorMs = 0): number => bucketFor(spanMs, plotW, floorMs).step;

/**
 * Why a bucket has no data, which is never drawn or read as a zero: `notRecorded`, no market held flow when it began; `quietGap`, inside a
 * stretch of ten minutes or more with no trade on any of the markets, which the Delta pane takes as not recorded too; `noReading`, no new
 * open-interest reading in it; `noHistory`, before the first change the readings held give; `notLoaded`, outside what the page holds of the
 * liquidations or the absorption marks.
 */
export type TimeGap = 'notRecorded' | 'quietGap' | 'noReading' | 'noHistory' | 'notLoaded';

/** The column's rows by time over [from, to): a bucket at either end counts only its part inside, so the totals are the column's. */
export interface TimeRows extends TradedRows {
  from: number; to: number;
  /** Why each bucket has no data, or null where it has (nothing traded in it is data: a zero). */
  gaps: (TimeGap | null)[];
}

/** Bucket `i`'s span, cut to the stretch added up. */
export function bucketSpan(rows: TimeRows, i: number): [number, number] {
  const start = (rows.bin0 + i) * rows.step;
  return [Math.max(rows.from, start), Math.min(rows.to, start + rows.step)];
}

/** Empty rows for [from, to) in buckets of `step` ms, every bucket a gap of `gap` until it is filled. */
function emptyRows(from: number, to: number, step: number, gap: TimeGap | null): TimeRows {
  const bin0 = Math.floor(from / step), n = to > from ? Math.ceil(to / step) - bin0 : 0;
  return {
    step, bin0, from, to, buy: new Float64Array(n), sell: new Float64Array(n), buyN: null, sellN: null, counted: 0, minutes: 0,
    total: 0, max: 0, poc: -1, recordedSince: null, partial: false, gaps: new Array<TimeGap | null>(n).fill(gap),
  };
}

/** The total, the busiest bucket and its volume, read once the buckets are filled (a gap holds nothing). */
function finish(rows: TimeRows): TimeRows {
  let total = 0, max = 0, poc = -1;
  for (let i = 0; i < rows.buy.length; i++) { const v = rows.buy[i]! + rows.sell[i]!; total += v; if (v > max) { max = v; poc = i; } }
  rows.total = total; rows.max = max; rows.poc = poc;
  return rows;
}

/**
 * Traded volume by time from the flow column's running sums (`DeltaTrack`, the Delta pane's), the time analog of the column's answer: each
 * bucket's gross volume and delta over the markets give what was bought, (gross + delta) / 2, and sold, (gross − delta) / 2. A market counts
 * in a bucket when it holds the second before it, so it never steps in halfway with its whole running sum. Seconds as far as they are
 * whole by `now` (the second under way is not), and a market held a minute at a time read only to the minute that is over (`settled`).
 * Buckets no market held are not recorded, and a stretch of ten minutes or more with nothing traded on any of them is taken as not recorded
 * (`unrecorded` in delta/candles.ts, the Delta pane's rule).
 */
export function flowRows(tracks: readonly DeltaTrack[], from: number, to: number, step: number, now: number, quietMs = UNRECORDED_MS): TimeRows {
  const rows = emptyRows(from, Math.min(to, now), step, 'notRecorded');
  let since: number | null = null;
  for (const k of tracks) if (k.first !== null && (since === null || k.first * SECOND > since)) since = k.first * SECOND;
  rows.recordedSince = since; rows.partial = since === null || since > from;
  const gross = new Float64Array(rows.buy.length);
  for (let i = 0; i < rows.buy.length; i++) {
    const [a, b] = bucketSpan(rows, i), s = Math.floor(a / SECOND), e = Math.floor(b / SECOND) - 1;
    if (e < s) { rows.gaps[i] = null; continue; } // the second under way: nothing whole in it yet
    let g = 0, d = 0, any = false;
    for (const k of tracks) {
      if (k.first === null || k.first > s - 1) continue;
      const end = k.settled ? Math.max(s - 1, k.settled(e)) : e;
      g += k.cumGross(end) - k.cumGross(s - 1); d += k.cumDelta(end) - k.cumDelta(s - 1); any = true;
    }
    if (!any) continue;
    rows.gaps[i] = null; gross[i] = g;
    rows.buy[i] = Math.max(0, (g + d) / 2); rows.sell[i] = Math.max(0, (g - d) / 2);
  }
  // A long enough run of recorded buckets with nothing traded on any market is a stretch nothing was recording, not a quiet one.
  for (let i = 0; i < gross.length;) {
    if (rows.gaps[i] !== null || gross[i]! > 0) { i++; continue; }
    let j = i, ms = 0;
    while (j < gross.length && rows.gaps[j] === null && !(gross[j]! > 0)) { const [a, b] = bucketSpan(rows, j); ms += b - a; j++; }
    if (ms >= quietMs) for (let k = i; k < j; k++) { rows.gaps[k] = 'quietGap'; rows.buy[k] = 0; rows.sell[k] = 0; }
    i = j;
  }
  return finish(rows);
}

/** Whether the flow is held a minute at a time at `from` on any market (before the seconds the page holds): buckets are then a minute at least. */
export function minuteFlowAt(tracks: readonly DeltaTrack[], from: number): boolean {
  const s = Math.floor(from / MINUTE) * 60;
  return tracks.some(k => k.first !== null && k.settled !== undefined && k.settled(s) !== s);
}

/** A part of one market's change of open interest in USD, in the minute it is put in. */
export interface OiStep { t: number; usd: number }

/**
 * One perpetual's open interest by the minute and what its changes are put in dollars with: an inverse market's own USD (its coins were put
 * at one price, `usdAt`, so a change times it is its change in USD), else its coins at the prices that traded on it (`track`, its flow).
 */
export interface OiMarket {
  id: string; bars: readonly OiBar[]; usdAt?: number;
  track?: { readonly first: number | null; cumGross(sec: number): number; priceAt(sec: number): number };
}

/**
 * Each market's changes of open interest spread over time as the column spreads them over prices (shared/oi-profile.ts): the changes between
 * consecutive readings that lie wholly inside [from, to) and span no gap of more than `OI_GAP_MS` (`oiIntervals`, the column's rule), each
 * over the minutes it came about in by their share of the market's traded volume, each part in coins valued at the price that traded on the
 * market in its minute (its last), or an inverse market's USD as it is. So the chart's candles never price it, and switching the timeframe
 * changes nothing. A change with nothing traded on its market between its readings, across a gap, or reaching past the window is not
 * placed: `unplaced` (USD, signed; coins at `price`, the market's last, or the page's mark), which the header says as the column's does.
 * `covered` are the minutes readings no further apart than the gap rule stand for, a change or none: outside them a bucket has no reading;
 * `first`, when the first reading held stands (before it, no history).
 */
export function oiSpread(markets: readonly OiMarket[], from: number, to: number, mark = 0): { parts: OiStep[]; covered: [number, number][]; unplaced: number; first: number } {
  const parts: OiStep[] = [], covered: [number, number][] = [];
  let unplaced = 0, first = Infinity;
  for (const m of markets) {
    const bars = [...m.bars].sort((a, b) => a[0] - b[0]), k = m.track, inverse = m.usdAt !== undefined && m.usdAt > 0;
    if (bars.length) first = Math.min(first, bars[0]![0] + MINUTE);
    for (let i = 1; i < bars.length; i++) if (bars[i]![0] - bars[i - 1]![0] <= OI_GAP_MS) covered.push([bars[i - 1]![0] + MINUTE, bars[i]![0] + MINUTE]);
    const last = k ? k.priceAt(Math.floor(to / 1000) - 1) : NaN, price = inverse ? m.usdAt! : Number.isFinite(last) && last > 0 ? last : mark;
    const { intervals, skipped } = oiIntervals(bars, from, to);
    unplaced += skipped * price;
    for (const iv of intervals) {
      // The market's volume in each minute of the interval: where the change is put, and how much of it.
      const minutes: [number, number][] = [];
      let total = 0;
      for (let t = iv.from; t < iv.to; t += MINUTE) {
        const s = t / 1000, g = k && k.first !== null && k.first <= s - 1 ? k.cumGross(s + 59) - k.cumGross(s - 1) : 0;
        if (g > 0) { minutes.push([t, g]); total += g; }
      }
      if (!(total > 0)) { unplaced += iv.amount * price; continue; }
      for (const [t, g] of minutes) {
        const at = inverse ? m.usdAt! : k!.priceAt(t / 1000 + 59);
        parts.push({ t, usd: iv.amount * g / total * (Number.isFinite(at) && at > 0 ? at : price) });
      }
    }
  }
  return { parts, covered, unplaced, first };
}

/**
 * Open interest by time: in each bucket the parts that added to it (bid colour) and those that took from it (ask colour), added up apart,
 * never netted, and never called buying or selling. A bucket no reading stands for has no data (`covered`); one before the first, no history.
 */
export function oiRows(steps: readonly OiStep[], covered: readonly [number, number][], from: number, to: number, step: number, first = Infinity): TimeRows {
  const rows = emptyRows(from, to, step, 'noReading');
  for (const [a, b] of covered) {
    if (b <= from || a >= to) continue;
    for (let i = Math.max(0, Math.floor(Math.max(a, from) / step) - rows.bin0), end = Math.min(rows.gaps.length - 1, Math.floor((Math.min(b, to) - 1) / step) - rows.bin0); i <= end; i++) rows.gaps[i] = null;
  }
  for (const s of steps) {
    if (s.t < from || s.t >= to || !Number.isFinite(s.usd)) continue;
    const i = Math.floor(s.t / step) - rows.bin0;
    rows.gaps[i] = null;
    if (s.usd > 0) rows.buy[i]! += s.usd; else rows.sell[i]! -= s.usd;
  }
  for (let i = 0; i < rows.gaps.length; i++) if (rows.gaps[i] && bucketSpan(rows, i)[1] <= first) rows.gaps[i] = 'noHistory';
  return finish(rows);
}

/** One event with a time, a side (0: the first side, bid colour; 1: the second, ask colour) and a size in USD. */
export interface TimeEvent { t: number; side: 0 | 1; usd: number }

/**
 * Events by time (liquidations, absorption marks): each bucket's two sides added up. `cover` is the stretch the page holds them for: a bucket
 * outside it is not loaded, one inside it with nothing in it a zero.
 */
export function eventRows(events: Iterable<TimeEvent>, from: number, to: number, step: number, cover: { from: number; to: number } | null): TimeRows {
  const rows = emptyRows(from, to, step, null);
  for (const e of events) {
    if (e.t < from || e.t >= to) continue;
    const i = Math.floor(e.t / step) - rows.bin0;
    if (e.side === 0) rows.buy[i]! += e.usd; else rows.sell[i]! += e.usd;
  }
  for (let i = 0; i < rows.gaps.length; i++) {
    const [a, b] = bucketSpan(rows, i);
    if (!cover || b <= cover.from || a >= cover.to) { rows.gaps[i] = 'notLoaded'; rows.buy[i] = 0; rows.sell[i] = 0; }
  }
  return finish(rows);
}

/** The point of control and the value area as buckets: the busiest, and the first and last of the run around it holding `share`. */
export interface TimeLevels { poc: number; lo: number; hi: number }

/** The value area by time, read as the column reads it by price (`valueArea`: from the busiest bucket out, the bigger neighbour first). */
export function timeLevels(rows: TimeRows, share: number): TimeLevels | null {
  if (!(rows.total > 0)) return null;
  const volumes = new Float64Array(rows.buy.length);
  for (let i = 0; i < volumes.length; i++) volumes[i] = rows.buy[i]! + rows.sell[i]!;
  return valueArea(volumes, share);
}

/** The bucket under a time, or -1 outside the rows. */
export function bucketAt(rows: TimeRows, t: number): number {
  if (t < rows.from || t >= rows.to) return -1;
  const i = Math.floor(t / rows.step) - rows.bin0;
  return i >= 0 && i < rows.buy.length ? i : -1;
}

const two = (n: number): string => String(n).padStart(2, '0');
/** A time as the page says it, to the second for buckets under a minute, with the date when it is not today or the buckets are days. */
export function timeText(at: number, step: number, now: number): string {
  const text = clock(at, step >= DAY || at < startOfDay(now));
  return step < MINUTE ? `${text}:${two(new Date(at).getSeconds())}` : text;
}

/** A bucket's length in words: 15 s, 5 min, 4 h (a day as 24 h). */
export function lengthText(step: number): string {
  return step < MINUTE ? t('{n} s', { n: step / SECOND }) : step < HOUR ? t('{n} min', { n: step / MINUTE }) : t('{n} h', { n: step / HOUR });
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / MINUTE));

/** Why a bucket has no data, in words. */
export function gapText(gap: TimeGap): string {
  switch (gap) {
    case 'notRecorded': return t('No flow is recorded for this stretch.');
    case 'quietGap': return t('No trade on any of the markets for ten minutes or more: taken as not recorded, not as zero.');
    case 'noReading': return t('No open-interest reading in this stretch.');
    case 'noHistory': return t('The open-interest readings held do not reach this far back.');
    default: return t('Nothing is held for this stretch yet.');
  }
}

/**
 * What the box of a bucket needs beside the rows: the measure and its words by time (the registry's `timeWords`, handed in so this module
 * stays below the registry the measures' files import it from), how often open interest is read, the value area, and the page's clock.
 */
export interface TimeBoxContext { metric: ProfileMetric; words: ColumnWords; spacingMs: number; levels: TimeLevels | null; now: number }

/**
 * The box for bucket `i`: its time span, then the body every row of the column has (its two sides, their difference, its share, where it
 * stands against the point of control and the value area, how far back the recording goes), or why it has no data.
 */
export function timeLines(rows: TimeRows, i: number, c: TimeBoxContext): InfoLine[] {
  const [a, b] = bucketSpan(rows, i), gap = rows.gaps[i];
  const open = (rows.bin0 + i + 1) * rows.step > c.now;
  const lines: InfoLine[] = [{ text: `${timeText(a, rows.step, c.now)} – ${timeText(b, rows.step, c.now)}${open ? ` · ${t('under way')}` : ''}`, bold: true }];
  if (gap) { lines.push({ text: gapText(gap), color: 'muted', wrap: true }); return lines; }
  const l = c.levels, where = !l ? null : i === l.poc ? t('Point of control') : i >= l.lo && i <= l.hi ? t('In the value area') : i < l.lo ? t('Before the value area') : t('After the value area');
  lines.push(...rowBody(rows, i, c.words, where));
  if (c.metric === 'oi' && c.spacingMs > MINUTE) lines.push({ text: t('Open interest is read about every {n} min here: a change between readings is spread over the minutes in between by their volume, as the column spreads it over prices.', { n: minutes(c.spacingMs) }), color: 'muted', wrap: true });
  return lines;
}

/**
 * The usual time between open-interest readings: each market's median step between its bars, the coarsest market's (ms; 0 when unknown).
 * Most venues keep five-minute history, so buckets finer than that are mostly empty: the caption says so. Reads at most the newest 400 steps.
 */
export function readingSpacing(series: readonly (readonly OiBar[])[]): number {
  let coarsest = 0;
  for (const bars of series) {
    const from = Math.max(1, bars.length - 400), steps: number[] = [];
    for (let i = from; i < bars.length; i++) { const d = bars[i]![0] - bars[i - 1]![0]; if (d > 0) steps.push(d); }
    if (!steps.length) continue;
    steps.sort((a, b) => a - b);
    coarsest = Math.max(coarsest, steps[Math.floor(steps.length / 2)]!);
  }
  return coarsest;
}

/**
 * The words at the band's foot: the bucket length, said apart when the data, not the zoom, sets it (or the zoom is past the finest), and
 * for open interest how often it is read when that is coarser than a bucket.
 */
export function bandCaption(step: number, limit: BucketLimit, metric: ProfileMetric, spacingMs: number): string {
  const size = lengthText(step);
  const head = limit === 'finest' ? t('Bars of {size}, the finest there are', { size })
    : limit === 'data' ? (metric === 'oi' ? t('Bars of {size}, the finest open interest is read at', { size }) : t('Bars of {size}, the finest the flow is held at here', { size }))
    : t('Bars of {size}', { size });
  return metric === 'oi' && spacingMs > step ? `${head} · ${t('readings about every {n} min', { n: minutes(spacingMs) })}` : head;
}

/** The volume strip's height along the bottom of the map (`#paintVolume` in heat-pane.ts), which the band at the top keeps clear of. */
/** The volume strip's height along the bottom of the map (heat-pane.ts `#paintVolume`), which the bands along the top keep clear of. */
export const volumeBand = (ph: number): number => Math.max(34, Math.min(ph * 0.17, 150));
/** Space between the band and what is above it. */
export const BAND_GAP = 6;
/** The band's height on a tall map: the column's width (TRADED_W in heat-pane.ts), so the profile reads the same either way it lies. */
export const BAND_H = 96;

/**
 * Where the band goes: under the legend plate and the map's corner buttons (Go to, Select, Recenter), whichever reaches lower, measured each
 * frame since the legend grows a line for a price history note; the column's width tall, a fifth of the map at most on a short one, and
 * never down into the volume strip. Null when the map is too short for it.
 */
export function stripBand(o: BandPlace): { top: number; height: number } | null {
  const top = bandTop(o), height = Math.floor(Math.min(BAND_H, Math.max(36, o.ph * 0.2), bandFloor(o) - top));
  return height >= MIN_BAND_H ? { top, height } : null;
}

/** What a band is placed by: the bottoms of the legend plate and the corner buttons, the plot's height, and whether the volume strip is drawn. */
export interface BandPlace { legendBottom: number; toolsBottom: number; ph: number; volume: boolean }
/** A band lower than this is a sliver: none is drawn. */
const MIN_BAND_H = 32;
const bandTop = (o: BandPlace): number => Math.ceil(Math.max(o.legendBottom, o.toolsBottom) + BAND_GAP);
const bandFloor = (o: BandPlace): number => o.ph - (o.volume ? volumeBand(o.ph) + 6 : 0) - 24;
/** Each band's height when one, two or three stack: shorter the more there are, so the chart keeps its height. */
export const STACK_H: readonly number[] = [BAND_H, 70, 56];
/** Space between stacked bands, so each one's edges read as its own. */
export const STACK_GAP = 3;
/** The share of the plot's height the bands may take together. */
export const BANDS_SHARE = 0.25;

/**
 * Where `count` bands go, from the top down: one as `stripBand` places it; two or three stacked under it, each `STACK_H` tall at most and
 * all of them a quarter of the plot at most, never down into the volume strip. Fewer when they would be slivers, and none when even one
 * would be: the caller says what was left out.
 */
export function stackedBands(o: BandPlace, count: number): { top: number; height: number }[] {
  const one = stripBand(o);
  if (count < 1 || !one) return [];
  const top = bandTop(o), room = Math.min(o.ph * BANDS_SHARE, bandFloor(o) - top);
  for (let n = Math.min(count, STACK_H.length); n >= 2; n--) {
    const height = Math.floor(Math.min(STACK_H[n - 1]!, (room - (n - 1) * STACK_GAP) / n));
    if (height >= MIN_BAND_H) return Array.from({ length: n }, (_, i) => ({ top: top + i * (height + STACK_GAP), height }));
  }
  // One band as `stripBand` places it, no taller than the quarter the bands may take, and none if that leaves a sliver.
  const height = Math.min(one.height, Math.floor(room));
  return height >= MIN_BAND_H ? [{ top: one.top, height }] : [];
}
