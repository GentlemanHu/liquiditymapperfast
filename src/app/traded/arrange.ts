import { placedOn, type ProfileInstance, type ProfileSet } from './profiles.ts';
import { stackedBands, type BandPlace } from '../measures/model.ts';

/**
 * Where the profiles go on the screen, from the instances switched on and the room there is (pure, tested): the columns right and left of
 * the map, and the bands along the top. Nothing switched on is ever dropped without a word: what does not fit stays switched on and is
 * listed as hidden, for the panel to say and the map to mark.
 */

/** A band along the top: where it is (CSS px from the top of the map) and the instance it draws. */
export interface PlacedBand { instance: ProfileInstance; top: number; height: number }

export interface Arranged {
  /** The columns drawn right of the map and left of it, nearest the map first. */
  right: ProfileInstance[]; left: ProfileInstance[];
  /** The bands drawn along the top, from the top edge down (the one nearest the chart, first by order, is the lowest). */
  top: PlacedBand[];
  /** Switched on and not drawn for want of room, outermost last. */
  hidden: ProfileInstance[];
}

/**
 * The room there is: how many columns fit beside the map, both sides together (the map keeps at least half the pane's width; none on a
 * phone), how many bands may stack (three; one on a phone, as before), and where the bands go (null before the map has been drawn: then as
 * many as may stack are taken to fit).
 */
export interface ProfileRoom { sides: number; maxBands: number; band: BandPlace | null }

/** Most bands that stack along the top. */
export const MAX_BANDS = 3;

/**
 * The columns that fit, both sides together: nearest the map first on each side, taken in turns (the right side's first on a tie, where
 * the columns have always been), so the outermost column of the fuller side goes first when room runs out.
 */
export function arrangeSides(set: ProfileSet, fit: number): { right: ProfileInstance[]; left: ProfileInstance[]; hidden: ProfileInstance[] } {
  const right = placedOn(set, 'right'), left = placedOn(set, 'left'), turns: [ProfileInstance, 'right' | 'left'][] = [];
  for (let i = 0; i < Math.max(right.length, left.length); i++) { if (right[i]) turns.push([right[i]!, 'right']); if (left[i]) turns.push([left[i]!, 'left']); }
  const kept = turns.slice(0, Math.max(0, fit)), shown = new Set(kept.map(([p]) => p));
  return { right: right.filter(p => shown.has(p)), left: left.filter(p => shown.has(p)), hidden: turns.slice(kept.length).map(([p]) => p) };
}

/**
 * The column under `x` in the plot's coordinates (the mirrored hit test): right of the map from `rightX0`, each `w` wide, nearest the map
 * first; left of it at negative x, the first against the map's left edge (from −w to 0) and the others outward. Null off the columns.
 */
export function columnHit(x: number, rightX0: number, right: number, left: number, w: number): { side: 'right' | 'left'; i: number } | null {
  if (!(w > 0)) return null;
  if (right > 0 && x > rightX0 && x <= rightX0 + right * w) return { side: 'right', i: Math.min(right - 1, Math.ceil((x - rightX0) / w) - 1) };
  if (left > 0 && x < 0 && x >= -left * w) return { side: 'left', i: Math.min(left - 1, Math.floor(-x / w)) };
  return null;
}

/** Everything switched on, placed in the room there is. */
export function arrangeProfiles(set: ProfileSet, room: ProfileRoom): Arranged {
  const sides = arrangeSides(set, room.sides), wanted = placedOn(set, 'top'), ask = Math.min(wanted.length, room.maxBands, MAX_BANDS);
  const bands = room.band ? stackedBands(room.band, ask) : Array.from({ length: ask }, () => ({ top: 0, height: 0 }));
  // The band nearest the chart (first by order) is the lowest; the outermost, under the legend.
  const drawn = wanted.slice(0, bands.length);
  const top = drawn.map((instance, i) => ({ instance, ...bands[bands.length - 1 - i]! })).reverse();
  return { right: sides.right, left: sides.left, top, hidden: [...sides.hidden, ...wanted.slice(drawn.length)] };
}
