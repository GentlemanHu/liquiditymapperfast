import { PROFILE_METRICS, isMetric, type ProfileMetric } from '../measures/registry.ts';

/**
 * Where each measure's profile is drawn (Karl, 2026-10-20: "users should be able to completely personalise the location: top, right side
 * or left side ... not just for open interest but absorption, liquidations and possibly more"). A profile instance is one measure in one
 * place: a column right of the map (beside the book profile), a column left of it (between the flow column and the map, mirrored so both
 * sides face the chart), or a band along the top. The places a measure can go and the measures there are come from the registry
 * (measures/registry.ts), so a measure added there can go anywhere.
 *
 * Version 1 keeps one instance a measure and place, over what is on the chart, sized by the page and in the panel's shared look; the fields
 * for a window, a size and a style of its own are stored already so a later version can fill them without another migration. An instance's
 * id is given once and never changes; one switched off keeps its id and order, so switching it on again finds it as it was.
 */
export type ProfilePlacement = 'right' | 'left' | 'top';
export const PLACEMENTS: readonly ProfilePlacement[] = ['right', 'left', 'top'];

/** What an instance may one day set apart from the panel's shared look (version 1: nothing). */
export interface ProfileStyle { bars: 'split' | 'delta'; emphasis: boolean; valueArea: boolean; share: number }

export interface ProfileInstance {
  id: string;
  enabled: boolean;
  metric: ProfileMetric;
  placement: ProfilePlacement;
  /** Its place among the instances of its edge, increasing outward from the plot (version 1: the measure's place in the registry). */
  order: number;
  /** What it adds up (version 1: what is on the chart). */
  window: { kind: 'chart' };
  /** Its width or height in pixels; null: the page's (version 1: always). */
  sizePx: number | null;
  /** Its look apart from the shared one (version 1: none). */
  overrides: Partial<ProfileStyle>;
}

/** The instances, with the version of the rules they were written under. */
export interface ProfileSet { version: 1; instances: ProfileInstance[] }
export const PROFILE_SET_VERSION = 1;

/** The id an instance is given when it is made: one a measure and place in version 1, so the same choice always has the same id. */
export const instanceId = (metric: ProfileMetric, placement: ProfilePlacement): string => `${metric}:${placement}`;

/** A new instance: the measure's place in the registry is its order, over what is on the chart, in the shared look. */
export function newInstance(metric: ProfileMetric, placement: ProfilePlacement, enabled = true): ProfileInstance {
  return { id: instanceId(metric, placement), enabled, metric, placement, order: PROFILE_METRICS.indexOf(metric), window: { kind: 'chart' }, sizePx: null, overrides: {} };
}

/** The ordering of an edge: by order, then by the registry, so two instances never tie. */
const byOrder = (a: ProfileInstance, b: ProfileInstance): number => a.order - b.order || PROFILE_METRICS.indexOf(a.metric) - PROFILE_METRICS.indexOf(b.metric);

/** The instances drawn on an edge, nearest the plot first. */
export const placedOn = (set: ProfileSet, placement: ProfilePlacement): ProfileInstance[] => set.instances.filter(p => p.enabled && p.placement === placement).sort(byOrder);
/** Whether a measure is drawn at a place. */
export const isPlaced = (set: ProfileSet, metric: ProfileMetric, placement: ProfilePlacement): boolean => set.instances.some(p => p.enabled && p.metric === metric && p.placement === placement);
/** Whether a measure is drawn anywhere. */
export const anyPlaced = (set: ProfileSet, metric: ProfileMetric): boolean => set.instances.some(p => p.enabled && p.metric === metric);
/** Whether a measure is drawn by price (right or left of the map). */
export const onPriceAxis = (set: ProfileSet, metric: ProfileMetric): boolean => isPlaced(set, metric, 'right') || isPlaced(set, metric, 'left');
/** The measures drawn by price, each once whether it is on one side or both, in the registry's order: what is asked by price. */
export const priceMetrics = (set: ProfileSet): ProfileMetric[] => PROFILE_METRICS.filter(m => onPriceAxis(set, m));

/**
 * The measure the lines across the chart are read from: traded volume wherever it is drawn by price, else the first measure drawn by price
 * (by order, the right side before the left on a tie), else traded volume, asked for the lines alone. It never follows the screen's room, so a
 * narrow map cannot change whose lines they are, and the panel names the measure whenever it is not traded volume.
 */
export function lineMetric(set: ProfileSet): ProfileMetric {
  if (onPriceAxis(set, 'volume')) return 'volume';
  const side = set.instances.filter(p => p.enabled && p.placement !== 'top').sort((a, b) => byOrder(a, b) || (a.placement === 'right' ? -1 : 1));
  return side[0]?.metric ?? 'volume';
}

/** A measure switched on or off at a place: an instance it had is switched (keeping its id and order), one it had not is made. */
export function setPlaced(set: ProfileSet, metric: ProfileMetric, placement: ProfilePlacement, on: boolean): ProfileSet {
  const had = set.instances.some(p => p.metric === metric && p.placement === placement);
  const instances = had ? set.instances.map(p => p.metric === metric && p.placement === placement ? { ...p, enabled: on } : p)
    : on ? [...set.instances, newInstance(metric, placement)] : set.instances;
  return { version: 1, instances };
}

/** The set an older save's choices make: each measure it had a column for a column right of the map, and its profile along the top as it was. */
export function setFromLegacy(metrics: readonly ProfileMetric[], top: { on: boolean; metric: ProfileMetric }): ProfileSet {
  return { version: 1, instances: [...metrics.map(m => newInstance(m, 'right')), newInstance(top.metric, 'top', top.on)] };
}

/**
 * The first visit's: traded volume right of the map, and along the top switched off (Karl, 2026-10-28: the band repeats the volume bars
 * along the bottom and covers the top of the map; the instance is kept, so its Top cell finds it as it was).
 */
export const defaultSet = (): ProfileSet => setFromLegacy(['volume'], { on: false, metric: 'volume' });

const ID = /^[\w:.-]{1,40}$/;
/**
 * A stored set, checked instance by instance: one this page cannot read (an unknown measure or place) is dropped, a second instance of a
 * measure and place is dropped (version 1 keeps one), a missing or repeated id becomes the instance's own, and what version 1 does not offer
 * (another window, a size, a look of its own) is put back to the shared one. Null when there is nothing to read, so the caller falls back.
 */
export function readProfileSet(saved: unknown): ProfileSet | null {
  if (!saved || typeof saved !== 'object' || !Array.isArray((saved as { instances?: unknown }).instances)) return null;
  const out: ProfileInstance[] = [], ids = new Set<string>();
  for (const value of (saved as { instances: unknown[] }).instances.slice(0, 64)) {
    const s = value as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || !isMetric(s.metric) || !PLACEMENTS.includes(s.placement as ProfilePlacement)) continue;
    const metric = s.metric, placement = s.placement as ProfilePlacement;
    if (out.some(p => p.metric === metric && p.placement === placement)) continue;
    let id = typeof s.id === 'string' && ID.test(s.id) && !ids.has(s.id) ? s.id : instanceId(metric, placement);
    while (ids.has(id)) id = `${id}x`.slice(-40);
    ids.add(id);
    const order = typeof s.order === 'number' && Number.isFinite(s.order) ? Math.max(0, Math.min(999, Math.round(s.order))) : PROFILE_METRICS.indexOf(metric);
    out.push({ id, enabled: s.enabled !== false, metric, placement, order, window: { kind: 'chart' }, sizePx: null, overrides: {} });
  }
  return { version: 1, instances: out };
}

/** The set with its profile along the top switched on: an instance there that is off is switched on, the first by order, or one of traded volume made. */
export function withTopOn(set: ProfileSet): ProfileSet {
  if (placedOn(set, 'top').length) return set;
  const off = set.instances.filter(p => p.placement === 'top').sort(byOrder)[0];
  return setPlaced(set, off?.metric ?? 'volume', 'top', true);
}
