import { PULSE_ATTACK_MS, pulseEnvelope } from '../candle/model.ts';
import { STRIDE, type TapeRing } from '../tape/ring.ts';

/**
 * The ladder's cues, as data: which of the observed changes get light, how long, and where the book's cells are (all pure and tested; the
 * pane paints them, `ladder-cue-paint.ts`).
 *
 * What a cue says. A venue's cell lights when the depth that venue shows at that price changed between two of its own observations (the
 * tracker, `book-cues.ts`, finds those and rejects the rest): the same signed size and the same envelope for an addition and a decrease
 * (Karl: "dim by the same proportions for the same amount of time"), an addition outward through the cell and a decrease back inward.
 * It is a statement about the displayed depth, never about orders: no order is known to have been added, cancelled or traded.
 *
 * Why a budget. Per-venue changes with the Tape's own gate come about 20 a second, 25 cells lit at once and 88 in the worst second of
 * 340 (live study, 2026-10-22), and the page flashes more than three times a second over any area. Light is therefore spent from a budget:
 * at most `maxCues` cells showing light at once and a lit area under `maxArea`, the largest changes first and every venue's largest before
 * any venue's second, and nothing bypasses it, however large the change. A change that gets no light is not lost: its row keeps a signed
 * mark for a few seconds (`marks`), the hover names it, and the book itself already moved.
 *
 * What the budget counts. Light, not time: a cue is a place and an area while it shows light, and a tail (the envelope's last second, under a
 * tenth of its peak) holds almost none. The envelope is monotone after its attack, so the area showing never exceeds what was checked when
 * the last cue was admitted, and a strong change is not turned down because forty faint ones are still running out.
 */

/** A cue's life: the Tape's envelope (80 ms up, 450 ms release) and its crest, to where nothing of it shows any more (the crest is the last to go). */
export const CUE_LIFE_MS = 1_100;
/** A trade's contact is quicker than a change of depth: a ripple of a few hundred milliseconds. */
export const CONTACT_LIFE_MS = 650;
/** How long a row's signed mark stays (it fades over this). */
export const MARK_LIFE_MS = 3_500;
/** How long a cue's crest takes to cross its cell. */
export const CREST_MS = 380;
/** Cues showing light at once, and the area they may cover at full light (CSS px squared): under a quarter of W3C's 10-degree flash area (about 21,800 px2) with the Tape and the page's waves besides. */
export const MAX_CUES = 40;
export const MAX_CUE_AREA = 12_000;
/** And no more than this share of the ladder on screen (a phone's book is a fifth of a desktop's, so the same lit area would be five times as busy), nor under this much. */
export const MAX_CUE_AREA_SHARE = 0.05, MIN_CUE_AREA = 1_500;
/** The area cap for a ladder of `w` x `h` CSS px on screen. */
export const maxAreaFor = (w: number, h: number): number => Math.max(MIN_CUE_AREA, Math.min(MAX_CUE_AREA, MAX_CUE_AREA_SHARE * w * h));
/**
 * A cue showing under this share of its peak is a tail (a change's body is there after about half a second) and holds no place. It bounds the
 * cues running, tails included: at most `MAX_CUES` begin in any half second and each runs 1.5 s at the most, so about three times as many.
 */
export const BRIGHT_SHARE = 0.1;
/**
 * A change lights nothing under this strength (1 - exp(-|usd| / scale)): its mark and the hover still name it. A wash at .1 is a 5 % tint, which nobody
 * sees, and 4 in 10 of the cues the live book raised (2026-10-22) were under .2: they took places and area from the ones that show.
 */
export const MIN_CUE_STRENGTH = 0.1;
/** A change under this strength leaves no mark either. */
export const MIN_MARK_STRENGTH = 0.04;
/** Changes, and contacts, that wait for a draw: a stalled pane cannot pile them up. */
export const MAX_PENDING = 512, MAX_CONTACTS = 256;
/**
 * A contact paints the whole cell in a strike, in every look, as bright as .67 of its strength (a wash is at most .46 of a change's): it is charged 1.5 times
 * what a wash of its strength costs against the area budget, whatever the look the changes are in (a Rim's cost of a fifth is for a thin edge).
 */
export const CONTACT_WEIGHT = 1.5;

/** How a cue looks. `marks` lights nothing: only the rows' signed marks show (reduced motion, and a look of its own). */
export type CueLook = 'wash' | 'rim' | 'deposit' | 'marks';
/** What a look costs against the area budget, per px2 of the cell it lights: a rim is a thin line, a wash the whole cell. */
export const LOOK_COST: Readonly<Record<CueLook, number>> = { wash: 1, deposit: 0.6, rim: 0.2, marks: 0 };

/** One row's change of one venue's displayed depth, as the tracker's `rowEvents` gives it. */
export interface CueRow { id: string; side: 'bid' | 'ask'; row: number; usd: number; strength: number; wall: number; seq: number; removed: boolean; added: boolean; pair: boolean; band: boolean }

/**
 * A market order that reached resting depth: the venue, the resting side it took from, the price row, what it executed there (USD, positive)
 * and whether its taker bought. A contact says that an order met the depth at that price; it does not say the depth changed, or by how much.
 */
export interface ContactRow { id: string; side: 'bid' | 'ask'; row: number; usd: number; strength: number; wall: number; seq: number; buy: boolean }

/** A cell as the last draw laid it out (CSS px), with the USD it shows. */
export interface Cell { x: number; y: number; w: number; h: number; usd: number }
/** Where the cells are: what `CellMap` answers. */
export interface Geometry { cell(id: string, side: 'bid' | 'ask', row: number): Cell | null; rowVisible(row: number): boolean }

export interface Cue {
  /** `${id}|${side}|${row}`: one cue a cell. */
  key: string; id: string; side: 'bid' | 'ask'; row: number;
  sign: 1 | -1; strength: number; usd: number;
  /** The presentation clock (performance.now) when it began. */
  t0: number;
  removed: boolean; added: boolean; pair: boolean; band: boolean;
  /** What it costs against the area budget (px2). */
  cost: number;
  seq: number;
  /** A change of displayed depth (the default), or a market order's contact with it; how long it lives; whether its taker bought. */
  kind: 'depth' | 'contact';
  life: number;
  buy: boolean;
}
/** A row's signed mark: the strongest recent change on the row, lit or not. It keeps the side it was made on (the row may show the other now). */
export interface Mark { id: string; side: 'bid' | 'ask'; row: number; sign: 1 | -1; strength: number; usd: number; t0: number; lit: boolean; removed: boolean; pair: boolean }

/** The most rows one order's contact reaches (from the touch outward), and how much weaker each row after the first is. */
export const CONTACT_ROWS = 6, CONTACT_FALLOFF = 0.75;

/**
 * The contacts of the market orders the trade tape holds from write number `from` up to `to`: the orders of at least `floor` USD on one of `ids`
 * and no older than `maxAgeMs` (the tape can be filled late, and what it holds from before is history), each at the resting side it took from (a
 * buyer takes the asks, a seller the bids) over the rows of `step` it reached from the touch outward, weaker for each row it went on to. The
 * strength is as the changes' (1 - exp(-usd / scale)), with `scale` its own.
 */
export function contactRows(ring: Pick<TapeRing, 'data' | 'capacity' | 'at'>, from: number, to: number, o: { step: number; floor: number; scale: number; now: number; ids: ReadonlySet<string>; maxAgeMs: number }): ContactRow[] {
  const out: ContactRow[] = [];
  if (!(o.step > 0)) return out;
  for (let k = from; k < to; k++) {
    if (!(Math.abs(ring.data[(k % ring.capacity) * STRIDE + 2]!) >= o.floor)) continue;
    const rec = ring.at(k);
    if (!o.ids.has(rec.id) || o.now - rec.t > o.maxAgeMs) continue;
    const buy = rec.usd > 0, top = Math.floor((buy ? rec.lo : rec.hi) / o.step), end = Math.floor((buy ? rec.hi : rec.lo) / o.step), n = Math.min(CONTACT_ROWS, Math.abs(end - top) + 1);
    for (let j = 0; j < n; j++) out.push({ id: rec.id, side: buy ? 'ask' : 'bid', row: buy ? top + j : top - j, usd: Math.abs(rec.usd), strength: (1 - Math.exp(-Math.abs(rec.usd) / o.scale)) * CONTACT_FALLOFF ** j, wall: rec.t, seq: k, buy });
  }
  return out;
}

/**
 * "Traded meanwhile", for the hover: the market orders of one venue that reached a price row around the time of a change, so that a decrease can be
 * read against what was taken from it. The change was seen between two snapshots of that venue's book (the page's clock) and the orders are stamped by
 * the exchange: the interval is looked at a little widely, and no wider. It is a fact about the tape, not an explanation of the change.
 */
export const MEANWHILE_BEFORE_MS = 1_000, MEANWHILE_AFTER_MS = 500;
/** The stretch of the tape that is still running may end this long before the end of an interval and still cover it (a quiet market is not a gap); a stretch that ended must cover it whole. */
const COVER_SLACK_MS = 5_000;
/** The times the ring stores are exact to the millisecond only until it moves its time base: what it has lost is taken a couple of milliseconds later than it says. */
const LOST_SLACK_MS = 2;
/** An interval whose end is not yet this much older than the page's clock may still have orders on their way: nothing is said of it yet. */
const SETTLE_MS = 1_000;
/** A venue that traded nothing in the quarter minute before the interval is not known to be on the tape at all: its silence says nothing. */
const ACTIVE_MS = 15_000;
/** The interval a change between the snapshots at `from` and `to` (the page's clock, ms) is looked at for orders. */
export const meanwhile = (from: number, to: number): { from: number; to: number } => ({ from: from - MEANWHILE_BEFORE_MS, to: to + MEANWHILE_AFTER_MS });

/**
 * The USD of the market orders of venue `id` that reached [lo, hi) between `from` and `to` (ms) on the side that takes from the depth there (a
 * buyer takes the asks), whole orders: an order that walked through the row counts at its full size. Null when it is not known: the interval does not lie
 * inside one stretch of the tape without a gap (a short one counts), reaches back to an order the ring has overwritten (`lostThrough`), ends too lately for its orders to have all
 * arrived (`now` is the page's clock), or the venue has no orders on the tape around then.
 */
export function tradedInRow(ring: Pick<TapeRing, 'data' | 'capacity' | 'segments' | 'runs' | 'ids' | 't0' | 'p0' | 'lostThrough'>, o: { id: string; ask: boolean; lo: number; hi: number; from: number; to: number; now: number }): number | null {
  if (!(o.to >= o.from) || o.to > o.now - SETTLE_MS || o.from <= ring.lostThrough + LOST_SLACK_MS) return null;
  const last = ring.segments[ring.segments.length - 1];
  if (!ring.segments.some(s => s.from <= o.from && (s === last ? s.to + COVER_SLACK_MS >= o.to : s.to >= o.to))) return null;
  const local = ring.ids.indexOf(o.id);
  if (local < 0) return null;
  const d = ring.data, cap = ring.capacity;
  let usd = 0, active = false;
  for (const [a, b] of ring.runs(o.from - ACTIVE_MS, o.to)) for (let k = a; k < b; k++) {
    const at = (k % cap) * STRIDE;
    if (d[at + 3] !== local) continue;
    const t = ring.t0 + d[at]!;
    if (t < o.from - ACTIVE_MS || t > o.to) continue;
    active = true;
    const u = d[at + 2]!;
    if (t < o.from || (u > 0) !== o.ask) continue;
    const lo = ring.p0 + d[at + 4]!, hi = ring.p0 + d[at + 5]!, low = lo < hi ? lo : hi, high = lo < hi ? hi : lo;
    if (high >= o.lo && low < o.hi) usd += u < 0 ? -u : u;
  }
  return active ? usd : null;
}

export const cueKey = (id: string, side: 'bid' | 'ask', row: number): string => `${id}|${side}|${row}`;
/**
 * A mark is a row's (all venues, one gutter box a row) or, in Single mode where each book has a gutter of its own, a venue's row's: `scope`
 * is then its id. One mark a box, whichever side made it, so two marks never share one and what the pointer is on is the one drawn.
 */
export const markKey = (row: number, scope = ''): string => `${scope}|${row}`;

/** What a cue costs against the area budget (px2 at full light): the cell it lights, as strong as the cue is, as much of it as the look lights. */
export const cueCost = (cell: Cell, strength: number, weight: number): number => Math.max(1, cell.w) * Math.max(1, cell.h) * (0.25 + 0.75 * strength) * weight;

/** Add to a list that is bounded: when it is full the weakest goes (the new one, when it is the weakest), so a flood of faint items cannot push out the strong ones. */
export function pushStrongest<T extends { strength: number }>(list: T[], item: T, cap: number): void {
  if (list.length < cap) { list.push(item); return; }
  let weakest = 0;
  for (let i = 1; i < list.length; i++) if (list[i]!.strength < list[weakest]!.strength) weakest = i;
  if (list[weakest]!.strength < item.strength) list[weakest] = item;
}

/**
 * Bring a list down to `cap`: the weakest item of the venue with the most items goes, again and again, so a venue that floods the list gives up its faint
 * ones before a quiet venue loses its only one (a global cut by strength could leave a venue with neither light nor a mark).
 */
export function evictFairly<T extends { id: string; strength: number }>(list: T[], cap: number): T[] {
  const dropped: T[] = [];
  if (list.length <= cap) return dropped;
  const by = new Map<string, number[]>();
  list.forEach((e, i) => { let l = by.get(e.id); if (!l) { l = []; by.set(e.id, l); } l.push(i); });
  for (const l of by.values()) l.sort((a, b) => list[a]!.strength - list[b]!.strength);
  const next = new Map<string, number>(), drop = new Set<number>();
  for (let n = list.length; n > cap;) {
    let pick: string | null = null, most = 0;
    for (const [id, l] of by) { const left = l.length - (next.get(id) ?? 0); if (left > most) { most = left; pick = id; } }
    if (pick === null) break;
    const k = next.get(pick) ?? 0; next.set(pick, k + 1); drop.add(by.get(pick)![k]!); n--;
  }
  let w = 0;
  for (let i = 0; i < list.length; i++) if (drop.has(i)) dropped.push(list[i]!); else list[w++] = list[i]!;
  list.length = w;
  return dropped;
}

/**
 * A queue of tracker events brought down to `cap` fairly (`evictFairly`); and a cell whose newer change was let go loses its older ones too, so that
 * what stays at a cell is never an older direction than what was dropped (it would be painted and marked as the latest).
 */
export function shedEvents<T extends { id: string; side: string; lo: number; hi: number; seq: number; strength: number }>(list: T[], cap: number): void {
  const dropped = evictFairly(list, cap);
  if (!dropped.length) return;
  const newest = new Map<string, number>();
  for (const d of dropped) { const k = `${d.id}|${d.side}|${d.lo}|${d.hi}`; if ((newest.get(k) ?? -1) < d.seq) newest.set(k, d.seq); }
  let w = 0;
  for (const e of list) { const s = newest.get(`${e.id}|${e.side}|${e.lo}|${e.hi}`); if (s === undefined || e.seq > s) list[w++] = e; }
  list.length = w;
}

/** Where a cue's crest is along its cell, 0 (the cell's inner edge) to 1 (its outer): out for an addition, back in for a decrease. */
export function crestAt(sign: 1 | -1, age: number): number {
  const p = Math.min(1, Math.max(0, age / CREST_MS));
  return sign > 0 ? p : 1 - p;
}
/**
 * How bright the crest is at `age` (0 to 1): as strong as the change, as bright as it ever was while it crosses the cell, and gone within about as long as
 * the body is (a tenth of its peak after about half a second): a cue that has let go of its place has let go of its light.
 */
export const crestLight = (strength: number, age: number): number => age < 0 || age > CUE_LIFE_MS ? 0 : strength * Math.exp(-age / 520) * (age <= CREST_MS ? 1 : Math.exp(-(age - CREST_MS) / 150));
/** The body's change at `age` (0 to 1): the same envelope for both signs. */
export const bodyLight = (strength: number, age: number): number => strength * pulseEnvelope(age);
/** A mark's opacity at `age`: full for a moment, then fading out linearly. */
export const markLight = (age: number): number => age < 0 || age > MARK_LIFE_MS ? 0 : Math.min(1, 1.6 * (1 - age / MARK_LIFE_MS));
/**
 * How much of its peak a cue shows at `age` (1 to 0): a change's body or its crest, whichever is brighter (held at 1 through the attack, where the body is
 * still rising, so the budget is never under what is about to show), or a contact's ripple. What the budget counts.
 */
export function shareAt(cue: Pick<Cue, 'kind' | 'life'>, age: number): number {
  if (age < 0 || age > cue.life) return 0;
  if (cue.kind === 'contact') return (1 - age / cue.life) ** 1.4;
  return age < PULSE_ATTACK_MS ? 1 : Math.max(pulseEnvelope(age), crestLight(1, age));
}

/**
 * The cues lit now, the rows' marks, and the changes waiting for the next draw (the draw knows where the cells are, so it decides who gets
 * light). One board for one pane.
 */
export class CueBoard {
  readonly active: Cue[] = [];
  readonly marks = new Map<string, Mark>();
  /** The changes waiting, one a cell: folded as they come (`push`), so a newer change is never behind an older one in a bounded queue. */
  #pending = new Map<string, CueRow>();
  #contacts: ContactRow[] = [];
  /** What the budget turned down since the start (for tests and the console). */
  readonly stats = { pushed: 0, lit: 0, renewed: 0, reversed: 0, turnedDown: 0, off: 0, contacts: 0, contactsLit: 0, /** How many cues lit at each strength: under .1, .2, .4, .7, and above. */ strengths: [0, 0, 0, 0, 0] };
  constructor(private readonly caps: { maxCues: number; maxArea: number } = { maxCues: MAX_CUES, maxArea: MAX_CUE_AREA }) {}

  /**
   * Changes seen at a data frame; they wait for `admit`, one a cell: the changes at a cell are taken in the order they happened (what it did last decides
   * its sign: the same sign adds up, the other replaces; an older one that arrives late is not heard), so an older change can never take the place of a
   * newer one, not even when the queue is full. Bounded: past `MAX_PENDING` cells the busiest venue gives up its faintest first (`evictFairly`).
   */
  push(rows: readonly CueRow[]): void {
    const ordered = rows.length > 1 ? [...rows].sort((a, b) => a.seq - b.seq) : rows;
    for (const r of ordered) {
      if (!(r.usd !== 0) || !Number.isFinite(r.usd)) continue;
      const key = cueKey(r.id, r.side, r.row), had = this.#pending.get(key);
      if (!had) { this.#pending.set(key, { ...r }); continue; }
      if ((had.usd > 0) !== (r.usd > 0)) { if (r.seq >= had.seq) this.#pending.set(key, { ...r }); continue; }
      had.usd += r.usd; had.strength = Math.max(had.strength, r.strength); had.pair ||= r.pair; had.band ||= r.band;
      if (r.seq >= had.seq) { had.removed = r.removed; had.wall = r.wall; had.seq = r.seq; }
    }
    if (this.#pending.size > MAX_PENDING) { const kept = [...this.#pending.values()]; evictFairly(kept, MAX_PENDING); this.#pending = new Map(kept.map(r => [cueKey(r.id, r.side, r.row), r])); }
    this.stats.pushed += rows.length;
  }
  /** Market orders that reached resting depth (the trade tape): they wait for `admit` with the changes, and are lit after them. Bounded likewise. */
  pushContacts(rows: readonly ContactRow[]): void {
    for (const r of rows) pushStrongest(this.#contacts, r, MAX_CONTACTS);
    this.stats.contacts += rows.length;
  }
  get waiting(): number { return this.#pending.size + this.#contacts.length; }

  /** Nothing is lit and nothing waits: a hidden pane, a replay, a new coin. */
  clear(): void { this.active.length = 0; this.marks.clear(); this.#pending.clear(); this.#contacts.length = 0; }
  /** The light goes out, the marks stay (the Signs look, and reduced motion): what is lit and the contacts waiting are dropped, the changes waiting still leave their marks. */
  dim(): void { this.active.length = 0; this.#contacts.length = 0; }
  /** The area cap for the ladder as it is on screen now (`maxAreaFor`); what is lit already is checked against it at the next `reprice`. */
  setMaxArea(px2: number): void { this.caps.maxArea = px2; }
  /** The area cap in force (CSS px squared). */
  get maxArea(): number { return this.caps.maxArea; }
  /** The mark in the gutter box of `row` (of venue `scope` in Single mode), if there is one. */
  markAt(row: number, scope = ''): Mark | undefined { return this.marks.get(markKey(row, scope)); }

  /** Drop what is over by `now`. Returns whether any cue is still lit. */
  prune(now: number): boolean {
    let w = 0;
    for (const c of this.active) if (now - c.t0 <= c.life) this.active[w++] = c;
    this.active.length = w;
    for (const [k, m] of this.marks) if (now - m.t0 > MARK_LIFE_MS) this.marks.delete(k);
    return w > 0;
  }

  /** The area the running cues cost at their peak. */
  get used(): number { let a = 0; for (const c of this.active) a += c.cost; return a; }
  /** The area the running cues show at `now`: each one's cost at the share of its peak it has left. This is what the area cap holds. */
  litArea(now: number): number { let a = 0; for (const c of this.active) a += c.cost * shareAt(c, now - c.t0); return a; }
  /** How many running cues show light at `now` (a tenth of their peak or more). This is what the count cap holds. */
  brightCount(now: number): number { let n = 0; for (const c of this.active) if (shareAt(c, now - c.t0) >= BRIGHT_SHARE) n++; return n; }

  /**
   * The cells were laid out again (a draw with new data, another zoom, another look): each cue is charged for the cell it lights now, a cue whose
   * cell is gone ends, and when the cells grew past the area cap the dimmest ends first, so a cap that held when a cue was admitted holds as long
   * as it shows.
   */
  reprice(now: number, look: CueLook, geo: Geometry): void {
    const weight = LOOK_COST[look];
    let w = 0;
    for (const c of this.active) {
      const cell = geo.rowVisible(c.row) ? geo.cell(c.id, c.side, c.row) : null;
      if (!cell) continue;
      c.cost = cueCost(cell, c.strength, c.kind === 'contact' ? CONTACT_WEIGHT : weight);
      this.active[w++] = c;
    }
    this.active.length = w;
    for (let area = this.litArea(now); area > this.caps.maxArea && this.active.length > 0;) {
      let dimmest = 0, least = Infinity;
      this.active.forEach((c, i) => { const light = c.strength * shareAt(c, now - c.t0); if (light < least) { least = light; dimmest = i; } });
      const gone = this.active[dimmest]!; area -= gone.cost * shareAt(gone, now - gone.t0);
      this.active.splice(dimmest, 1);
    }
  }

  /**
   * Give the waiting changes light, largest first (the first of every venue before the second of any), within the caps: nothing bypasses them.
   * A change whose cell is not on screen lights nothing; a change on a visible row always leaves its mark. `look` prices the area (`LOOK_COST`);
   * `perVenue` keeps a mark for each venue's row, not each row (Single mode: one gutter a book).
   */
  admit(now: number, look: CueLook, geo: Geometry, perVenue = false): void {
    const folded = this.#pending, contacts = this.#contacts; this.#pending = new Map(); this.#contacts = [];
    if (!folded.size && !contacts.length) return;
    this.prune(now);
    const lit = look !== 'marks', weight = LOOK_COST[look];
    // The venue's rank among its own changes, so one busy venue cannot take every place before a quiet one gets its first.
    const byVenue = new Map<string, CueRow[]>();
    for (const r of folded.values()) { let list = byVenue.get(r.id); if (!list) { list = []; byVenue.set(r.id, list); } list.push(r); }
    const order: { r: CueRow; rank: number }[] = [];
    for (const list of byVenue.values()) { list.sort((a, b) => b.strength - a.strength || a.seq - b.seq || a.row - b.row); list.forEach((r, rank) => order.push({ r, rank })); }
    order.sort((a, b) => a.rank - b.rank || b.r.strength - a.r.strength || a.r.seq - b.r.seq || (a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0));
    // What the cues show now is what the caps hold; a cell's own cue is given up for its next one (a cell is one cue), so it counts for nothing against it.
    let area = this.litArea(now), bright = this.brightCount(now);
    for (const { r } of order) {
      if (!geo.rowVisible(r.row)) continue;
      const sign: 1 | -1 = r.usd > 0 ? 1 : -1, cell = geo.cell(r.id, r.side, r.row), key = cueKey(r.id, r.side, r.row);
      // A cell that is drawn still holds something: the row is not emptied, whatever this change took out of it (the change is the part of the row it touched).
      const removed = r.removed && !cell;
      const old = this.active.findIndex(c => c.key === key);
      let didLight = false;
      if (lit && cell && r.strength >= MIN_CUE_STRENGTH) {
        const was = old >= 0 ? this.active[old]! : null, wasShare = was ? shareAt(was, now - was.t0) : 0;
        // The cue it becomes is charged at the strength it ends up with: a renewed cue keeps the stronger of the two.
        const strength = was && was.sign === sign ? Math.max(was.strength, r.strength) : r.strength, cost = cueCost(cell, strength, weight);
        const freed = was ? was.cost * wasShare : 0, freedPlace = wasShare >= BRIGHT_SHARE ? 1 : 0;
        if (bright - freedPlace < this.caps.maxCues && area - freed + cost <= this.caps.maxArea) {
          const cue: Cue = { key, id: r.id, side: r.side, row: r.row, sign, strength, usd: r.usd, t0: now, removed, added: r.added, pair: r.pair, band: r.band, cost, seq: r.seq, kind: 'depth', life: CUE_LIFE_MS, buy: false };
          if (was) {
            if (was.sign === sign) { cue.usd = was.usd + r.usd; this.stats.renewed++; } else this.stats.reversed++;
            this.active[old] = cue;
          } else this.active.push(cue);
          area += cost - freed; bright += 1 - freedPlace;
          didLight = true; this.stats.lit++; this.stats.strengths[r.strength < 0.1 ? 0 : r.strength < 0.2 ? 1 : r.strength < 0.4 ? 2 : r.strength < 0.7 ? 3 : 4]!++;
        } else this.stats.turnedDown++;
      } else if (!lit) this.stats.off++;
      const mk = markKey(r.row, perVenue ? r.id : ''), had = this.marks.get(mk);
      if (r.strength < MIN_MARK_STRENGTH) continue;
      if (!had || r.strength >= had.strength * markLight(now - had.t0) || had.sign !== sign && r.strength >= 0.5 * had.strength) {
        this.marks.set(mk, { id: r.id, side: r.side, row: r.row, sign, strength: r.strength, usd: r.usd, t0: now, lit: didLight, removed, pair: r.pair });
      }
    }
    // The contacts come after every change: the largest first, within what is left of the same budget, and they leave no mark of their own.
    if (!lit || !contacts.length) return;
    contacts.sort((a, b) => b.strength - a.strength || a.seq - b.seq);
    for (const c of contacts) {
      if (!geo.rowVisible(c.row) || !(c.strength >= MIN_CUE_STRENGTH)) continue;
      const cell = geo.cell(c.id, c.side, c.row); if (!cell) continue;
      const key = `${cueKey(c.id, c.side, c.row)}|contact`, old = this.active.findIndex(x => x.key === key);
      const was = old >= 0 ? this.active[old]! : null, wasShare = was ? shareAt(was, now - was.t0) : 0;
      const strength = was ? Math.max(was.strength, c.strength) : c.strength, cost = cueCost(cell, strength, CONTACT_WEIGHT);
      const freed = was ? was.cost * wasShare : 0, freedPlace = wasShare >= BRIGHT_SHARE ? 1 : 0;
      if (bright - freedPlace >= this.caps.maxCues || area - freed + cost > this.caps.maxArea) { this.stats.turnedDown++; continue; }
      const cue: Cue = { key, id: c.id, side: c.side, row: c.row, sign: c.buy ? 1 : -1, strength, usd: c.usd, t0: now, removed: false, added: false, pair: false, band: false, cost, seq: c.seq, kind: 'contact', life: CONTACT_LIFE_MS, buy: c.buy };
      if (was) this.active[old] = cue; else this.active.push(cue);
      area += cost - freed; bright += 1 - freedPlace;
      this.stats.contactsLit++;
    }
  }
}

/**
 * Where the cells of the last draw are, kept in arrays that are reused from one draw to the next (a draw lays out every venue's cell of every
 * row; a map of strings per cell would make thousands of them a second). A row is its absolute row index at the book's step; `top` is the
 * row index of the first row on screen.
 */
export class CellMap implements Geometry {
  #top = 0; #rows = 0;
  #by = new Map<string, { x: Float32Array; y: Float32Array; w: Float32Array; h: Float32Array; usd: Float32Array; side: Uint8Array }>();
  /** Start a draw: `rows` rows from row index `top` down. */
  begin(top: number, rows: number): void {
    this.#top = top; this.#rows = rows;
    for (const e of this.#by.values()) { if (e.w.length < rows) { e.x = new Float32Array(rows); e.y = new Float32Array(rows); e.w = new Float32Array(rows); e.h = new Float32Array(rows); e.usd = new Float32Array(rows); e.side = new Uint8Array(rows); } else { e.w.fill(0, 0, rows); } }
  }
  /** A cell: venue `id`, on screen row number `r` (0 at the top), showing `side` ('bid' = 0, 'ask' = 1). */
  set(id: string, r: number, side: 0 | 1, x: number, y: number, w: number, h: number, usd: number): void {
    if (r < 0 || r >= this.#rows) return;
    let e = this.#by.get(id);
    if (!e) { e = { x: new Float32Array(this.#rows), y: new Float32Array(this.#rows), w: new Float32Array(this.#rows), h: new Float32Array(this.#rows), usd: new Float32Array(this.#rows), side: new Uint8Array(this.#rows) }; this.#by.set(id, e); }
    e.x[r] = x; e.y[r] = y; e.w[r] = w; e.h[r] = h; e.usd[r] = usd; e.side[r] = side;
  }
  rowVisible(row: number): boolean { const r = this.#top - row; return r >= 0 && r < this.#rows; }
  cell(id: string, side: 'bid' | 'ask', row: number): Cell | null {
    const r = this.#top - row;
    if (r < 0 || r >= this.#rows) return null;
    const e = this.#by.get(id);
    if (!e || !(e.w[r]! > 0) || e.side[r] !== (side === 'ask' ? 1 : 0)) return null;
    return { x: e.x[r]!, y: e.y[r]!, w: e.w[r]!, h: e.h[r]!, usd: e.usd[r]! };
  }
  /** The row index of screen row `r`. */
  rowOf(r: number): number { return this.#top - r; }
  get top(): number { return this.#top; }
  get rows(): number { return this.#rows; }
  /** Venues dropped from the book are forgotten with the rest of a draw's state. */
  forget(keep: ReadonlySet<string>): void { for (const id of this.#by.keys()) if (!keep.has(id)) this.#by.delete(id); }
}
