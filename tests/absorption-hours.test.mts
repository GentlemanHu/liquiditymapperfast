import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AbsorptionProfile, AbsorptionRecorder, hoursOf, markedPart, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionProfileAnswer, type AbsorptionStep, type AbsorptionStore } from '../src/shared/absorption.ts';
import { AbsorptionHour } from '../src/shared/absorption-hours.ts';
import { binOf } from '../src/shared/footprint.ts';
import { AbsorptionRecorder as ServerAbsorptionRecorder, SqliteAbsorptionStore } from '../src/server/v2/absorption.mts';

const MIN = 60_000, HOUR = 3_600_000, T0 = 1_800_000_000_000, FLOOR = 25_000;
type Side = 'buy' | 'sell';
type Rows = Map<string, Map<number, [number, number]>>;

/** A seeded generator. */
const seeded = (seed: number): (() => number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32; };

interface Day { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[]; credits: number[]; floors: number[]; tops: Map<string, number> }

/**
 * Groups and minutes of `ids` over [from, from + span): credits on a coarse grid so thresholds can equal them, a third of the groups on the
 * price and side of an earlier one in its hour (cells of several groups), some steps with equal or rising credits or falling USD (stored
 * steps are not checked), some minutes holding ten groups at or over a floor raised to their smallest peak, and minutes with no group.
 */
function dayOf(seed: number, n: number, ids: readonly string[], from: number, span: number): Day {
  const rnd = seeded(seed), groups: AbsorptionGroup[] = [], keys = new Set<string>(), credits: number[] = [], floors: number[] = [];
  const minutes = new Map<string, AbsorptionMinute>();
  const minuteOf = (id: string, t: number, floor: number): void => {
    const key = `${id}|${Math.floor(t / MIN)}`, held = minutes.get(key);
    minutes.set(key, { id, t: Math.floor(t / MIN) * MIN, n: 3, mean: 40_000, m2: 1e8, floor: Math.max(held?.floor ?? FLOOR, floor) });
  };
  const push = (g: AbsorptionGroup): boolean => {
    const key = `${g.id}|${g.side}|${g.price}|${g.t0}`;
    if (keys.has(key)) return false;
    keys.add(key); groups.push(g); for (const s of g.steps) credits.push(s[0]);
    return true;
  };
  const stepsOf = (t0: number, peak: number): AbsorptionStep[] => {
    const steps: AbsorptionStep[] = [];
    let credit = peak, usd = 0, fills = 0;
    for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) {
      usd += rnd() < 0.05 ? -500 : 1_000 + Math.floor(rnd() * credit) + rnd(); fills += 1 + Math.floor(rnd() * 3);
      steps.push([credit, usd, fills, t0, t0 + Math.floor(rnd() * 9)]);
      const r = rnd();
      credit = r < 0.1 ? credit : r < 0.15 ? credit + 5_000 : Math.max(FLOOR, credit - 5_000 * (1 + Math.floor(rnd() * 20)));
    }
    return steps;
  };
  while (groups.length < n) {
    const id = ids[Math.floor(rnd() * ids.length)]!;
    const earlier = groups.length && rnd() < 0.33 ? groups[Math.floor(rnd() * groups.length)]! : null;
    const t0 = earlier ? Math.floor(earlier.t0 / HOUR) * HOUR + Math.floor(rnd() * HOUR) : from + Math.floor(rnd() * span);
    const price = earlier ? earlier.price : rnd() < 0.2 ? 80_000 + Math.floor(rnd() * 40) * 50 : 80_000 + Math.round(rnd() * 200_000) / 100;
    const side: Side = earlier ? earlier.side : rnd() < 0.5 ? 'buy' : 'sell';
    if (push({ id: earlier ? earlier.id : id, side, price, t0, steps: stepsOf(t0, FLOOR + 5_000 * Math.floor(rnd() * 120)) }) && rnd() < 0.3) minuteOf(earlier ? earlier.id : id, t0, FLOOR);
  }
  // Minutes with no group, some with a raised floor (under the floors of the minutes below, so those are each instrument's highest).
  for (let i = 0; i < 60; i++) { const f = rnd() < 0.5 ? FLOOR : FLOOR + 5_000 * Math.floor(rnd() * 60); minuteOf(ids[i % ids.length]!, from + Math.floor(rnd() * span), f); floors.push(f); }
  // Minutes that kept ten groups, their floor their smallest peak (all ten reach it: short at it) or their largest (one reaches it: complete).
  const tops = new Map<string, number>();
  for (let i = 0; i < 12; i++) {
    const id = ids[i % ids.length]!, t = from + Math.floor(rnd() * span / MIN) * MIN, low = FLOOR + 5_000 * (60 + Math.floor(rnd() * 40));
    for (let k = 0; k < 10; k++) push({ id, side: k % 2 ? 'sell' : 'buy', price: 90_000 + i * 10 + k, t0: t + k * 1_000, steps: stepsOf(t + k * 1_000, low + 5_000 * k) });
    const floor = rnd() < 0.5 ? low : low + 45_000;
    minuteOf(id, t, floor); floors.push(floor); tops.set(id, Math.max(tops.get(id) ?? 0, floor));
  }
  return { groups, minutes: [...minutes.values()], credits, floors, tops };
}

/** The column worked out the slow way: every group's marked part (`markedPart`) on the row of its price, each group once. */
function referenceRows(groups: readonly AbsorptionGroup[], thresholds: ReadonlyMap<string, number | null>, from: number, to: number, step: number): Rows {
  const out: Rows = new Map(), seen = new Set<string>();
  for (const g of groups) {
    const threshold = thresholds.get(g.id), key = `${g.id}|${g.side}|${g.price}|${g.t0}`;
    if (threshold === null || threshold === undefined || g.t0 < from || g.t0 >= to || seen.has(key)) continue;
    seen.add(key);
    const part = markedPart(g, threshold); if (!part) continue;
    let rows = out.get(g.id); if (!rows) { rows = new Map(); out.set(g.id, rows); }
    const price = binOf(g.price, step) * step, cell = rows.get(price) ?? [0, 0];
    cell[g.side === 'sell' ? 0 : 1] += part.usd; rows.set(price, cell);
  }
  return out;
}

const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** An answer's rows equal the reference's (sums compared to a part in a billion: they are added in another order). */
function assertRows(answer: AbsorptionProfileAnswer, want: Rows, label: string): void {
  assert.deepEqual(answer.instruments.map(i => i.id).sort(), [...want.keys()].sort(), `${label}: the instruments`);
  for (const i of answer.instruments) {
    const rows = want.get(i.id)!;
    assert.deepEqual(i.rows.map(r => r[0]), [...rows.keys()].sort((a, b) => a - b), `${label}: ${i.id}'s rows`);
    for (const [price, a, b] of i.rows) {
      const [wa, wb] = rows.get(price)!;
      assert.ok(close(a, wa) && close(b, wb), `${label}: ${i.id} at ${price}: ${a}/${b}, wanted ${wa}/${wb}`);
    }
  }
}

/** Two answers alike: the same rows (sums to a part in a billion), the same instruments said to be short, the same cut. */
function assertSame(got: AbsorptionProfileAnswer, want: AbsorptionProfileAnswer, label: string): void {
  assert.deepEqual([got.from, got.to, got.cut], [want.from, want.to, want.cut], `${label}: window and cut`);
  assert.deepEqual([...got.incomplete].sort(), [...want.incomplete].sort(), `${label}: incomplete`);
  const rows: Rows = new Map(want.instruments.map(i => [i.id, new Map(i.rows.map(([p, a, b]): [number, [number, number]] => [p, [a, b]]))]));
  assertRows(got, rows, label);
}

/**
 * A store holding what it is given, the way the server's does: a group once (the first stands), older ones let go as it saves. With `hours`
 * it reads an hour back (`readHour`), so a recorder packs it; without, a recorder reads it as before. It records what it was asked.
 */
class MemoryStore implements AbsorptionStore {
  readonly hourly: [string, number][] = [];
  readonly asked: [number, number][] = [];
  /** Added to the clock `performance.now` gives, each hour read (see the test that measures the turns). */
  readCost = 0;
  readHour?: (id: string, hour: number) => { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] };
  instruments?: () => string[];
  constructor(readonly groups: AbsorptionGroup[], readonly stored: AbsorptionMinute[], hours = true, readonly clock?: { t: number }) {
    if (hours) {
      this.readHour = (id, hour) => {
        this.hourly.push([id, hour]);
        if (this.clock) this.clock.t += this.readCost;
        return { groups: this.groups.filter(g => g.id === id && g.t0 >= hour && g.t0 < hour + HOUR), minutes: this.stored.filter(m => m.id === id && m.t >= hour && m.t < hour + HOUR) };
      };
      this.instruments = () => [...new Set(this.groups.map(g => g.id))].sort();
    }
  }
  /** The same groups and minutes, read as before (no hour read back). */
  plain(): MemoryStore { return new MemoryStore(this.groups, this.stored, false); }
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } { return { groups: this.groups.filter(g => g.t0 >= since), minutes: this.stored.filter(m => m.t >= since) }; }
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void {
    const keys = new Set(this.groups.map(g => `${g.id}|${g.side}|${g.price}|${g.t0}`)), held = new Set(this.stored.map(m => `${m.id}|${m.t}`));
    for (const g of groups) if (!keys.has(`${g.id}|${g.side}|${g.price}|${g.t0}`)) { keys.add(`${g.id}|${g.side}|${g.price}|${g.t0}`); this.groups.push(g); }
    for (const m of minutes) if (!held.has(`${m.id}|${m.t}`)) { held.add(`${m.id}|${m.t}`); this.stored.push(m); }
    for (let i = this.groups.length - 1; i >= 0; i--) if (this.groups[i]!.t0 < expireBefore) this.groups.splice(i, 1);
    for (let i = this.stored.length - 1; i >= 0; i--) if (this.stored[i]!.t < expireBefore) this.stored.splice(i, 1);
  }
  query(): AbsorptionGroup[] { throw new Error('the column asked for capped groups'); }
  minutes(): AbsorptionMinute[] { throw new Error('the column asked for minutes outside its hours'); }
  async eachHour(ids: readonly string[] | null, mins: readonly number[], from: number, to: number, take: (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) => void): Promise<void> {
    const min = ids ? new Map(ids.map((id, i) => [id, mins[i]!])) : null, passes = (id: string, v: number): boolean => !min || v >= (min.get(id) ?? Infinity);
    for (const hour of hoursOf(from, to)) {
      this.asked.push([hour.from, hour.to]);
      take(this.groups.filter(g => g.t0 >= hour.from && g.t0 < hour.to && passes(g.id, peakOf(g))), this.stored.filter(m => m.t >= hour.from && m.t < hour.to && passes(m.id, m.floor)));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  close(): void {}
}

test('the packed hours answer what reading every group answered, and what judging every group gives, at thresholds on step credits and floors', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], end = T0 + 30 * HOUR, now = end + 17 * MIN + 23_456, split = now - 2 * HOUR;
  for (const seed of [2, 7, 11]) {
    const day = dayOf(seed, 6_000, ids, T0, 30 * HOUR), rnd = seeded(seed * 31);
    const store = new MemoryStore(day.groups, day.minutes), packed = new AbsorptionRecorder(store, () => now), plain = new AbsorptionRecorder(store.plain(), () => now);
    const pick = (list: readonly number[]): number => list[Math.floor(rnd() * list.length)]!;
    const thresholdSets: (number | null)[][] = [[FLOOR, FLOOR, FLOOR], [pick(day.credits), pick(day.credits), null], [pick(day.floors), pick(day.floors), pick(day.credits)], [0, 1e12, 61_234.5],
      [pick(day.floors), pick(day.credits), pick(day.floors)], ids.map(id => day.tops.get(id)!)];
    for (const thresholds of thresholdSets) for (const step of [50, 0.5, 7, 1_000]) {
      const map = new Map<string, number | null>(ids.map((id, i) => [id, thresholds[i]!]));
      for (const [from, to] of [[T0, now], [T0 + 90 * MIN + 17, end - 45 * MIN - 3], [T0 + 5 * HOUR, T0 + 9 * HOUR], [T0 + 3 * HOUR + 1, T0 + 3 * HOUR + 2], [now - 90 * MIN, now], [T0 - 5 * HOUR, T0 + 2 * HOUR]] as const) {
        const label = `seed ${seed}, ${thresholds.join('/')} on ${step}, ${from - T0}..${to - T0}`;
        store.hourly.length = 0; store.asked.length = 0;
        const got = await packed.profile(ids, [...thresholds], from, to, step), want = await plain.profile(ids, [...thresholds], from, to, step);
        assertSame(got, want, label);
        assertRows(got, referenceRows(day.groups, map, from, to, step), `${label}, against markedPart`);
        // Whole hours before memory are packed; the store reads only the part hours at either end as it did.
        const top = Math.min(to, Math.max(from, split)), asked = ids.filter((_, i) => thresholds[i] !== null);
        for (const [, hour] of store.hourly) assert.ok(hour >= from && hour + HOUR <= top && hour % HOUR === 0, `${label}: packed ${hour - T0}`);
        for (const [a, b] of store.asked) assert.ok(b - a < HOUR && (a === from || b === top), `${label}: read ${a - T0}..${b - T0}`);
        assert.ok(store.hourly.every(([id]) => asked.includes(id)), `${label}: only the instruments with a threshold`);
      }
    }
    // Every hour asked is held now: asked again, nothing is read but the part hours.
    store.hourly.length = 0;
    assertSame(await packed.profile(ids, [FLOOR, FLOOR, FLOOR], T0, now, 50), await plain.profile(ids, [FLOOR, FLOOR, FLOOR], T0, now, 50), `seed ${seed}, again`);
    assert.equal(store.hourly.length, 0);
    assert.ok(packed.packed.hours >= 28 * ids.length && packed.packed.bytes > 0);
  }
});

test('one packed hour against its groups one by one: thresholds on a step\'s credit, steps that do not fall, cells of several groups, floor ties', () => {
  const h = T0 + 4 * HOUR, id = 'a:BTC';
  const g = (side: Side, price: number, t0: number, steps: [number, number][]): AbsorptionGroup => ({ id, side, price, t0, steps: steps.map(([c, u]): AbsorptionStep => [c, u, 1, t0, t0]) });
  const groups = [
    g('sell', 100, h + 5, [[100_000, 60_000], [50_000, 90_000], [30_000, 120_000]]),
    g('sell', 100, h + 9 * MIN, [[50_000, 10_000], [50_000, 15_000]]),
    g('buy', 100, h + 2 * MIN, [[100_000, 60_000], [40_000, 80_000], [70_000, 95_000]]),
    g('buy', 100.5, h + 2 * MIN + 1, [[45_000, 45_000], [35_000, 20_000]]),
    g('sell', 107, h + 59 * MIN, [[30_000, 30_000]]),
  ];
  // Minute 2 kept two groups, its floor the second's peak; minute 9 kept one at 50K; minute 30 kept none and left a 60K group out.
  const minutes: AbsorptionMinute[] = [{ id, t: h + 2 * MIN, n: 1, mean: 1, m2: 0, floor: 45_000 }, { id, t: h + 9 * MIN, n: 1, mean: 1, m2: 0, floor: 50_000 }, { id, t: h + 30 * MIN, n: 1, mean: 1, m2: 0, floor: 25_000 }];
  const packed = new AbsorptionHour(h, groups, minutes);
  for (const threshold of [0, 25_000, 30_000, 30_000.0001, 35_000, 40_000, 45_000, 50_000, 60_000, 70_000, 99_999, 100_000, 100_001]) for (const perMinute of [1, 2, 3]) for (const step of [0.5, 1, 5, 10]) {
    const a = new AbsorptionProfile(new Map([[id, threshold]]), h, h + HOUR, step, perMinute), b = new AbsorptionProfile(new Map([[id, threshold]]), h, h + HOUR, step, perMinute);
    a.hour(id, packed);
    for (const x of groups) b.add(x, true);
    for (const m of minutes) if (m.floor >= threshold) b.floor(id, m.t, m.floor);
    assertSame(a.answer(), b.answer(), `${threshold}, ${perMinute} a minute, on ${step}`);
  }
  const at = (threshold: number, perMinute = 10, floors = minutes): AbsorptionProfileAnswer => {
    const p = new AbsorptionProfile(new Map([[id, threshold]]), h, h + HOUR, 1, perMinute);
    p.hour(id, floors === minutes ? packed : new AbsorptionHour(h, groups, floors));
    return p.answer();
  };
  const minute = (m: number, floor: number): AbsorptionMinute => ({ id, t: h + m * MIN, n: 1, mean: 1, m2: 0, floor });
  assert.deepEqual(at(50_000).instruments[0]!.rows, [[100, 105_000, 60_000]], 'a step at the threshold is marked; a credit that rose again after a lower one is not');
  assert.deepEqual(at(30_000).instruments[0]!.rows, [[100, 135_000, 115_000], [107, 30_000, 0]], 'a step whose USD fell takes it off');
  assert.deepEqual([at(45_000, 2, [minute(2, 45_000)]).incomplete, at(45_000, 3, [minute(2, 45_000)]).incomplete, at(45_001, 2, [minute(2, 45_000)]).incomplete, at(44_999, 3, [minute(2, 45_000)]).incomplete],
    [[id], [], [], [id]], 'a minute at its floor is short when it kept as many groups reaching it as a minute keeps');
  assert.deepEqual([at(50_000, 1).incomplete, at(50_000, 2).incomplete, at(49_999, 2).incomplete], [[id], [], [id]], 'minute 9 kept one group at 50K');
  assert.deepEqual([at(25_000, 1, [minute(30, 25_000)]).incomplete, at(0, 10, [minute(30, 25_000)]).incomplete], [[], [id]], 'a minute that kept nothing ties at the base floor and is complete');
  const none = new AbsorptionProfile(new Map([[id, null]]), h, h + HOUR, 1);
  none.hour(id, packed);
  assert.equal(none.answer().instruments.length, 0, 'no threshold, nothing marked');
});

test('the server store: part hours at both ends read as they are, a group written twice counted once, its instruments listed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-hours-')), db = path.join(dir, 'depth.sqlite');
  const ids = ['x:BTC', 'y:BTC'], day = dayOf(5, 3_000, ids, T0, 8 * HOUR), now = T0 + 8 * HOUR + 40 * MIN;
  const store = new SqliteAbsorptionStore(db);
  try {
    store.save(day.groups, day.minutes, 0);
    // The same group again, other steps: the row written first stands, as after a restart.
    const again = day.groups.slice(0, 200).map(g => ({ ...g, steps: [[peakOf(g) + 5_000, 1, 1, g.t0, g.t0]] as AbsorptionStep[] }));
    store.save(again, [], 0);
    assert.deepEqual(store.instruments(), ids);
    const view: AbsorptionStore = { load: s => store.load(s), save: () => {}, query: (...a) => store.query(...a), minutes: (...a) => store.minutes(...a), eachHour: (...a) => store.eachHour(...a), close: () => {} };
    const packed = new AbsorptionRecorder(store, () => now), plain = new AbsorptionRecorder(view, () => now);
    for (const threshold of [FLOOR, day.credits[17]!, day.floors[3]!, 80_000]) for (const [from, to] of [[T0 + 13 * MIN + 7, now], [T0, T0 + 6 * HOUR], [T0 + HOUR + 1, T0 + 5 * HOUR - 1], [T0 + 2 * HOUR + 5, T0 + 2 * HOUR + 50 * MIN]]) {
      const label = `${threshold}, ${from! - T0}..${to! - T0}`, thresholds = [threshold, threshold];
      const got = await packed.profile(ids, thresholds, from!, to!, 5);
      assertSame(got, await plain.profile(ids, thresholds, from!, to!, 5), label);
      assertRows(got, referenceRows(day.groups, new Map(ids.map(id => [id, threshold])), from!, to!, 5), `${label}, against markedPart`);
    }
    assert.ok(packed.packed.hours >= 5 * ids.length);
    // The server's recorder packs as well.
    const server = new ServerAbsorptionRecorder(db, () => now);
    try {
      assertSame(await server.profile(ids, [FLOOR, FLOOR], T0, now, 5), await plain.profile(ids, [FLOOR, FLOOR], T0, now, 5), 'the server recorder');
      assert.equal(server.packed.hours, 6 * ids.length);
    } finally { server.close(); }
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the server store reads an hour back exactly as its rows hold it, prices to the last bit, and a row it cannot read as text is read alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-hours-')), db = path.join(dir, 'depth.sqlite'), rnd = seeded(12);
  const store = new SqliteAbsorptionStore(db);
  try {
    const groups: AbsorptionGroup[] = [];
    for (let i = 0; i < 2_000; i++) {
      const t0 = T0 + Math.floor(rnd() * 3 * HOUR), price = [0.1 + 0.2, 1 / 3, 80_000.00000000001, 1e-7 * (1 + rnd()), 1e300 * rnd(), 83_000 + rnd() * 1_000][i % 6]! + (i % 6 === 5 ? 0 : i * Number.EPSILON);
      groups.push({ id: i % 3 ? 'x:BTC' : 'y:BTC', side: rnd() < 0.5 ? 'buy' : 'sell', price, t0, steps: [[50_000 + rnd(), 1 / 3 + i, 1, t0, t0 + 1], [25_000.1, 7e-9 + i, 2, t0, t0 + 2]] });
    }
    store.save(groups, [{ id: 'x:BTC', t: T0 + MIN, n: 2, mean: 1 / 3, m2: 0.1, floor: 30_000.000000000004 }], 0);
    const rows = (id: string, hour: number): AbsorptionGroup[] => store.load(0).groups.filter(g => g.id === id && g.t0 >= hour && g.t0 < hour + HOUR);
    const key = (g: AbsorptionGroup): string => `${g.t0}|${g.side}|${g.price}`, sorted = (list: AbsorptionGroup[]): AbsorptionGroup[] => [...list].sort((a, b) => key(a) < key(b) ? -1 : 1);
    for (const id of ['x:BTC', 'y:BTC']) for (const hour of [T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 5 * HOUR]) assert.deepEqual(sorted(store.readHour(id, hour).groups), sorted(rows(id, hour)), `${id} ${hour - T0}`);
    assert.deepEqual(store.readHour('x:BTC', T0).minutes, [{ id: 'x:BTC', t: T0 + MIN, n: 2, mean: 1 / 3, m2: 0.1, floor: 30_000.000000000004 }]);
    // A row whose steps are not steps is left out either way; one that is not JSON at all has the hour read a row at a time.
    const raw = new DatabaseSync(db);
    raw.prepare('INSERT INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)').run('x:BTC', T0 + 7, 'buy', 1, 1, '[1,2]');
    raw.prepare('INSERT INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)').run('x:BTC', T0 + HOUR + 7, 'sell', 1, 1, '[[1,2,3,4,5]');
    raw.prepare('INSERT INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)').run('x:BTC', T0 + 2 * HOUR + 7, 'neither', 1, 1, '[[1,2,3,4,5]]');
    raw.close();
    for (const hour of [T0, T0 + HOUR, T0 + 2 * HOUR]) {
      const read = store.readHour('x:BTC', hour).groups;
      assert.deepEqual(sorted(read), sorted(rows('x:BTC', hour)), `with a broken row, ${hour - T0}`);
      assert.ok(read.length > 100 && !read.some(g => g.price === 1));
    }
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a table from before the one-row-a-group index loses its copies when first opened, the first row standing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-hours-')), db = path.join(dir, 'depth.sqlite');
  try {
    const old = new DatabaseSync(db);
    old.exec('CREATE TABLE absorption_groups (inst TEXT NOT NULL, t0 INTEGER NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, peak REAL NOT NULL, steps TEXT NOT NULL)');
    const insert = old.prepare('INSERT INTO absorption_groups (inst, t0, side, price, peak, steps) VALUES (?, ?, ?, ?, ?, ?)');
    for (const usd of [40_000, 90_000]) insert.run('x:BTC', T0, 'buy', 100, usd, JSON.stringify([[usd, usd, 1, T0, T0]]));
    insert.run('x:BTC', T0 + 1, 'buy', 100, 30_000, JSON.stringify([[30_000, 30_000, 1, T0 + 1, T0 + 1]]));
    old.close();
    for (let open = 0; open < 2; open++) {
      const store = new SqliteAbsorptionStore(db);
      try { assert.deepEqual(store.load(0).groups.map(g => [g.t0, peakOf(g)]), [[T0, 40_000], [T0 + 1, 30_000]], `opened ${open + 1} times`); } finally { store.close(); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the retention lets packed hours go with the groups the store lets go of, and an hour across its line is read as it is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'absorption-hours-')), db = path.join(dir, 'depth.sqlite');
  const ids = ['x:BTC', 'y:BTC'], day = dayOf(8, 3_000, ids, T0, 10 * HOUR);
  let now = T0 + 10 * HOUR + 5 * MIN;
  const store = new SqliteAbsorptionStore(db);
  try {
    store.save(day.groups, day.minutes, 0);
    const view: AbsorptionStore = { load: s => store.load(s), save: () => {}, query: (...a) => store.query(...a), minutes: (...a) => store.minutes(...a), eachHour: (...a) => store.eachHour(...a), close: () => {} };
    const recorder = new AbsorptionRecorder(store, () => now, { retentionMs: 6 * HOUR });
    assertSame(await recorder.profile(ids, [FLOOR, FLOOR], T0, now, 5), await new AbsorptionRecorder(view, () => now).profile(ids, [FLOOR, FLOOR], T0, now, 5), 'before');
    // Hours 5, 6 and 7 are whole, inside the retention and before memory; hour 4 crosses the retention's line.
    assert.equal(recorder.packed.hours, 3 * ids.length);
    now += 2 * HOUR;
    recorder.add('x:BTC', now - 1_000, 100, 50_000, 'buy'); recorder.step(true); recorder.flush();
    assert.equal(recorder.packed.hours, ids.length, 'hours 5 and 6 let go: the store no longer holds all of them');
    const kept = day.groups.filter(g => g.t0 >= now - 6 * HOUR);
    const got = await recorder.profile(ids, [FLOOR, FLOOR], T0, now, 5);
    assertSame(got, await new AbsorptionRecorder(view, () => now).profile(ids, [FLOOR, FLOOR], T0, now, 5), 'after');
    assertRows(got, referenceRows([...kept, { id: 'x:BTC', side: 'buy', price: 100, t0: now - 1_000, steps: [[50_000, 50_000, 1, now - 1_000, now - 1_000]] }], new Map(ids.map(id => [id, FLOOR])), T0, now, 5), 'after, against markedPart');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a group written to a packed hour has the hour packed again', async () => {
  const day = dayOf(3, 1_500, ['a:BTC'], T0, 8 * HOUR), store = new MemoryStore(day.groups, day.minutes);
  let now = T0 + 10 * HOUR;
  const recorder = new AbsorptionRecorder(store, () => now), ids = ['a:BTC', 'b:BTC'];
  // A fill two hours back (as a venue sends again after a restart), its minute not settled before memory moves on.
  recorder.add('b:BTC', T0 + 8 * HOUR + 30 * MIN, 123.5, 80_000, 'sell');
  now = T0 + 11 * HOUR + MIN; recorder.flush();
  const before = await recorder.profile(ids, [FLOOR, FLOOR], T0, T0 + 9 * HOUR, 0.5);
  assert.equal(before.instruments.find(i => i.id === 'b:BTC'), undefined);
  assert.ok(store.hourly.some(([id, hour]) => id === 'b:BTC' && hour === T0 + 8 * HOUR), 'the hour was packed without it');
  recorder.step(true); recorder.flush();
  const after = await recorder.profile(ids, [FLOOR, FLOOR], T0, T0 + 9 * HOUR, 0.5);
  assert.deepEqual(after.instruments.find(i => i.id === 'b:BTC')!.rows, [[123.5, 80_000, 0]]);
  assertSame(after, await new AbsorptionRecorder(store.plain(), () => now).profile(ids, [FLOOR, FLOOR], T0, T0 + 9 * HOUR, 0.5), 'against reading every group');
});

test('a room smaller than the question still answers it whole, keeps within the room, and lets the oldest asked go', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], day = dayOf(4, 6_000, ids, T0, 30 * HOUR), store = new MemoryStore(day.groups, day.minutes);
  let now = T0 + 30 * HOUR;
  const one = new AbsorptionHour(T0, day.groups.filter(g => g.id === 'a:BTC' && g.t0 < T0 + HOUR), []).bytes, room = 12 * one;
  const recorder = new AbsorptionRecorder(store, () => now, { hourBytes: room }), plain = new AbsorptionRecorder(store.plain(), () => now);
  for (let round = 0; round < 3; round++) {
    store.hourly.length = 0;
    assertSame(await recorder.profile(ids, [FLOOR, 40_000, 90_000], T0, now, 10), await plain.profile(ids, [FLOOR, 40_000, 90_000], T0, now, 10), `round ${round}`);
    assert.ok(recorder.packed.bytes <= room && recorder.packed.hours > 0, `round ${round}: ${recorder.packed.bytes} of ${room}`);
    assert.ok(store.hourly.length > 28 * ids.length - recorder.packed.hours - 1, `round ${round}: what is not held is read again`);
    now += 60_000;
  }
});

test('warming packs the stored hours newest first, within half the room, and a question then reads none of them', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], day = dayOf(6, 6_000, ids, T0, 30 * HOUR), now = T0 + 30 * HOUR;
  const store = new MemoryStore(day.groups, day.minutes), recorder = new AbsorptionRecorder(store, () => now, { retentionMs: 40 * HOUR });
  await recorder.warm();
  // Back to the retention's line, 40 hours, less the two memory holds.
  assert.equal(store.hourly.length, 38 * ids.length);
  assert.deepEqual(store.hourly.slice(0, 3), ids.map(id => [id, now - 3 * HOUR]), 'newest first');
  store.hourly.length = 0;
  assertSame(await recorder.profile(ids, [FLOOR, 50_000, null], T0, now, 25), await new AbsorptionRecorder(store.plain(), () => now).profile(ids, [FLOOR, 50_000, null], T0, now, 25), 'warmed');
  assert.equal(store.hourly.length, 0);
  // A small room: it stops once half of it is taken; closed, it packs nothing.
  const small = new AbsorptionRecorder(store, () => now, { hourBytes: 200_000 });
  await small.warm();
  assert.ok(small.packed.bytes >= 100_000 && small.packed.bytes < 150_000, `${small.packed.bytes}`);
  const closed = new AbsorptionRecorder(store, () => now);
  closed.close(); await closed.warm();
  assert.equal(closed.packed.hours, 0);
});

test('packing ahead waits while a question reads', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], day = dayOf(10, 6_000, ids, T0, 30 * HOUR), now = T0 + 30 * HOUR, clock = { t: 0 };
  const store = new MemoryStore(day.groups, day.minutes, true, clock), recorder = new AbsorptionRecorder(store, () => now);
  // Each hour read moves the clock `performance.now` reads by 3 ms, so packing ahead stops after its first three before the question starts.
  store.readCost = 3;
  Object.defineProperty(performance, 'now', { value: () => clock.t, configurable: true, writable: true });
  try {
    const warming = recorder.warm(), before = store.hourly.length;
    assert.equal(before, 3);
    const answer = await recorder.profile(['a:BTC'], [FLOOR], T0, now, 10), asked = store.hourly.length;
    assert.ok(store.hourly.slice(before).every(([id]) => id === 'a:BTC'), 'nothing packed ahead meanwhile');
    assert.ok(asked - before >= 20 && answer.instruments.length === 1);
    await warming;
    assert.ok(store.hourly.slice(asked).some(([id]) => id === 'c:BTC'), 'and it went on after');
  } finally { delete (performance as { now?: unknown }).now; }
});

test('packing and answering let the event loop go every few milliseconds', async () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], day = dayOf(9, 3_000, ids, T0, 40 * HOUR), now = T0 + 42 * HOUR, clock = { t: 0 };
  const store = new MemoryStore(day.groups, day.minutes, true, clock);
  store.readCost = 3;
  // `performance.now` reads a clock each hour read moves on by 3 ms; the longest stretch between two turns of the loop is measured on it.
  Object.defineProperty(performance, 'now', { value: () => clock.t, configurable: true, writable: true });
  try {
    for (const run of [(r: AbsorptionRecorder) => r.profile(ids, [FLOOR, FLOOR, FLOOR], T0, now, 10), (r: AbsorptionRecorder) => r.warm()]) {
      const recorder = new AbsorptionRecorder(store, () => now, { retentionMs: 48 * HOUR });
      let done = false, last = clock.t, longest = 0, turns = 0;
      // A turn of the loop runs this once and the recorder's next stretch once (both wait as `setImmediate` does).
      const tick = (): void => { longest = Math.max(longest, clock.t - last); last = clock.t; turns++; if (!done) setImmediate(tick); };
      setImmediate(tick);
      const reads = store.hourly.length;
      await run(recorder); done = true;
      assert.ok(store.hourly.length - reads >= 40 * ids.length, 'cold: every whole hour read');
      assert.ok(longest <= 12, `held for ${longest} ms`);
      assert.ok(turns >= 10, `${turns} turns`);
    }
  } finally { delete (performance as { now?: unknown }).now; }
});
