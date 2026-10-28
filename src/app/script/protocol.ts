import type { BarInputs } from './inputs.ts';
import type { ScriptError } from './lang/lexer.ts';
import type { OptionValue } from './records.ts';

/** The messages between the page and the script worker, and what a run answers for each script. */

/** One script to run: its text, the values set for its options, and the version of the language it was written for. */
export interface ScriptJob { id: string; source: string; options: Record<string, OptionValue>; api: number }
export interface RunRequest { t: 'run'; seq: number; jobs: ScriptJob[]; inputs: BarInputs }
/** A run's answer, or the worker saying it has loaded and can take runs (sent once, first). */
export type RunResponse = { t: 'result'; seq: number; results: ScriptResult[] } | { t: 'ready' };

/** What a plot draws: a line, an area under a line, bars, a line with a baseline, candles or bars of four prices, a band between two lines. */
export type PlotKind = 'line' | 'area' | 'histogram' | 'baseline' | 'candlestick' | 'bar' | 'cloudarea' | 'brokenarea';

/** The numbers each kind of plot holds per candle. */
export const PLOT_FIELDS: Readonly<Record<PlotKind, readonly string[]>> = {
  line: ['value'], area: ['value'], histogram: ['value'], baseline: ['value'],
  candlestick: ['open', 'high', 'low', 'close'], bar: ['open', 'high', 'low', 'close'],
  cloudarea: ['lowerValue', 'higherValue'], brokenarea: ['lowerValue', 'higherValue'],
};

/** One plot of a script over every candle: NaN where it has no point; `colors[i]` a colour the script gave candle i ('' for the plot's own). */
export interface PlotOut {
  kind: PlotKind;
  title: string;
  /** Its style: the named arguments of its call and the script's options for it (colours, line width, ...). */
  style: Record<string, OptionValue>;
  fields: Record<string, Float64Array>;
  colors: string[] | null;
}

/** An option a script declares (`option(...)`), for the panel to show. */
export interface OptionDecl { name: string; type: 'number' | 'color' | 'text' | 'boolean' | 'list' | 'range'; value: OptionValue; label?: string; min?: number; max?: number; step?: number; choices?: OptionValue[] }

export interface Warning { code: string; detail?: string }

export type ScriptResult =
  | { id: string; ok: true; plots: PlotOut[]; warnings: Warning[]; steps: number; ms: number; candleColors?: string[] }
  | { id: string; ok: false; error: ScriptError };

/** A plot's newest values: its fields at the last of its first `upTo` candles where any of them is a number ([NaN] for a plot that drew none). */
export function newestOf(p: PlotOut, upTo = Infinity): number[] {
  const fields = PLOT_FIELDS[p.kind];
  let i = Math.min(p.fields[fields[0]!]?.length ?? 0, upTo) - 1;
  while (i >= 0 && !fields.some(f => Number.isFinite(p.fields[f]?.[i] ?? NaN))) i--;
  return i >= 0 ? fields.map(f => p.fields[f]?.[i] ?? NaN) : [NaN];
}
