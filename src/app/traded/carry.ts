import type { ValueLevels } from '../../shared/profile.ts';
import type { ProfileWindow } from './sessions.ts';

/**
 * The previous period's levels carried across the one under way (Karl, 2026-10-25, from the contract of his own hybrid volume profile indicator: for each lane the developing
 * profile and the immediately previous completed one, and only that one's selected levels carried into the current period). Pairing is pure
 * and works on the whole calendar of a series, before any gate (how many are shown, how far back the recording reaches, whether a window is
 * covered enough to draw): a predecessor that fails a gate is then no carry at all, and an older window is never put in its place.
 */

/** A window's series: its key without the start (`day|UTC`, `week|UTC`, `month|UTC`, `session|<id>`). Each session definition is a series of its own. */
export const seriesOf = (w: Pick<ProfileWindow, 'key'>): string => w.key.slice(0, w.key.lastIndexOf('|'));

/** A window under way and the window of its series just before it, whose levels are carried across it. */
export interface Carry { source: ProfileWindow; current: ProfileWindow }

/**
 * The carries at `now` in `windows`, which must hold every window of each series around now (not truncated to the few shown, not filtered by
 * what a source can still work out): per series the window under way (`from <= now < to`) and its immediate predecessor, the window of the
 * same series just before it. Days, weeks and months follow one another without a gap, so a predecessor that does not end where the current
 * one begins is not the immediate one (the calendar was cut there) and there is no carry. A session's predecessor is the previous one of the
 * same definition (a Monday to Friday session on a Monday: Friday's), never overlapping it. Between two sessions nothing is under way and
 * nothing is carried. A series whose current window is the oldest held has no predecessor and no carry.
 */
export function carryPairs(windows: readonly ProfileWindow[], now: number): Carry[] {
  const groups = new Map<string, ProfileWindow[]>();
  for (const w of windows) { const key = seriesOf(w), list = groups.get(key); if (list) list.push(w); else groups.set(key, [w]); }
  const out: Carry[] = [];
  for (const [series, list] of groups) {
    list.sort((a, b) => a.from - b.from);
    let i = list.length - 1;
    while (i >= 0 && list[i]!.from > now) i--;
    const current = list[i];
    if (!current || !(current.to > now) || i < 1) continue;
    const source = list[i - 1]!, session = series.startsWith('session|');
    if (source.to > current.from || (!session && source.to !== current.from)) continue;
    out.push({ source, current });
  }
  return out.sort((a, b) => a.current.from - b.current.from || a.current.key.localeCompare(b.current.key));
}

/**
 * The stretches of a source's untouched run (dotted, from `from` to `to`) still drawn beside its carry, which draws that level over `hide`
 * (the window under way): the run is hidden only there, so the gap before a session that began later, and what is left of the run past the
 * window's end, keep their dots. Any coordinate, as long as the three are in the same one.
 */
export function runPieces(from: number, to: number, hide: { from: number; to: number } | null): [number, number][] {
  if (!(to > from)) return [];
  if (!hide) return [[from, to]];
  const out: [number, number][] = [], before = Math.min(to, hide.from), after = Math.max(from, hide.to);
  if (before > from) out.push([from, before]);
  if (to > after) out.push([after, to]);
  return out;
}

/** One carried line, as the time it is drawn over and the price: a level of the source across the whole of the window under way. */
export interface CarriedLine { what: 'poc' | 'vah' | 'val'; price: number; from: number; to: number }

/**
 * The lines a carry draws: the source's point of control and value area edges (as the lines' own switches choose) from the start of the window
 * under way to its end, the same whether or not price has traded through them since: the level is a fact about the period that is over, and it
 * is the reference the period under way is read against. The levels are the source's own, with whatever coverage it needed to be drawn at all.
 */
export function carriedLines(levels: ValueLevels, over: { from: number; to: number }, want: { poc: boolean; va: boolean }): CarriedLine[] {
  const out: CarriedLine[] = [];
  if (want.va) out.push({ what: 'vah', price: levels.vah, from: over.from, to: over.to }, { what: 'val', price: levels.val, from: over.from, to: over.to });
  if (want.poc) out.push({ what: 'poc', price: levels.poc, from: over.from, to: over.to });
  return out;
}

/**
 * How strongly the lines and profiles of a window are drawn by how many of its series came after it among those shown (0 for the newest): the
 * two newest in full, then a tenth less for each one further back down to `AGE_FLOOR`, so the newest read first and none disappears. Names
 * fade no further than `LABEL_FLOOR` (a name is read, a line is seen), and the backing under a profile's bars is not faded at all.
 */
export const AGE_STEP = 0.1, AGE_FLOOR = 0.6, LABEL_FLOOR = 0.85;
export const ageAlpha = (rank: number): number => rank <= 1 ? 1 : Math.max(AGE_FLOOR, 1 - AGE_STEP * (rank - 1));

/** The age rank of each window by key: the number of windows of its series that begin after it in `windows`. */
export function ageRanks(windows: readonly ProfileWindow[]): Map<string, number> {
  const bySeries = new Map<string, ProfileWindow[]>();
  for (const w of windows) { const key = seriesOf(w), list = bySeries.get(key); if (list) list.push(w); else bySeries.set(key, [w]); }
  const ranks = new Map<string, number>();
  for (const list of bySeries.values()) {
    list.sort((a, b) => b.from - a.from);
    list.forEach((w, rank) => ranks.set(w.key, rank));
  }
  return ranks;
}
