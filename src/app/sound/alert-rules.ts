import type { LevelsFrame } from '../wire.ts';
import { gridStepFor } from '../../shared/grid.ts';
import { inTouch } from '../../shared/levels.ts';

/**
 * The decisions behind the panel sounds, with no audio and no DOM: each is a small state machine fed a reading at a time, so a test
 * drives it with a fake clock. What reaches the ear is chosen by `alerts.ts`.
 */

/** Per-key cool-downs: a key that fired is quiet for `ms`. */
export class Cooldowns {
  readonly #at = new Map<string, number>();
  /** True (and starts the cool-down) when `key` has not fired within `ms`. */
  take(key: string, now: number, ms: number): boolean {
    const last = this.#at.get(key);
    if (last !== undefined && now - last < ms) return false;
    this.#at.set(key, now);
    if (this.#at.size > 500) for (const [k, t] of this.#at) if (now - t > 3_600_000) this.#at.delete(k);
    return true;
  }
  /** Give a key's cool-down back (what took it at `at` reached nobody), unless a newer firing has taken it since. */
  release(key: string, at: number): void { if (this.#at.get(key) === at) this.#at.delete(key); }
}

/** At most `max` sounds in any `windowMs`, whatever their kind: a market that does everything at once is one busy moment, not twelve alarms. */
export class RateCap {
  readonly #times: number[] = [];
  constructor(private max: number, private windowMs: number) {}
  allow(now: number): boolean {
    while (this.#times.length && now - this.#times[0]! >= this.windowMs) this.#times.shift();
    if (this.#times.length >= this.max) return false;
    this.#times.push(now); return true;
  }
}

// ---- The order book ---------------------------------------------------------------------------------------------------------------

/** Resting liquidity of the books in `ids`, per price bin, on each side of `mark`, out to `pct` (a fraction) from it: the prices `lo` to `hi`. */
export interface BookBins { bin: number; bid: Map<number, number>; ask: Map<number, number>; bidTotal: number; askTotal: number; lo: number; hi: number }

/**
 * A bin is one step of the 1-2-5 price grid (about 2 bp of the mark, 20 dollars at 100,000). It is a step of that grid and not a fixed
 * fraction of the mark so that it stays the same while the mark moves a little: bins that are 20.002 wide one second and 20.0 the next
 * put the same level in a different bin, and what looks like a wall going is the grid moving.
 */
export function bookBins(frame: LevelsFrame | null, ids: ReadonlySet<string>, mark: number, pct: number): BookBins {
  const lo = mark * (1 - pct), hi = mark * (1 + pct);
  const bin = gridStepFor(mark), out: BookBins = { bin, bid: new Map(), ask: new Map(), bidTotal: 0, askTotal: 0, lo, hi };
  if (!frame || !(mark > 0)) return out;
  for (const book of frame.books) {
    if (!ids.has(book.id)) continue;
    for (const [side, map, key] of [[book.bids, out.bid, 'bidTotal'], [book.asks, out.ask, 'askTotal']] as const) {
      const n = Math.min(side.lo.length, side.hi.length, side.usd.length), isBid = map === out.bid;
      // A grouped venue's top group counts in full in its side's total (its bids rest below its price, its asks above), but only its share
      // on that side of the mark goes into the bins the walls are judged on (see below): for it `add` fills the bins alone.
      let addsToTotal = true;
      const add = (b: number, usd: number) => { map.set(b, (map.get(b) ?? 0) + usd); if (addsToTotal) out[key] += usd; };
      for (let i = 0; i < n; i++) {
        const usd = side.usd[i]!;
        // A grouped venue's top groups are spread over their whole span (`ValuedBook.touch`), not the part a split at an estimate of the
        // touch gave them: a split that moves with the trades would otherwise squeeze a group into fewer bins and sound as a wall.
        const whole = inTouch(book.touch, side.lo[i]!, side.hi[i]!), l = whole ? book.touch!.lo : side.lo[i]!, h = whole ? book.touch!.hi : side.hi[i]!;
        if (!(usd > 0)) continue;
        addsToTotal = !whole;
        // Its total is its share of the whole span inside the range: never the pieces a split at an estimate made of it, so a split that
        // moves does not move the total.
        if (whole) { const span = book.touch!.hi - book.touch!.lo, inside = Math.min(book.touch!.hi, hi) - Math.max(book.touch!.lo, lo); if (inside > 0) out[key] += usd * Math.min(1, inside / span); }
        if (!(h > l)) {
          // Bids count below the mark and asks above it: a crossed or stale level on the wrong side is not liquidity.
          if (l < lo || l > hi || (isBid ? l > mark : l < mark)) continue;
          add(Math.floor(l / bin), usd);
          continue;
        }
        // A band (a grouped venue's level) counts by the part of it on its own side of the mark and inside the range, spread over the bins
        // it covers as the chart spreads it: put whole at its middle, a $100 group would be a wall five bins tall.
        const a = Math.max(l, lo, isBid ? -Infinity : mark), z = Math.min(h, hi, isBid ? mark : Infinity);
        if (!(z > a)) continue;
        for (let b = Math.floor(a / bin); b * bin < z; b++) {
          const part = Math.min(z, (b + 1) * bin) - Math.max(a, b * bin);
          if (part > (h - l) * 1e-9) add(b, usd * part / (h - l));
        }
      }
    }
  }
  return out;
}

export interface Wall { price: number; usd: number }
/** The biggest bin on each side. */
export function biggest(bins: BookBins): { bid: Wall | null; ask: Wall | null } {
  const pick = (map: Map<number, number>): Wall | null => { let best: Wall | null = null; for (const [b, usd] of map) if (!best || usd > best.usd) best = { price: (b + 0.5) * bins.bin, usd }; return best; };
  return { bid: pick(bins.bid), ask: pick(bins.ask) };
}

export interface WallSignal { kind: 'appeared' | 'pulled'; side: 'buy' | 'sell'; price: number; usd: number }

/**
 * Walls on one book. A wall *appears* when the biggest bin on a side reaches `minUsd` after having been below 60 % of it, and it is
 * *pulled* when one that has stood for five seconds drops below 30 % of its size while the price has not come to it (a wall that
 * was eaten is the market doing its job, not news). Nothing sounds in the first ten seconds, while the book is still arriving.
 */
export class WallWatch {
  #start = -1;
  #armed = { buy: false, sell: false };
  /**
   * The wall each side is following: `usd` its size while it was last a wall (what a pull is judged against), `seen` its size at the last
   * look (what a move must carry), `since` when it was first seen.
   */
  #stood: { buy: (Wall & { seen: number; since: number }) | null; sell: (Wall & { seen: number; since: number }) | null } = { buy: null, sell: null };
  /** What the bins were made of last time (the books they came from): a change in it is not a change in the book. */
  #context = '';
  /** The width of the bins last time: walls are remembered by the bin they stood in, so another width is another grid. */
  #bin = 0;
  #last = -1;
  /** Each side's bins at the look before: a wall that moved is one whose old bin emptied as a bin close by gained about as much. */
  #before: { buy: ReadonlyMap<number, number>; sell: ReadonlyMap<number, number> } = { buy: new Map(), sell: new Map() };

  #starts = 0;
  /** How many times the watch has started over (another set of books or market, another grid, a gap): a reader that follows its warm-up starts over with it. */
  get starts(): number { return this.#starts; }

  reset(): void { this.#start = -1; this.#armed = { buy: false, sell: false }; this.#stood = { buy: null, sell: null }; this.#context = ''; this.#bin = 0; this.#last = -1; this.#before = { buy: new Map(), sell: new Map() }; this.#starts++; }

  /** Whether the book is still arriving (the first ten seconds, again after a change of what the bins are made of): nothing is news yet. */
  warming(now: number): boolean { return this.#start < 0 || now - this.#start < 10_000; }

  /**
   * `context` names what the bins are made of (which books, and which instrument's price): when it changes, a venue was switched on or
   * off or one dropped out of the feed, and what looks like a wall coming or going is the set of books changing. Everything is forgotten
   * and the warm-up starts again, so nothing is called appeared or pulled on that account. The same goes for a look that comes long after the
   * one before (nothing was observed in between: a wall that went in that time was not seen going), and for bins of another width (the mark
   * crossed a step of the grid: the same level is in another bin).
   */
  update(now: number, bins: BookBins, mark: number, minUsd: number, context = ''): WallSignal[] {
    if (context !== this.#context || bins.bin !== this.#bin || (this.#last >= 0 && now - this.#last > 10_000)) { const known = this.#start >= 0; this.reset(); this.#context = context; this.#bin = bins.bin; if (known) this.#start = now; }
    this.#last = now;
    if (this.#start < 0) this.#start = now;
    const warm = now - this.#start >= 10_000, top = biggest(bins), out: WallSignal[] = [];
    for (const [side, wall, map] of [['buy', top.bid, bins.bid], ['sell', top.ask, bins.ask]] as const) {
      const stood = this.#stood[side];
      // The wall that has been standing is judged where it stood, whatever else the book holds: a bigger one elsewhere does not hide its going.
      // Its going is looked for at every look, so one that went before it had stood five seconds is forgotten then, not called pulled later.
      if (stood) {
        const bin0 = Math.floor(stood.price / bins.bin), binLo = bin0 * bins.bin, binHi = binLo + bins.bin;
        // Its bin no longer wholly inside the range looked at (the mark moved away): it is not fully seen any more, which is not the same as
        // gone (a level just past the range's edge is left out of the bins).
        if (binLo < bins.lo || binHi > bins.hi) this.#stood[side] = null;
        else {
          const here = map.get(bin0) ?? 0;
          // Still where it stood (whatever else the side holds). The size a pull is judged against follows the bin only while it is still a
          // wall: one taken down in steps keeps the size it stood at, so the steps add up to a pull.
          if (here >= stood.usd * 0.3) this.#stood[side] = { ...stood, seen: here, usd: here >= minUsd ? here : stood.usd };
          else {
            // It left its bin. It moved if a bin within three of it gained about what it held at the look before (a wall that was already
            // there, however big, is another wall): the same wall, keeping how long it has stood and the size a pull is judged against.
            const before = this.#before[side];
            let dest = 0, gain = 0;
            for (let b = bin0 - 3; b <= bin0 + 3; b++) { const g = (map.get(b) ?? 0) - (before.get(b) ?? 0); if (b !== bin0 && g > gain) { dest = b; gain = g; } }
            // What moved must still be the wall (over 30 % of the size it stood at, as where it stood): one that moved as a remnant went.
            const there = map.get(dest) ?? 0;
            if (gain > 0 && gain >= stood.seen * 0.6 && there >= stood.usd * 0.3) this.#stood[side] = { price: (dest + 0.5) * bins.bin, seen: there, usd: there >= minUsd ? there : stood.usd, since: stood.since };
            else {
              // Gone from where it stood. It was pulled only if it had stood and the price did not come to it: a market that reached its bin
              // (within 4 bp, judged on the bin's edges: at a small price a bin's middle can be bp away from a price inside it) or passed
              // through it traded it away.
              const crossed = side === 'buy' ? mark <= binHi : mark >= binLo, reached = mark >= binLo * (1 - 0.0004) && mark <= binHi * (1 + 0.0004);
              if (warm && now - stood.since >= 5_000 && !crossed && !reached) out.push({ kind: 'pulled', side, price: stood.price, usd: stood.usd });
              this.#stood[side] = null;
            }
          }
        }
      }
      this.#before[side] = map;
      const standing = this.#stood[side];
      if (wall && wall.usd >= minUsd) {
        // A wall seen while the book is still arriving is part of the book, not news: taken as standing, never announced later.
        if (!warm) this.#armed[side] = false;
        if (this.#armed[side]) { out.push({ kind: 'appeared', side, price: wall.price, usd: wall.usd }); this.#armed[side] = false; this.#stood[side] = { ...wall, seen: wall.usd, since: now }; }
        else if (!standing) this.#stood[side] = { ...wall, seen: wall.usd, since: now };
        continue;
      }
      if (!wall || wall.usd < minUsd * 0.6) this.#armed[side] = true;
      if (standing && !wall) this.#stood[side] = null;
    }
    return out;
  }
}

/** (bids - asks) / (bids + asks), -1 to 1; 0 for an empty book. */
export const imbalanceOf = (bins: Pick<BookBins, 'bidTotal' | 'askTotal'>): number => { const t = bins.bidTotal + bins.askTotal; return t > 0 ? (bins.bidTotal - bins.askTotal) / t : 0; };

/**
 * One tip of the balance: fires when the imbalance passes `pct` percent one way, then not again until it has come back inside 60 % of that
 * (a book that hovers at the line sounds once, not on every wobble). While the book is still arriving (`warm` false: the walls' warm-up,
 * which starts again when the books or the chart's market change) it only watches: a balance already past the line then is the book as it
 * was found, not news, and must come back before it can sound.
 */
export class ImbalanceWatch {
  #armed = true;
  /** Start over (the books it judges changed): what it saw before says nothing about them. */
  reset(): void { this.#armed = true; }
  update(imbalance: number, pct: number, warm = true): 'buy' | 'sell' | null {
    const limit = pct / 100;
    if (Math.abs(imbalance) < limit * 0.6) this.#armed = true;
    if (!warm) { if (Math.abs(imbalance) >= limit) this.#armed = false; return null; }
    if (!this.#armed || Math.abs(imbalance) < limit) return null;
    this.#armed = false;
    return imbalance > 0 ? 'buy' : 'sell';
  }
}
