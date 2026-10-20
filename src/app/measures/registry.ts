import type { ColumnWords, TradedRows } from '../traded.ts';
import type { MeasureDef, MetricFlags } from './measure.ts';
import { VOLUME } from './defs/volume.ts';
import { OI } from './defs/oi.ts';
import { ABSORPTION } from './defs/absorption.ts';
import { LIQUIDATIONS } from './defs/liquidations.ts';

/**
 * The measures a profile can draw, in the order they are listed and placed (nearest the map first): traded volume, the change in open
 * interest, absorption, liquidations. Each is one file under measures/defs/ (measure.ts says what a registration holds); a measure added
 * here is a row of the panel's grid and can be drawn right or left of the map and along the top, with nothing else to change.
 */
export const MEASURES = [VOLUME, OI, ABSORPTION, LIQUIDATIONS] as const;

/** A measure's id: what a profile instance names it by in storage. */
export type ProfileMetric = (typeof MEASURES)[number]['id'];
export const PROFILE_METRICS: readonly ProfileMetric[] = MEASURES.map(m => m.id);

const BY_ID = new Map<string, MeasureDef<ProfileMetric>>(MEASURES.map(m => [m.id, m]));
/** A measure's registration. */
export const measureDef = (id: ProfileMetric): MeasureDef<ProfileMetric> => BY_ID.get(id)!;
/** Whether a stored value names a measure this page knows. */
export const isMetric = (value: unknown): value is ProfileMetric => typeof value === 'string' && BY_ID.has(value);

/** What a measure's rows' two sides are called by price, and its header's lines (the registration's, for callers that hold only the id). */
export const metricWords = (metric: ProfileMetric): ColumnWords => measureDef(metric).words();
export const metricHeader = (metric: ProfileMetric, rows: TradedRows | null, flags: MetricFlags): { head: string; sub: string; warn: boolean } => measureDef(metric).header(rows, flags);
/** What a measure's stretches of time are called, with what an empty one is called (the column's words are about prices). */
export const timeWords = (metric: ProfileMetric): ColumnWords => ({ ...metricWords(metric), none: measureDef(metric).stretchNone() });

export type { MetricFlags } from './measure.ts';
