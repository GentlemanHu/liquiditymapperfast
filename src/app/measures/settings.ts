/**
 * The measure strip along the top of the map (measures/strip.ts): whether it shows, and which measure. The switch and the choice are kept
 * apart, so switching the strip off and on again (its lamp button) keeps the measure chosen in its panel.
 */
export type MeasureKind = 'delta' | 'oi';
export interface MeasureStripSettings { on: boolean; kind: MeasureKind }

export const MEASURE_STRIP_DEFAULTS: Readonly<MeasureStripSettings> = Object.freeze({ on: false, kind: 'delta' });

/** A saved strip, field by field. A save from before the strip existed has none and reads as off, on a desktop and a phone alike. */
export function readMeasureStrip(saved: unknown): MeasureStripSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof MeasureStripSettings, unknown>>;
  return { on: s.on === true, kind: s.kind === 'oi' ? 'oi' : 'delta' };
}
