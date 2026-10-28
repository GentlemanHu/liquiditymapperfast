import type { BarInputs } from './inputs.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { OptionValue } from './records.ts';

/** The messages between the page and the script worker, and what a run answers for each script. */

/** One script to run: its text, the values set for its options, and the version of the language it was written for. */
export interface ScriptJob { id: string; source: string; options: Record<string, OptionValue>; api: number }
export interface RunRequest { t: 'run'; seq: number; jobs: ScriptJob[]; inputs: BarInputs }
/** A run's answer, or the worker saying it has loaded and can take runs (sent once, first). */
export type RunResponse = { t: 'result'; seq: number; results: ScriptResult[] } | { t: 'ready' };

/**
 * What a plot draws: a line, an area under a line, bars, a line with a baseline, candles or bars of four prices, a band between two lines, or
 * marks (a label or a shape at a value, with a text to read when the pointer is on it).
 */
export type PlotKind = 'line' | 'area' | 'histogram' | 'baseline' | 'candlestick' | 'bar' | 'cloudarea' | 'brokenarea' | 'mark';

/** The numbers each kind of plot holds per candle. */
export const PLOT_FIELDS: Readonly<Record<PlotKind, readonly string[]>> = {
  line: ['value'], area: ['value'], histogram: ['value'], baseline: ['value'],
  candlestick: ['open', 'high', 'low', 'close'], bar: ['open', 'high', 'low', 'close'],
  cloudarea: ['lowerValue', 'higherValue'], brokenarea: ['lowerValue', 'higherValue'],
  mark: ['value'],
};

/** The longest text a mark shows on the chart, and the longest it says when the pointer is on it. */
export const MARK_TEXT = 24, MARK_TIP = 600;

/**
 * One plot of a script over every candle: NaN where it has no point; `colors[i]` a colour the script gave candle i ('' for the plot's own).
 * A mark also has `texts[i]`, what it shows at candle i, and `tips[i]`, what it says there when the pointer is on it ('' for none).
 */
export interface PlotOut {
  kind: PlotKind;
  title: string;
  /** Its style: the named arguments of its call and the script's options for it (colours, line width, ...). */
  style: Record<string, OptionValue>;
  fields: Record<string, Float64Array>;
  colors: string[] | null;
  texts?: string[] | null;
  tips?: string[] | null;
}

/** The sounds a script's alert can make (`alert(text, sound=...)`); `none` is an alert with no sound, kept in the list. */
export const ALERT_SOUNDS = ['chime', 'rise', 'fall', 'tick', 'none'] as const;
export type AlertSound = typeof ALERT_SOUNDS[number];
/** The most alerts a run hands back for one candle, and the longest text of one. */
export const MAX_ALERTS = 16, ALERT_TEXT = 160;

/**
 * An `alert(...)` the script made at one of the newest candles (the one under way and the last one closed; older ones are history and are
 * never handed back): the call's place in the text, the candle's start (ms), its text and sound, and when it is meant to sound: `bar` as soon
 * as it is made during the candle, `close` once the candle has closed with it made. `forming` is whether its candle was under way.
 */
export interface AlertOut { site: number; t: number; text: string; sound: AlertSound; when: 'bar' | 'close'; forming: boolean }

/** An option a script declares (`option(...)`), for the panel to show. */
export interface OptionDecl { name: string; type: 'number' | 'color' | 'text' | 'boolean' | 'list' | 'range'; value: OptionValue; label?: string; min?: number; max?: number; step?: number; choices?: OptionValue[] }

export interface Warning { code: string; detail?: string }

export type ScriptResult =
  | { id: string; ok: true; plots: PlotOut[]; warnings: Warning[]; steps: number; ms: number; candleColors?: string[]; alerts?: AlertOut[] }
  | { id: string; ok: false; error: ScriptError };

/** A plot's newest values: its fields at the last of its first `upTo` candles where any of them is a number ([NaN] for a plot that drew none). */
export function newestOf(p: PlotOut, upTo = Infinity): number[] {
  const fields = PLOT_FIELDS[p.kind];
  let i = Math.min(p.fields[fields[0]!]?.length ?? 0, upTo) - 1;
  while (i >= 0 && !fields.some(f => Number.isFinite(p.fields[f]?.[i] ?? NaN))) i--;
  return i >= 0 ? fields.map(f => p.fields[f]?.[i] ?? NaN) : [NaN];
}
