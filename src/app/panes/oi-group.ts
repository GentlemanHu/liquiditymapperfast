/**
 * The OI pane's candles at the drawn candle length (Karl, 2026-11-22: zoomed out to two months, an hourly chart's change bars were 1,368 bars
 * of under a pixel each). Zoomed out, the map draws longer candles and the Volume strip longer bars (`stripTimeframe`); the OI pane draws its
 * level and change bars in the same candles. A drawn candle's change is the sum of the changes of the chart candles in it, as the bars count
 * them (`oiChangeByTime`: each venue's own change), never the difference of two grouped levels; its level is that of its last chart candle;
 * its NL/NS parts are the sums of theirs (pieces added up, the rule OIF-1 found better than one label per long candle). So the grouped bars
 * add up to the chart candles' bars exactly, and the hover card, the table, the Range summary and Highlights read the same candles the pane
 * draws. Pure: the pane hands over what it worked out per chart candle.
 */
import type { CandleRow, OiBar } from '../store.ts';
import type { NlnsCandle, NlnsKind } from '../delta/nlns.ts';
import { heldOiAt, type OiPart } from '../oi-change.ts';

/**
 * What the OI pane draws zoomed out: the level and the venues' bars as drawn candles, each candle's change, the candles, each venue's own
 * changes with the venues counted and their cohorts (`groupVenues`), what they were grouped from (`fine`) and the drawn candles' length.
 */
export interface OiGrouped {
  oi: OiBar[]; parts: OiPart[]; change: Map<number, number>; candles: CandleRow[];
  venues: GroupedVenues;
  /** How many venues each drawn candle's level is made of (`GroupedVenues.read`), as `oi`: what `sumOi` counts per chart candle. */
  read: number[];
  fine: { oi: readonly OiBar[]; parts: readonly OiPart[]; tfMs: number; candles: readonly CandleRow[] };
  drawnMs: number;
}

/** The start of the drawn candle a time falls in (drawn candles are whole UTC days at most, so they start on the epoch grid). */
export const drawnStart = (t: number, drawnMs: number): number => Math.floor(t / drawnMs) * drawnMs;

/** A level's bars ([start, open, high, low, close], oldest first) as drawn candles: the first's open, the highest high, the lowest low, the last's close. */
export function groupBars(bars: readonly OiBar[], drawnMs: number): OiBar[] {
  const out: OiBar[] = [];
  for (const b of bars) {
    const s = drawnStart(b[0], drawnMs), last = out[out.length - 1];
    if (last && last[0] === s) { last[2] = Math.max(last[2], b[2]); last[3] = Math.min(last[3], b[3]); last[4] = b[4]; }
    else out.push([s, b[1], b[2], b[3], b[4]]);
  }
  return out;
}

/** Each venue's bars as drawn candles (for the venues counted, the table and the Range summary's per-venue figures). */
export const groupParts = (parts: readonly OiPart[], drawnMs: number): OiPart[] => parts.map(part => ({ ...part, bars: groupBars(part.bars, drawnMs) }));

/**
 * The pane's level and changes as drawn candles: `oi` its level per chart candle (oldest first), `change` each chart candle's change by its
 * start where known. A drawn candle's change is the sum of the known changes in it, and absent where none of them is known; the first drawn
 * candle has none (it holds only the chart candles from where the bars start, and the pane draws no bar for its first candle), so the Range
 * summary and the bars count the same candles.
 */
export function groupChanges(oi: readonly OiBar[], change: ReadonlyMap<number, number>, drawnMs: number): { oi: OiBar[]; change: Map<number, number> } {
  const sums = new Map<number, number>(), first = oi.length ? drawnStart(oi[0]![0], drawnMs) : NaN;
  for (const b of oi) {
    const d = change.get(b[0]), s = drawnStart(b[0], drawnMs);
    if (d === undefined || s === first) continue;
    sums.set(s, (sums.get(s) ?? 0) + d);
  }
  return { oi: groupBars(oi, drawnMs), change: sums };
}

/**
 * The venues of each drawn candle, by its start: each venue's own change (`change`), how many venues and which had a change counted (`counted`,
 * `cohorts`), the last chart candle (`closeAt`, whose level the drawn candle's is) and how many venues were read there (`read`).
 */
export interface GroupedVenues {
  change: Map<string, Map<number, number>>; counted: Map<number, number>; cohorts: Map<number, string>; closeAt: Map<number, number>; read: Map<number, number>;
}

/**
 * Each venue's own change per drawn candle as the chart candles count it (`sumOi`: a venue between its readings one chart candle apart, each
 * held up to max(2 candles, 10 min)), and per drawn candle how many venues and which had a change counted (`counted`, `cohorts`). The Range
 * summary's per-venue rows, venue counts and cohorts then add up to the drawn bars: worked out again from the venues' grouped bars they did
 * not where a venue starts inside a drawn candle or has a gap longer than two chart candles (review, 2026-11-22). The first drawn candle has
 * none, as in `groupChanges`. The venues its level is made of are those read at its last chart candle, held as the chart candles hold them
 * (`read`, `closeAt`): held for two drawn candles, a venue that stopped two days before was still listed and counted on a daily candle
 * (review, 2026-11-22).
 */
export function groupVenues(oi: readonly OiBar[], parts: readonly OiPart[], tfMs: number, drawnMs: number): GroupedVenues {
  const carry = Math.max(2 * tfMs, 10 * 60_000), first = oi.length ? drawnStart(oi[0]![0], drawnMs) : NaN;
  const change = new Map<string, Map<number, number>>(), members = new Map<number, Set<string>>(), closeAt = new Map<number, number>(), read = new Map<number, number>();
  for (const b of oi) closeAt.set(drawnStart(b[0], drawnMs), b[0]);
  for (const part of parts) {
    const bars = [...part.bars].sort((a, b) => a[0] - b[0]), mine = new Map<number, number>();
    for (const [s, t] of closeAt) if (heldOiAt(bars, t, carry)) read.set(s, (read.get(s) ?? 0) + 1);
    for (const b of oi) {
      const t = b[0], s = drawnStart(t, drawnMs);
      if (s === first) continue;
      const now = heldOiAt(bars, t, carry), before = heldOiAt(bars, t - tfMs, carry);
      if (!now || !before) continue;
      mine.set(s, (mine.get(s) ?? 0) + now[4] - before[4]);
      let m = members.get(s); if (!m) members.set(s, m = new Set()); m.add(part.id);
    }
    change.set(part.id, mine);
  }
  const counted = new Map<number, number>(), cohorts = new Map<number, string>();
  for (const [s, m] of members) { counted.set(s, m.size); cohorts.set(s, [...m].sort().join(',')); }
  return { change, counted, cohorts, closeAt, read };
}

/** Each bar's change in USD by drawn candle: the chart candles' USD changes (`oiUsdChangeByTime`) added up, the first drawn candle without. */
export function groupUsd(usd: ReadonlyMap<number, number>, oi: readonly OiBar[], drawnMs: number): Map<number, number> {
  const first = oi.length ? drawnStart(oi[0]![0], drawnMs) : NaN, out = new Map<number, number>();
  for (const [t, x] of usd) { const s = drawnStart(t, drawnMs); if (s !== first) out.set(s, (out.get(s) ?? 0) + x); }
  return out;
}

/** The NL/NS label a candle's parts give (the same rule as `nlnsModel`): its largest part, `mixed` when parts pulled both ways, null with none. */
function kindOf(lo: number, lc: number, so: number, sc: number): NlnsCandle['kind'] {
  const named: [NlnsKind, number][] = [['newLongs', lo], ['longsClosed', lc], ['newShorts', so], ['shortsClosed', sc]];
  const nonzero = named.filter(([, x]) => x > 0);
  if (!nonzero.length) return null;
  return lo + sc > 0 && so + lc > 0 ? 'mixed' : nonzero.sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * NL/NS candles summed into drawn candles: every part, the change and what went to no side added up; the start level and the running sums
 * those of its first and last candle; `byPrice` and `coarse` where any candle was; `covered` and `counted` the most of any candle, `fine`
 * the fewest (a drawn candle is worked out minute by minute only as far as every candle in it was).
 */
export function groupWho(who: Iterable<NlnsCandle>, drawnMs: number): Map<number, NlnsCandle> {
  const out = new Map<number, NlnsCandle>();
  for (const c of [...who].sort((a, b) => a.t - b.t)) {
    const s = drawnStart(c.t, drawnMs), g = out.get(s);
    if (!g) { out.set(s, { ...c, t: s }); continue; }
    g.dOi += c.dOi; g.longOpened += c.longOpened; g.longClosed += c.longClosed; g.shortOpened += c.shortOpened; g.shortClosed += c.shortClosed;
    g.unassigned += c.unassigned; g.unknown += c.unknown; g.unsidedUp += c.unsidedUp; g.unsidedDown += c.unsidedDown;
    g.longs += c.longs; g.shorts += c.shorts; g.v += c.v; g.byPriceOi = (g.byPriceOi ?? 0) + (c.byPriceOi ?? 0);
    g.byPrice ||= c.byPrice; g.coarse ||= c.coarse;
    g.covered = Math.max(g.covered, c.covered); g.counted = Math.max(g.counted, c.counted); g.fine = Math.min(g.fine, c.fine);
    g.cum = c.cum; g.cumLongs = c.cumLongs; g.cumShorts = c.cumShorts; g.run = c.run;
  }
  for (const g of out.values()) { g.kind = kindOf(g.longOpened, g.longClosed, g.shortOpened, g.shortClosed); g.side = Math.sign(g.v) as 1 | -1 | 0; }
  return out;
}

/** The chart's candles as drawn candles: the first open, the highest high, the lowest low, the last close, and the other figures added up where every candle has them. */
export function groupCandles(candles: readonly CandleRow[], drawnMs: number): CandleRow[] {
  const out: CandleRow[] = [];
  for (const c of candles) {
    const s = drawnStart(c[0], drawnMs), last = out[out.length - 1];
    if (!last || last[0] !== s) { out.push([s, ...c.slice(1)] as CandleRow); continue; }
    last[2] = Math.max(last[2], c[2]); last[3] = Math.min(last[3], c[3]); last[4] = c[4]; last[5] += c[5];
    for (let k = 6; k < 11; k++) last[k] = last[k] !== undefined && c[k] !== undefined ? last[k]! + c[k]! : undefined;
  }
  return out;
}

/**
 * The share of a candle's change that its takers gave a side: of the four parts and what went to no side for want of a record (`unknown`),
 * what the flow decided (not the way the price went, `byPriceOi`, nor nothing at all). A bar under half is drawn as rising or falling, not
 * split by who (`OiPane`): the who colours are the takers'. Older than the chart's candles a bar with no flow has no price to go by either,
 * and was drawn grey (review, 2026-11-22). 1 where nothing was to be sided (takers even, or no change).
 */
export const takerSidedShare = (c: NlnsCandle): number => {
  const sided = c.longOpened + c.longClosed + c.shortOpened + c.shortClosed, all = sided + c.unknown;
  return all > 0 ? Math.max(0, sided - (c.byPriceOi ?? 0)) / all : 1;
};
