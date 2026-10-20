import { candleBody, footprintLayout } from '../panes/footprint.ts';
import { anomalies, type HighlightOptions } from '../anomaly.ts';
import type { CandleFlow } from '../delta/candles.ts';
import { coinText } from '../delta/nlns.ts';
import type { OiBar } from '../store.ts';
import type { InfoLine } from '../infobox.ts';
import { clock, usd } from '../format.ts';
import { t } from '../i18n.ts';
import type { MeasureKind } from './settings.ts';

/**
 * The measure strip's numbers and words, with no canvas: one value per candle of the chart's timeframe (each candle's delta, or its change of
 * open interest), why a candle has none, what stands out, where the band goes and where each bar stands. The profile columns beside the map
 * show measures by price; this shows them by time, as the volume bars along the bottom do.
 */

/**
 * Why a candle has no value. A candle with no data is never drawn or read as a zero: `notRecorded`, no market held flow when it began (the
 * Delta pane leaves it out too); `quietGap`, inside a stretch of ten minutes or more with no trade on any of the markets, which the Delta
 * pane takes as not recorded; `noReading`, no new open-interest reading in it; `noHistory`, before the first change the readings held give.
 */
export type Gap = 'notRecorded' | 'quietGap' | 'noReading' | 'noHistory';

export interface StripSeries {
  kind: MeasureKind;
  tfMs: number;
  /** Candle starts, oldest first, one timeframe apart. */
  starts: readonly number[];
  /** Each candle's value (delta in USD, open interest in coins), NaN where it has none. */
  values: Float64Array;
  gaps: readonly (Gap | null)[];
  /** What stands out (anomaly.ts on the size of each value, the rule every pane uses), and by how many standard deviations. */
  flag: Uint8Array;
  sigma: Float64Array;
}

/** Each candle's delta from the Delta pane's flows (delta/flows.ts): `raw` before, `flows` after a long quiet stretch is left out. */
export function deltaSeries(starts: readonly number[], raw: readonly (CandleFlow | null)[], flows: readonly (CandleFlow | null)[], tfMs: number, highlight: HighlightOptions): StripSeries {
  const values = new Float64Array(starts.length).fill(NaN), gaps: (Gap | null)[] = new Array<Gap | null>(starts.length).fill(null);
  for (let i = 0; i < starts.length; i++) {
    const f = flows[i];
    if (f) values[i] = f.delta; else gaps[i] = raw[i] ? 'quietGap' : 'notRecorded';
  }
  return judged('delta', starts, values, gaps, tfMs, highlight);
}

/**
 * Each candle's change of open interest, from the one change per bar every view of it uses (`oiChangeByTime`: a venue's own change, the
 * venues added up; keyed by bar start). A candle the map has no change for had no new reading: it has no value, not a change of zero.
 */
export function oiSeries(starts: readonly number[], change: ReadonlyMap<number, number>, tfMs: number, highlight: HighlightOptions): StripSeries {
  let first = Infinity;
  const byStart = new Map<number, number>();
  for (const [t, d] of change) { const k = Math.floor(t / tfMs) * tfMs; byStart.set(k, (byStart.get(k) ?? 0) + d); if (k < first) first = k; }
  const values = new Float64Array(starts.length).fill(NaN), gaps: (Gap | null)[] = new Array<Gap | null>(starts.length).fill(null);
  for (let i = 0; i < starts.length; i++) {
    const d = byStart.get(starts[i]!);
    if (d !== undefined && Number.isFinite(d)) values[i] = d; else gaps[i] = starts[i]! < first ? 'noHistory' : 'noReading';
  }
  return judged('oi', starts, values, gaps, tfMs, highlight);
}

function judged(kind: MeasureKind, starts: readonly number[], values: Float64Array, gaps: (Gap | null)[], tfMs: number, highlight: HighlightOptions): StripSeries {
  // What stands out is judged on the size of the value, so a large outflow stands out as a large inflow does (the OI pane does the same).
  const found = anomalies(values.map(Math.abs), highlight);
  return { kind, tfMs, starts, values, gaps, flag: found.flag, sigma: found.sigma };
}

/**
 * The usual time between open-interest readings: each market's median step between its bars, the coarsest market's (ms; 0 when unknown).
 * Most venues keep five-minute history, so on a one-minute chart a change lands in the candle of the new reading and the four before it
 * have none: the strip says so instead of drawing what looks like minute precision. Reads at most the newest 400 steps of a market.
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

/** The largest size of a value in view, the one scale above and below zero alike (no percentile clipping, which could hide the largest event). */
export function scaleOf(series: StripSeries, t0: number, t1: number): number {
  let max = 0;
  for (let i = 0; i < series.starts.length; i++) {
    const t = series.starts[i]!, v = series.values[i]!;
    if (t + series.tfMs >= t0 && t <= t1 && Number.isFinite(v)) max = Math.max(max, Math.abs(v));
  }
  return max;
}

/** The candle holding `t`; right of the newest, the newest (a pane's readout stays on its newest point there); left of the first, none (-1). */
export function indexAt(series: StripSeries, t: number): number {
  const n = series.starts.length;
  if (!n) return -1;
  const i = Math.floor((t - series.starts[0]!) / series.tfMs);
  return i < 0 ? -1 : Math.min(n - 1, i);
}

/** The volume strip's height along the bottom of the map (`#paintVolume` in heat-pane.ts), which the band at the top keeps clear of. */
const volumeBand = (ph: number): number => Math.max(34, Math.min(ph * 0.17, 150));
/** Space between the band and what is above it. */
export const STRIP_GAP = 6;

/**
 * Where the band goes: under the legend plate and the map's corner buttons (Go to, Select, Recenter), whichever reaches lower, measured each
 * frame since the legend grows a line for a price history note; at most the volume strip's share of the map's height, a little less; never
 * down into the volume strip or the middle of the map. Null when the map is too short for it.
 */
export function stripBand(o: { legendBottom: number; toolsBottom: number; ph: number; volume: boolean }): { top: number; height: number } | null {
  const top = Math.ceil(Math.max(o.legendBottom, o.toolsBottom) + STRIP_GAP);
  const floor = o.ph - (o.volume ? volumeBand(o.ph) + 6 : 0) - 24;
  const height = Math.floor(Math.min(Math.max(28, Math.min(o.ph * 0.11, 80)), floor - top));
  return height >= 20 ? { top, height } : null;
}

/**
 * Where a candle's bar stands and how wide it is, as the volume bars along the bottom stand: under the candle's body, which slides to the
 * left of its slot as the footprint takes the rest (`narrowing` 0 to 1).
 */
export function barGeometry(t: number, tfMs: number, xOf: (t: number) => number, slot: number, narrowing: number): { x: number; body: number } {
  const layout = footprintLayout(slot), normal = candleBody(slot), body = Math.max(1, normal + (Math.max(1, layout.body) - normal) * narrowing);
  const xClassic = xOf(t + tfMs / 2), x = xClassic + (xOf(t) + layout.candleCenter - xClassic) * narrowing;
  return { x, body };
}

const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;
const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

/** A value with its unit: dollars for the delta, coins for open interest. */
export function valueText(kind: MeasureKind, v: number, coin: string): string { return kind === 'delta' ? signedUsd(v) : coinText(v, coin); }

/** The scale at the band's right edge: the largest size in view, either way. */
export function scaleText(kind: MeasureKind, max: number, coin: string): string { return `±${valueText(kind, max, coin).replace(/^\+/, '')}`; }

/** Whose open interest: the venues added together (and, for one candle, how many of them it counts), or the one market named. */
export function oiScope(parts: number, counted: number | undefined, market: string): string {
  if (parts > 1) return counted !== undefined && counted < parts ? t('{n} of {m} venues', { n: counted, m: parts }) : t('{n} venues added together', { n: parts });
  return market;
}

/** The words at the band's left: which measure, over which markets, and for open interest how often it is read when that is coarser than a candle. */
export function stripCaption(kind: MeasureKind, scope: string, spacingMs: number, tfMs: number): string {
  if (kind === 'delta') return `${t('Delta')} · ${scope}`;
  return `${t('OI change')} · ${scope}${spacingMs > tfMs ? ` · ${t('readings about every {n} min', { n: minutes(spacingMs) })}` : ''}`;
}

export interface StripWords {
  /** The timeframe as the page names it (1m, 1h). */
  timeframe: string;
  /** The markets the measure covers at a candle (open interest added together can count fewer venues at one). */
  scope: (t: number) => string;
  /** The coin open interest is counted in. */
  coin: string;
  /** The usual time between open-interest readings (`readingSpacing`). */
  spacingMs: number;
  /** The page's clock: a candle that has not ended is under way. */
  now: number;
}

/** The popup for candle `i`: its time, its value with its unit or why it has none, what stands out, and which markets it covers. */
export function stripLines(series: StripSeries, i: number, w: StripWords): InfoLine[] {
  const at = series.starts[i]!, v = series.values[i]!, gap = series.gaps[i], tf = series.tfMs, coarse = series.kind === 'oi' && w.spacingMs > tf;
  const open = at + tf > w.now;
  const lines: InfoLine[] = [{ text: `${clock(at, true)} · ${w.timeframe}${open ? ` · ${t('under way')}` : ''}`, bold: true }];
  const name = series.kind === 'delta' ? t('Delta') : t('OI change');
  // The bar's own colours: above zero the bid colour, below it the ask colour.
  if (Number.isFinite(v)) lines.push({ label: name, text: valueText(series.kind, v, w.coin), color: v > 0 ? 'below' : v < 0 ? 'above' : 'text', bold: true });
  else lines.push({ label: name, text: t('no data'), color: 'muted' });
  if (gap === 'notRecorded') lines.push({ text: t('No flow is recorded for this candle.'), color: 'muted', wrap: true });
  else if (gap === 'quietGap') lines.push({ text: t('No trade on any of the markets for ten minutes or more: taken as not recorded, not as zero.'), color: 'muted', wrap: true });
  else if (gap === 'noReading') lines.push({ text: coarse ? t('No new reading in this candle: open interest is read about every {n} min here.', { n: minutes(w.spacingMs) }) : t('No open-interest reading in this candle.'), color: 'muted', wrap: true });
  else if (gap === 'noHistory') lines.push({ text: t('The open-interest readings held do not reach this far back.'), color: 'muted', wrap: true });
  else if (coarse) lines.push({ text: t('The change since the reading before: open interest is read about every {n} min here, so one change can stand for several candles.', { n: minutes(w.spacingMs) }), color: 'muted', wrap: true });
  const z = series.sigma[i]!;
  if (series.flag[i] === 1 && Number.isFinite(z)) lines.push({ text: t('({z}σ above its baseline)', { z: z.toFixed(1) }), color: 'muted' });
  lines.push({ label: t('Markets'), text: w.scope(at), rule: true });
  // An increase is exposure that grew, which a buyer and a seller made together.
  if (series.kind === 'oi') lines.push({ text: t('Up: positions were opened; down: positions were closed. It does not say who bought or sold.'), color: 'muted', wrap: true });
  return lines;
}
