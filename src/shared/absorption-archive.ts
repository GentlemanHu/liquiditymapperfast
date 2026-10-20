import type { AbsorptionGroup, AbsorptionMinute, AbsorptionStep } from './absorption.ts';

/**
 * The settled absorption groups and minutes a recorder holds in memory (a day in the browser, two hours on a server), packed into typed
 * arrays an hour at a time: a group is an instrument number, its side, price and first time and its steps, some 85 bytes with two steps,
 * where the same group as objects took about 400 (2026-10-19: BTC's usual load is 100,000 groups a day; the per-minute cap allows 389,000
 * on 27 venues). Only settled groups come here, so nothing in it changes: a minute still open keeps its groups as objects (a larger group
 * can still push the smallest out) and they are packed when it settles. Letting go is a whole hour at a time; reads start where the last
 * let go (`expire`), so the part of the hour on that boundary is not read.
 */

const HOUR = 3_600_000, MINUTE = 60_000;

type Packed = Float64Array | Uint32Array | Uint16Array | Uint8Array;
/** `array`, or a copy at least `size` long (doubling) holding what it held. */
function grown<A extends Packed>(array: A, size: number): A {
  if (array.length >= size) return array;
  const next = new (array.constructor as new (n: number) => A)(Math.max(size, array.length * 2));
  next.set(array as never);
  return next;
}

/** The groups that began in one hour, in the order they came; group `i`'s steps are `first[i]` up to `first[i + 1]`, credits falling. */
class Chunk {
  n = 0;
  inst = new Uint16Array(32); side = new Uint8Array(32); price = new Float64Array(32); t0 = new Float64Array(32); first = new Uint32Array(33);
  credit = new Float64Array(48); usd = new Float64Array(48); fills = new Uint32Array(48); lo = new Float64Array(48); hi = new Float64Array(48);

  push(inst: number, side: number, price: number, t0: number, steps: readonly AbsorptionStep[]): void {
    const i = this.n, k = this.first[i]!, end = k + steps.length;
    if (i >= this.inst.length) { this.inst = grown(this.inst, i + 1); this.side = grown(this.side, i + 1); this.price = grown(this.price, i + 1); this.t0 = grown(this.t0, i + 1); }
    // A typed array drops a write past its end without a word: the offsets are grown on their own count.
    if (i + 1 >= this.first.length) this.first = grown(this.first, i + 2);
    if (end > this.credit.length) { this.credit = grown(this.credit, end); this.usd = grown(this.usd, end); this.fills = grown(this.fills, end); this.lo = grown(this.lo, end); this.hi = grown(this.hi, end); }
    this.inst[i] = inst; this.side[i] = side; this.price[i] = price; this.t0[i] = t0;
    for (let j = 0; j < steps.length; j++) { const s = steps[j]!; this.credit[k + j] = s[0]; this.usd[k + j] = s[1]; this.fills[k + j] = s[2]; this.lo[k + j] = s[3]; this.hi[k + j] = s[4]; }
    this.first[i + 1] = end; this.n = i + 1;
  }

  /** Let go of the room grown for groups that did not come. */
  trim(): void {
    const n = this.n, s = this.first[n]!;
    if (this.inst.length !== n) { this.inst = this.inst.slice(0, n); this.side = this.side.slice(0, n); this.price = this.price.slice(0, n); this.t0 = this.t0.slice(0, n); this.first = this.first.slice(0, n + 1); }
    if (this.credit.length !== s) { this.credit = this.credit.slice(0, s); this.usd = this.usd.slice(0, s); this.fills = this.fills.slice(0, s); this.lo = this.lo.slice(0, s); this.hi = this.hi.slice(0, s); }
  }

  steps(i: number): AbsorptionStep[] {
    const out: AbsorptionStep[] = [];
    for (let k = this.first[i]!; k < this.first[i + 1]!; k++) out.push([this.credit[k]!, this.usd[k]!, this.fills[k]!, this.lo[k]!, this.hi[k]!]);
    return out;
  }

  get bytes(): number {
    return this.inst.byteLength + this.side.byteLength + this.price.byteLength + this.t0.byteLength + this.first.byteLength
      + this.credit.byteLength + this.usd.byteLength + this.fills.byteLength + this.lo.byteLength + this.hi.byteLength;
  }
}

/** One instrument's minutes of one hour: whether each is held, and its count, mean, squared deviations and floor. */
interface MinuteBlock { have: Uint8Array; stats: Float64Array }

export class AbsorptionArchive {
  readonly #ids: string[] = [];
  readonly #index = new Map<string, number>();
  readonly #chunks = new Map<number, Chunk>();
  readonly #minutes = new Map<number, (MinuteBlock | undefined)[]>();
  /** Where reads start: what began before was let go (`expire`). */
  #from = -Infinity;

  #number(id: string): number {
    let i = this.#index.get(id);
    if (i === undefined) { i = this.#ids.length; this.#ids.push(id); this.#index.set(id, i); }
    return i;
  }

  /** The groups held from where reads start. */
  get size(): number {
    let n = 0;
    for (const [hour, chunk] of this.#chunks) {
      if (hour >= this.#from) { n += chunk.n; continue; }
      for (let i = 0; i < chunk.n; i++) if (chunk.t0[i]! >= this.#from) n++;
    }
    return n;
  }
  /** The bytes of the typed arrays holding the groups and minutes. */
  get bytes(): number {
    let bytes = 0;
    for (const chunk of this.#chunks.values()) bytes += chunk.bytes;
    for (const blocks of this.#minutes.values()) for (const block of blocks) if (block) bytes += block.have.byteLength + block.stats.byteLength;
    return bytes;
  }

  /** Hold a settled group (one older than what is kept is not held). */
  addGroup(g: AbsorptionGroup): void {
    if (g.t0 < this.#from) return;
    const hour = Math.floor(g.t0 / HOUR) * HOUR;
    let chunk = this.#chunks.get(hour); if (!chunk) { chunk = new Chunk(); this.#chunks.set(hour, chunk); }
    chunk.push(this.#number(g.id), g.side === 'sell' ? 1 : 0, g.price, g.t0, g.steps);
  }

  /** Hold a minute; false when one of that instrument and time is held already (the first stands). */
  addMinute(m: AbsorptionMinute): boolean {
    const hour = Math.floor(m.t / HOUR) * HOUR, slot = Math.floor((m.t - hour) / MINUTE), inst = this.#number(m.id);
    let blocks = this.#minutes.get(hour); if (!blocks) { blocks = []; this.#minutes.set(hour, blocks); }
    let block = blocks[inst]; if (!block) { block = { have: new Uint8Array(60), stats: new Float64Array(240) }; blocks[inst] = block; }
    if (block.have[slot] && hour + slot * MINUTE >= this.#from) return false;
    block.have[slot] = 1;
    block.stats[slot * 4] = m.n; block.stats[slot * 4 + 1] = m.mean; block.stats[slot * 4 + 2] = m.m2; block.stats[slot * 4 + 3] = m.floor;
    return true;
  }

  /** Let go of the room grown in the hours that ended by `before` (no group comes to them any more but one read back, which grows it again). */
  compact(before: number): void {
    for (const [hour, chunk] of this.#chunks) if (hour + HOUR <= before) chunk.trim();
  }

  /** Let go of what began before `cutoff`: whole hours, and reads start there from now on. */
  expire(cutoff: number): void {
    if (!(cutoff > this.#from)) return;
    this.#from = cutoff;
    for (const hour of this.#chunks.keys()) if (hour + HOUR <= cutoff) this.#chunks.delete(hour);
    for (const hour of this.#minutes.keys()) if (hour + HOUR <= cutoff) this.#minutes.delete(hour);
  }

  /** The chunks that may hold groups of [from, to) (from where reads start), each with whether all of it is inside. */
  *#overlapping(from: number, to: number): Generator<[Chunk, boolean]> {
    for (const [hour, chunk] of this.#chunks) if (hour + HOUR > from && hour < to) yield [chunk, hour >= from && hour + HOUR <= to];
  }

  /** Every group that began in [from, to) whose largest credit is at least its instrument's `mins` entry (none: not asked for), as objects. */
  eachGroup(from: number, to: number, mins: ReadonlyMap<string, number>, take: (g: AbsorptionGroup) => void): void {
    from = Math.max(from, this.#from);
    const min = this.#perInstrument(mins);
    for (const [chunk, whole] of this.#overlapping(from, to)) {
      for (let i = 0; i < chunk.n; i++) {
        if (!(chunk.credit[chunk.first[i]!]! >= min[chunk.inst[i]!]!)) continue;
        const t0 = chunk.t0[i]!;
        if (!whole && (t0 < from || t0 >= to)) continue;
        take({ id: this.#ids[chunk.inst[i]!]!, side: chunk.side[i] ? 'sell' : 'buy', price: chunk.price[i]!, t0, steps: chunk.steps(i) });
      }
    }
  }

  /**
   * The absorption column: every group that began in [from, to) and reaches its instrument's threshold, handed with its marked USD (the
   * last step whose credit reaches it, as shared/absorption.ts `markedPart`). An instrument with no threshold has nothing marked.
   */
  eachMarked(from: number, to: number, thresholds: ReadonlyMap<string, number | null>, take: (id: string, side: 'buy' | 'sell', price: number, t0: number, usd: number) => void): void {
    from = Math.max(from, this.#from);
    const threshold = this.#perInstrument(thresholds);
    for (const [chunk, whole] of this.#overlapping(from, to)) {
      const { inst, first, credit } = chunk;
      for (let i = 0; i < chunk.n; i++) {
        const at = threshold[inst[i]!]!;
        let k = first[i]!;
        if (!(credit[k]! >= at)) continue;
        const t0 = chunk.t0[i]!;
        if (!whole && (t0 < from || t0 >= to)) continue;
        const end = first[i + 1]!;
        while (k + 1 < end && credit[k + 1]! >= at) k++;
        take(this.#ids[inst[i]!]!, chunk.side[i] ? 'sell' : 'buy', chunk.price[i]!, t0, chunk.usd[k]!);
      }
    }
  }

  /** Each held minute of `ids` in [from, to), in no order. */
  eachMinute(ids: readonly string[], from: number, to: number, take: (m: AbsorptionMinute) => void): void {
    from = Math.max(from, this.#from);
    const wanted = ids.map(id => this.#index.get(id)).filter((i): i is number => i !== undefined);
    for (const [hour, blocks] of this.#minutes) {
      if (!(hour + HOUR > from && hour < to)) continue;
      for (const i of wanted) {
        const block = blocks[i]; if (!block) continue;
        for (let slot = 0; slot < 60; slot++) {
          const t = hour + slot * MINUTE;
          if (!block.have[slot] || t < from || t >= to) continue;
          const s = block.stats, k = slot * 4;
          take({ id: this.#ids[i]!, t, n: s[k]!, mean: s[k + 1]!, m2: s[k + 2]!, floor: s[k + 3]! });
        }
      }
    }
  }

  /** `values` by instrument number, NaN for one with none (no comparison passes it). */
  #perInstrument(values: ReadonlyMap<string, number | null>): Float64Array {
    const out = new Float64Array(this.#ids.length).fill(Number.NaN);
    for (const [id, v] of values) { const i = this.#index.get(id); if (i !== undefined && v !== null) out[i] = v; }
    return out;
  }
}
