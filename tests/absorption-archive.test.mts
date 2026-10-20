import test from 'node:test';
import assert from 'node:assert/strict';
import { AbsorptionArchive } from '../src/shared/absorption-archive.ts';
import { AbsorptionRecorder, hoursOf, markedPart, peakOf, type AbsorptionGroup, type AbsorptionMinute, type AbsorptionProfileAnswer, type AbsorptionStep, type AbsorptionStore } from '../src/shared/absorption.ts';
import { binOf } from '../src/shared/footprint.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR, T0 = 1_800_000_000_000;
type Side = 'buy' | 'sell';
const seeded = (seed: number): (() => number) => { let s = seed >>> 0; return () => (s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32; };
const keyOf = (g: AbsorptionGroup): string => `${g.id}|${g.side}|${g.price}|${g.t0}`;

/** `n` groups over [from, from + span), at most `cap` an instrument and minute, every key once; fractional times and prices among them. */
function groupsOf(seed: number, n: number, ids: readonly string[], from: number, span: number): AbsorptionGroup[] {
  const rnd = seeded(seed), out: AbsorptionGroup[] = [], keys = new Set<string>();
  while (out.length < n) {
    const id = ids[Math.floor(rnd() * ids.length)]!, side: Side = rnd() < 0.5 ? 'buy' : 'sell', t0 = from + Math.floor(rnd() * span) + (rnd() < 0.1 ? 0.25 : 0);
    const price = 80_000 + Math.round(rnd() * 200_000) / 100, key = `${id}|${side}|${price}|${t0}`;
    if (keys.has(key)) continue; keys.add(key);
    let credit = 25_000 + Math.floor(rnd() * 600_000), usd = 0, fills = 0;
    const steps: AbsorptionStep[] = [];
    for (let k = 1 + Math.floor(rnd() * 4); k > 0 && credit >= 25_000; k--) {
      usd += 1_000 + Math.floor(rnd() * credit); fills += 1 + Math.floor(rnd() * 4);
      steps.push([credit, usd, fills, t0 + Math.floor(rnd() * 3), t0 + 3 + Math.floor(rnd() * 9) + 0.5]);
      credit = Math.floor(credit * (0.3 + rnd() * 0.6));
    }
    out.push({ id, side, price, t0, steps });
  }
  return out;
}

/** The column the slow way (as tests/absorption-profile.test.mts): every group's marked part on the row of its price. */
function referenceRows(groups: readonly AbsorptionGroup[], thresholds: ReadonlyMap<string, number | null>, from: number, to: number, step: number): Map<string, Map<number, [number, number]>> {
  const out = new Map<string, Map<number, [number, number]>>();
  for (const g of groups) {
    const threshold = thresholds.get(g.id);
    if (threshold === null || threshold === undefined || g.t0 < from || g.t0 >= to) continue;
    const part = markedPart(g, threshold); if (!part) continue;
    let rows = out.get(g.id); if (!rows) { rows = new Map(); out.set(g.id, rows); }
    const price = binOf(g.price, step) * step, cell = rows.get(price) ?? [0, 0];
    cell[g.side === 'sell' ? 0 : 1] += part.usd; rows.set(price, cell);
  }
  return out;
}
function assertRows(answer: AbsorptionProfileAnswer, want: Map<string, Map<number, [number, number]>>, label: string): void {
  assert.deepEqual(answer.instruments.map(i => i.id).sort(), [...want.keys()].sort(), `${label}: the instruments`);
  for (const i of answer.instruments) {
    const rows = want.get(i.id)!;
    assert.deepEqual(i.rows.map(r => r[0]), [...rows.keys()].sort((a, b) => a - b), `${label}: ${i.id}'s rows`);
    for (const [price, a, b] of i.rows) { const [wa, wb] = rows.get(price)!; assert.ok(Math.abs(a - wa) <= 1e-9 * Math.max(1, wa) && Math.abs(b - wb) <= 1e-9 * Math.max(1, wb), `${label}: ${i.id} at ${price}`); }
  }
}

/** A store that keeps what is saved (the first minute stands, a group once) and records each range it hands over. */
class MemoryStore implements AbsorptionStore {
  /** The column's reads, and the recorder's reading its day back. */
  readonly asked: [number, number][] = [];
  readonly readBack: [number, number][] = [];
  readonly groups = new Map<string, AbsorptionGroup>();
  readonly stored = new Map<string, AbsorptionMinute>();
  failNext = false;
  constructor(groups: readonly AbsorptionGroup[] = [], minutes: readonly AbsorptionMinute[] = []) { for (const g of groups) this.groups.set(keyOf(g), g); for (const m of minutes) this.stored.set(`${m.id}|${m.t}`, m); }
  load(since: number): { groups: AbsorptionGroup[]; minutes: AbsorptionMinute[] } {
    // What a page reads when its database opens: the last two hours (app/browser/idb.ts).
    return { groups: [...this.groups.values()].filter(g => g.t0 >= since), minutes: [...this.stored.values()].filter(m => m.t >= since) };
  }
  save(groups: AbsorptionGroup[], minutes: AbsorptionMinute[], expireBefore: number): void {
    for (const g of groups) if (!this.groups.has(keyOf(g))) this.groups.set(keyOf(g), g);
    for (const m of minutes) if (!this.stored.has(`${m.id}|${m.t}`)) this.stored.set(`${m.id}|${m.t}`, m);
    for (const [k, g] of this.groups) if (g.t0 < expireBefore) this.groups.delete(k);
    for (const [k, m] of this.stored) if (m.t < expireBefore) this.stored.delete(k);
  }
  query(ids: readonly string[], mins: readonly number[], from: number, to: number, limit: number): AbsorptionGroup[] {
    const min = new Map(ids.map((id, i) => [id, mins[i]!])), byId = new Map<string, AbsorptionGroup[]>();
    for (const g of this.groups.values()) if (g.t0 >= from && g.t0 < to && peakOf(g) >= (min.get(g.id) ?? Infinity)) { const list = byId.get(g.id) ?? []; list.push(g); byId.set(g.id, list); }
    return [...byId.values()].flatMap(list => list.sort((a, b) => peakOf(b) - peakOf(a)).slice(0, limit));
  }
  minutes(ids: readonly string[], from: number, to: number): AbsorptionMinute[] { const wanted = new Set(ids); return [...this.stored.values()].filter(m => wanted.has(m.id) && m.t >= from && m.t < to); }
  async eachHour(ids: readonly string[] | null, mins: readonly number[], from: number, to: number, take: (groups: readonly AbsorptionGroup[], minutes: readonly AbsorptionMinute[]) => void): Promise<void> {
    const min = ids ? new Map(ids.map((id, i) => [id, mins[i]!])) : null, passes = (id: string, v: number): boolean => !min || v >= (min.get(id) ?? Infinity);
    for (const hour of hoursOf(from, to)) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.failNext) { this.failNext = false; throw new Error('the store failed'); }
      (ids ? this.asked : this.readBack).push([hour.from, hour.to]);
      take([...this.groups.values()].filter(g => g.t0 >= hour.from && g.t0 < hour.to && passes(g.id, peakOf(g))),
        [...this.stored.values()].filter(m => m.t >= hour.from && m.t < hour.to && passes(m.id, m.floor)));
    }
  }
  close(): void {}
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const peaksOf = (groups: readonly AbsorptionGroup[], id: string): number[] => groups.filter(g => g.id === id).map(peakOf).sort((a, b) => b - a);

test('the archive gives back every group and minute as it was given, judges as markedPart does, and lets go of what is older', () => {
  const ids = ['a:BTC', 'b:BTC', 'c:BTC'], groups = groupsOf(4, 6_000, ids, T0, 6 * HOUR), archive = new AbsorptionArchive();
  for (const g of groups) archive.addGroup(g);
  const all = (from: number, to: number): AbsorptionGroup[] => { const out: AbsorptionGroup[] = []; archive.eachGroup(from, to, new Map(ids.map(id => [id, 0])), g => out.push(g)); return out; };
  const sorted = (list: readonly AbsorptionGroup[]): AbsorptionGroup[] => [...list].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : 1);
  assert.equal(archive.size, groups.length);
  assert.deepEqual(sorted(all(-Infinity, Infinity)), sorted(groups), 'exactly, fractional times included');
  const from = T0 + 90 * MIN + 0.25, to = T0 + 4 * HOUR + 17;
  assert.deepEqual(sorted(all(from, to)), sorted(groups.filter(g => g.t0 >= from && g.t0 < to)), 'half open, cut inside hours');
  const mins = new Map([['a:BTC', 200_000], ['b:BTC', 30_000]]), some: AbsorptionGroup[] = [];
  archive.eachGroup(from, to, mins, g => some.push(g));
  assert.deepEqual(sorted(some), sorted(groups.filter(g => g.t0 >= from && g.t0 < to && peakOf(g) >= (mins.get(g.id) ?? Infinity))), 'from each one\'s own amount; c:BTC not asked for');
  for (const threshold of [25_000, 99_999.5, 300_000]) {
    const marked = new Map<string, number>();
    archive.eachMarked(from, to, new Map([['a:BTC', threshold], ['b:BTC', threshold], ['c:BTC', null]]), (id, side, price, t0, usd) => marked.set(`${id}|${side}|${price}|${t0}`, usd));
    const want = new Map(groups.filter(g => g.id !== 'c:BTC' && g.t0 >= from && g.t0 < to).flatMap(g => { const part = markedPart(g, threshold); return part ? [[keyOf(g), part.usd] as const] : []; }));
    assert.deepEqual(marked, want, `marked at ${threshold}`);
  }
  // Packed tight once the hours are over: some 23 bytes a group and 36 a step, where objects took about 400 a group.
  archive.compact(Infinity);
  const steps = groups.reduce((n, g) => n + g.steps.length, 0);
  assert.equal(archive.bytes, groups.length * 23 + steps * 36 + 6 * 4, `${(archive.bytes / groups.length).toFixed(0)} bytes a group`);
  // Minutes: the first of a minute stands.
  assert.equal(archive.addMinute({ id: 'a:BTC', t: T0 + 61 * MIN, n: 2, mean: 3, m2: 4, floor: 30_000 }), true);
  assert.equal(archive.addMinute({ id: 'a:BTC', t: T0 + 61 * MIN, n: 9, mean: 9, m2: 9, floor: 99_000 }), false);
  archive.addMinute({ id: 'b:BTC', t: T0 + 59 * MIN, n: 1, mean: 1, m2: 0, floor: 25_000 });
  const minutes = (from: number, to: number): AbsorptionMinute[] => { const out: AbsorptionMinute[] = []; archive.eachMinute(['a:BTC', 'b:BTC', 'z:BTC'], from, to, m => out.push(m)); return out.sort((x, y) => x.t - y.t); };
  assert.deepEqual(minutes(T0, T0 + 2 * HOUR), [{ id: 'b:BTC', t: T0 + 59 * MIN, n: 1, mean: 1, m2: 0, floor: 25_000 }, { id: 'a:BTC', t: T0 + 61 * MIN, n: 2, mean: 3, m2: 4, floor: 30_000 }]);
  // Letting go: whole hours before the cutoff, and nothing before it is read from the hour it falls in.
  const cutoff = T0 + 60 * MIN + 30_000;
  archive.expire(cutoff);
  assert.deepEqual(sorted(all(-Infinity, Infinity)), sorted(groups.filter(g => g.t0 >= cutoff)));
  assert.equal(archive.size, groups.filter(g => g.t0 >= cutoff).length);
  assert.deepEqual(minutes(T0, T0 + 2 * HOUR).map(m => m.t), [T0 + 61 * MIN]);
  const bytes = archive.bytes;
  archive.addGroup({ ...groups[0]!, t0: cutoff - 1 });
  assert.deepEqual([archive.size, archive.bytes], [groups.filter(g => g.t0 >= cutoff).length, bytes], 'a group older than what is kept is not held');
});

test('a page\'s recorder holds a day: the last two hours at once, the rest read back newest first, and the column then reads nothing', async () => {
  const ids = ['a:BTC', 'b:BTC'], end = T0 + DAY, groups = groupsOf(8, 20_000, ids, T0 + 30_000, DAY - 60_000);
  const minutes: AbsorptionMinute[] = [];
  for (let t = T0; t < end; t += MIN) for (const id of ids) minutes.push({ id, t, n: 3, mean: 1_000, m2: 10, floor: t === T0 + 5 * HOUR && id === 'a:BTC' ? 400_000 : 25_000 });
  const store = new MemoryStore(groups, minutes), recorder = new AbsorptionRecorder(store, () => end, { memoryMs: DAY });
  const thresholds = new Map<string, number | null>([['a:BTC', 120_000], ['b:BTC', 60_000]]);
  const ask = (from: number, to: number): Promise<AbsorptionProfileAnswer> => recorder.profile(ids, ids.map(id => thresholds.get(id)!), from, to, 25);
  assert.equal(recorder.memoryFrom, end - 2 * HOUR, 'the two hours read when the page opened');
  // While the rest is read back, every answer is whole: memory answers its part, the store the rest.
  const hydrating = recorder.hydrate();
  for (let i = 0; i < 12; i++) {
    await turn();
    const answer = await ask(T0, end);
    assertRows(answer, referenceRows(groups, thresholds, T0, end, 25), `while reading back (${i})`);
    assert.deepEqual(answer.incomplete, ['a:BTC'], 'a minute at 400K left out a group a:BTC marks at 120K');
  }
  await hydrating;
  assert.equal(recorder.memoryFrom, end - DAY);
  assert.equal(recorder.held.groups, groups.length);
  assert.equal(store.readBack.length, 22 * 4, 'a quarter of an hour at a time');
  assert.ok(store.readBack.every(([a, b], i) => b - a === 15 * MIN && (i === 0 || b === store.readBack[i - 1]![0])), 'newest first, each joining the one before');
  store.asked.length = 0;
  for (const [from, to] of [[T0, end], [T0 + 3 * HOUR + 7, T0 + 9 * HOUR], [end - 30 * MIN, end]] as const) assertRows(await ask(from, to), referenceRows(groups, thresholds, from, to, 25), `held: ${from - T0}..${to - T0}`);
  assert.deepEqual((await ask(T0, end)).incomplete, ['a:BTC']);
  assert.deepEqual(store.asked, [], 'the store is not read');
  // The marks' question is answered from memory too, each instrument's largest first.
  const marks = await recorder.query(ids, [300_000, 300_000], T0, end, 5, end - 30 * MIN);
  for (const id of ids) assert.deepEqual(peaksOf(marks.groups, id), peaksOf(groups.filter(g => peakOf(g) >= 300_000), id).slice(0, 5), id);
  assert.deepEqual(marks.capped.sort(), ids);
  assert.equal(marks.minutes.length, 2 * 30);
  assert.deepEqual(store.asked, [], 'nor for the marks');
});

test('reading back stops where the store failed and goes on from there next time; a recorder that closed installs nothing', async () => {
  const ids = ['a:BTC'], end = T0 + DAY, groups = groupsOf(2, 3_000, ids, T0 + 1_000, DAY - 2_000), thresholds = new Map([['a:BTC', 50_000]]);
  const store = new MemoryStore(groups), recorder = new AbsorptionRecorder(store, () => end, { memoryMs: DAY });
  const reading = recorder.hydrate();
  for (let i = 0; i < 6; i++) await turn();
  store.failNext = true;
  await reading;
  const stopped = recorder.memoryFrom;
  assert.ok(stopped < end - 2 * HOUR && stopped > end - DAY && (stopped - T0) % (15 * MIN) === 0, `some quarters installed, each whole (${(end - stopped) / MIN} min)`);
  assertRows(await recorder.profile(ids, [50_000], T0, end, 10), referenceRows(groups, thresholds, T0, end, 10), 'whole after a failure');
  await recorder.hydrate();
  assert.equal(recorder.memoryFrom, end - DAY, 'the next attempt goes on from there');
  assertRows(await recorder.profile(ids, [50_000], T0, end, 10), referenceRows(groups, thresholds, T0, end, 10), 'whole after it');
  const closing = new AbsorptionRecorder(new MemoryStore(groups), () => end, { memoryMs: DAY }), late = closing.hydrate();
  closing.close(); await late;
  assert.equal(closing.memoryFrom, end - 2 * HOUR, 'nothing installed once closed');
});

test('a day of live groups goes into the archive as minutes settle, the oldest let go, and history sent again is still left out', async () => {
  let now = T0;
  const store = new MemoryStore(), recorder = new AbsorptionRecorder(store, () => now, { memoryMs: DAY });
  const found: AbsorptionGroup[] = [], rnd = seeded(5);
  // A fill every ten seconds for 26 hours on two instruments, each a group of its own.
  for (let t = T0 + 500; t < T0 + 26 * HOUR; t += 10_000) {
    now = t + 300;
    recorder.add(rnd() < 0.5 ? 'a:BTC' : 'b:BTC', t, 100 + Math.floor(rnd() * 50), 25_000 + Math.floor(rnd() * 100_000), 'buy');
    if (t % MIN < 10_000) { recorder.step(); found.push(...recorder.takeFresh().groups); recorder.flush(); }
  }
  now += 10 * MIN; recorder.step(true); found.push(...recorder.takeFresh().groups); recorder.flush();
  const kept = found.filter(g => g.t0 >= now - DAY), thresholds = new Map([['a:BTC', 60_000], ['b:BTC', 60_000]]);
  assert.equal(recorder.memoryFrom, now - DAY);
  assert.equal(recorder.held.groups, kept.length, 'a day held, the two hours before it let go');
  assert.equal(store.groups.size, found.length, 'and every one written');
  assertRows(await recorder.profile(['a:BTC', 'b:BTC'], [60_000, 60_000], now - DAY, now, 1), referenceRows(kept, thresholds, now - DAY, now, 1), 'the day');
  assert.deepEqual(store.asked, []);
  // A venue sending yesterday's trades again (it does after a reconnect): left out, as before memory held a day.
  recorder.add('a:BTC', now - 20 * HOUR, 120, 900_000, 'buy');
  recorder.add('c:BTC', now - 3 * HOUR, 120, 900_000, 'buy');
  assert.deepEqual([recorder.lateFills('a:BTC'), recorder.lateFills('c:BTC')], [1, 1]);
});

test('a reload reads the day back from what the last page saved', async () => {
  let now = T0;
  const store = new MemoryStore(), first = new AbsorptionRecorder(store, () => now, { memoryMs: DAY }), rnd = seeded(6), found: AbsorptionGroup[] = [];
  for (let t = T0 + 500; t < T0 + 10 * HOUR; t += 15_000) { now = t + 300; first.add('a:BTC', t, 100 + Math.floor(rnd() * 20), 30_000 + Math.floor(rnd() * 90_000), rnd() < 0.5 ? 'buy' : 'sell'); if (t % MIN < 15_000) first.step(); }
  now += 5 * MIN; first.close(); found.push(...first.takeFresh().groups);
  now += 20 * MIN;
  const second = new AbsorptionRecorder(store, () => now, { memoryMs: DAY });
  assert.equal(second.held.groups, found.filter(g => g.t0 >= now - 2 * HOUR).length, 'two hours at once');
  await second.hydrate();
  assert.equal(second.held.groups, found.length);
  assertRows(await second.profile(['a:BTC'], [45_000], T0, now, 5), referenceRows(found, new Map([['a:BTC', 45_000]]), T0, now, 5), 'the whole recording');
  assert.deepEqual(store.asked, []);
});

test('a server\'s recorder keeps two hours in memory, as before', async () => {
  const groups = groupsOf(3, 500, ['a:BTC'], T0, 6 * HOUR), store = new MemoryStore(groups), recorder = new AbsorptionRecorder(store, () => T0 + 6 * HOUR);
  await recorder.hydrate();
  assert.equal(recorder.memoryFrom, T0 + 4 * HOUR);
  assert.deepEqual(store.readBack, []);
  assertRows(await recorder.profile(['a:BTC'], [40_000], T0, T0 + 6 * HOUR, 10), referenceRows(groups, new Map([['a:BTC', 40_000]]), T0, T0 + 6 * HOUR, 10), 'store and memory');
  assert.ok(store.asked.length === 4);
});
