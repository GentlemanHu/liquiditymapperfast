import type { AbsorptionGroup, AbsorptionMinute } from './absorption.ts';

/**
 * One instrument's stored absorption groups that began in one hour, packed so the absorption column answers any threshold without reading
 * them again (a server keeps these for its stored hours; shared/absorption.ts `AbsorptionProfile.hour`). Reading a day of stored groups for
 * every question cost 0.5 s once the database was warm and several seconds before (2026-10-20).
 *
 * A group's marked USD at a threshold is the USD of its last step whose credit reaches it (`markedPart`), which is the sum of its steps'
 * increments (each step's USD less the one before, the first from zero) whose credit reaches it. So the increments of every group at one
 * exact price and side are kept together, largest credit first, with running sums: a threshold is one binary search a cell, and the cell's
 * marked USD is the running sum where it stops. Prices stay exact and are put on the question's rows when it is answered, so any step gives
 * the rows adding up the groups one by one gives.
 *
 * A step is taken at the smallest credit of itself and the steps before it: `markedPart` stops at the first step under the threshold, and
 * the stored steps are not checked to fall. The minutes' floors and each minute's groups' peaks are kept too, for where the rows may be short.
 */

const HOUR = 3_600_000, MINUTE = 60_000, MINUTES = HOUR / MINUTE;
/** What a packed hour takes besides its arrays' contents (the arrays and the cache entry themselves), counted against the cache's room. */
const OVERHEAD_BYTES = 1_024;

export class AbsorptionHour {
  /** The cells, by price then side (buy first): price, side (1: sell), and where each one's increments start (up to the next one's start). */
  readonly price: Float64Array;
  readonly side: Uint8Array;
  readonly first: Uint32Array;
  /** The increments' credits, falling inside a cell, and the USD of a cell's increments up to and including each one. */
  readonly credit: Float64Array;
  readonly sum: Float64Array;
  /** Each minute's floor (NaN: no minute stored), and the highest of them (-Infinity when none is). */
  readonly floors = new Float64Array(MINUTES).fill(Number.NaN);
  readonly topFloor: number;
  /** The groups' peaks by minute, largest first (minute m's from `peakFirst[m]` up to `peakFirst[m + 1]`). */
  readonly peaks: Float64Array;
  readonly peakFirst = new Uint32Array(MINUTES + 1);

  /** `groups` and `minutes`: what the store holds of one instrument whose time is in the hour from `hour`; anything else is passed over. */
  constructor(readonly hour: number, groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) {
    const cells = [new Map<number, [number, number][]>(), new Map<number, [number, number][]>()];
    const byMinute: number[][] = Array.from({ length: MINUTES }, () => []);
    let increments = 0;
    for (const g of groups) {
      if (!(g.t0 >= hour && g.t0 < hour + HOUR) || !g.steps.length) continue;
      const side = g.side === 'sell' ? 1 : 0;
      let list = cells[side]!.get(g.price); if (!list) { list = []; cells[side]!.set(g.price, list); }
      let credit = Infinity, before = 0;
      for (const [c, usd] of g.steps) { credit = Math.min(credit, c); list.push([credit, usd - before]); before = usd; increments++; }
      byMinute[Math.floor((g.t0 - hour) / MINUTE)]!.push(g.steps[0]![0]);
    }
    const order: [number, number, [number, number][]][] = [];
    for (const side of [0, 1]) for (const [price, list] of cells[side]!) order.push([price, side, list]);
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.price = new Float64Array(order.length); this.side = new Uint8Array(order.length); this.first = new Uint32Array(order.length + 1);
    this.credit = new Float64Array(increments); this.sum = new Float64Array(increments);
    let k = 0;
    order.forEach(([price, side, list], c) => {
      this.price[c] = price; this.side[c] = side; this.first[c] = k;
      list.sort((a, b) => b[0] - a[0]);
      let total = 0;
      for (const [credit, usd] of list) { total += usd; this.credit[k] = credit; this.sum[k] = total; k++; }
    });
    this.first[order.length] = k;
    this.peaks = new Float64Array(byMinute.reduce((n, list) => n + list.length, 0));
    let p = 0;
    byMinute.forEach((list, m) => { this.peakFirst[m] = p; for (const peak of list.sort((a, b) => b - a)) this.peaks[p++] = peak; });
    this.peakFirst[MINUTES] = p;
    let top = -Infinity;
    for (const m of minutes) {
      if (!(m.t >= hour && m.t < hour + HOUR)) continue;
      // A minute is stored once; were one there twice, the higher floor says all the lower one does.
      const slot = Math.floor((m.t - hour) / MINUTE), held = this.floors[slot]!;
      this.floors[slot] = Number.isNaN(held) ? m.floor : Math.max(held, m.floor);
      top = Math.max(top, m.floor);
    }
    this.topFloor = top;
  }

  /** How many of minute `m`'s groups (0 to 59 in the hour) peak at or over `threshold`. */
  reaching(m: number, threshold: number): number {
    let n = 0;
    for (let i = this.peakFirst[m]!; i < this.peakFirst[m + 1]! && this.peaks[i]! >= threshold; i++) n++;
    return n;
  }

  /** What it takes in memory, as the cache counts it. */
  get bytes(): number {
    return OVERHEAD_BYTES + this.price.byteLength + this.side.byteLength + this.first.byteLength + this.credit.byteLength + this.sum.byteLength
      + this.floors.byteLength + this.peaks.byteLength + this.peakFirst.byteLength;
  }
}
