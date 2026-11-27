import test from 'node:test';
import assert from 'node:assert/strict';
import { Cooldowns, ImbalanceWatch, RateCap, WallWatch, bookBins, biggest, imbalanceOf } from '../src/app/sound/alert-rules.ts';
import { Alerts, type Player } from '../src/app/sound/alerts.ts';
import { DEFAULT_PANEL_SOUNDS, alertNotes, readPanelSounds, readSounds, type AlertKind, type Note } from '../src/app/sound/rules.ts';
import { FlowBook } from '../src/app/flow-book.ts';
import { initialState, type AppState } from '../src/app/store.ts';
import type { LevelsFrame } from '../src/app/wire.ts';
import { setUnits } from '../src/app/units.ts';

// ---- Cool-downs and the cap -------------------------------------------------------------------------------------------------------

test('a cool-down is per key and lasts its time; the cap counts every kind together', () => {
  const c = new Cooldowns();
  assert.equal(c.take('a', 0, 1_000), true); assert.equal(c.take('a', 999, 1_000), false); assert.equal(c.take('b', 999, 1_000), true); assert.equal(c.take('a', 1_000, 1_000), true);
  const cap = new RateCap(2, 10_000);
  assert.deepEqual([0, 1_000, 2_000, 10_500].map(t => cap.allow(t)), [true, true, false, true], 'the first two have aged out by 10.5 s');
});

// ---- The book ---------------------------------------------------------------------------------------------------------------------

const MARK = 100_000;
const side = (levels: [number, number][]) => ({ lo: Float64Array.from(levels.map(l => l[0])), hi: Float64Array.from(levels.map(l => l[0])), usd: Float64Array.from(levels.map(l => l[1])) });
function frame(bids: [number, number][], asks: [number, number][], id = 'a:BTC', asOf = 0): LevelsFrame {
  return { asOf, books: [{ id, venue: id.split(':')[0]!, timestamp: asOf, coarse: false, bids: side(bids), asks: side(asks) }] };
}

test('bins add the books of the chosen instruments on the right side of the price, within the range', () => {
  const f: LevelsFrame = { asOf: 0, books: [
    ...frame([[99_990, 1_000_000], [99_000, 5_000_000], [90_000, 9e9], [100_010, 777]], [[100_010, 2_000_000], [101_500, 9e9], [99_000, 555]], 'a:BTC').books,
    ...frame([[99_991, 3_000_000]], [], 'b:BTC').books,
    ...frame([[99_995, 8_000_000]], [], 'c:BTC').books,
  ] };
  const bins = bookBins(f, new Set(['a:BTC', 'b:BTC']), MARK, 0.01);
  assert.equal(bins.bidTotal, 1_000_000 + 5_000_000 + 3_000_000, 'c is not chosen; 90,000 is out of range; a bid above the price is not a bid');
  assert.equal(bins.askTotal, 2_000_000, '101,500 is out of range; an ask below the price is not an ask');
  assert.equal(bins.bid.get(Math.floor(99_990 / bins.bin)), 4_000_000, 'a and b at 99,990 and 99,991 share a 2 bp bin (20 USD wide)');
  const top = biggest(bins);
  assert.equal(top.bid!.usd, 5_000_000, 'the biggest bin is the 5M level at 99,000');
  assert.ok(Math.abs(top.bid!.price - 99_000) < 20);
  assert.ok(Math.abs(imbalanceOf(bins) - (9_000_000 - 2_000_000) / 11_000_000) < 1e-12);
  assert.equal(imbalanceOf(bookBins(null, new Set(), MARK, 0.01)), 0);
});

test("a grouped venue's band is spread over the bins it covers, and counts by the part on its own side of the price", () => {
  // A $100 group of bids (five 20-dollar bins) and an ask group the mark cuts in two.
  const band = (rows: [number, number, number][]) => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
  const f: LevelsFrame = { asOf: 0, books: [{ id: 'hl:BTC', venue: 'hl', timestamp: 0, coarse: true, bids: band([[99_800, 99_900, 5_000_000]]), asks: band([[99_960, 100_060, 2_000_000]]) }] };
  const bins = bookBins(f, new Set(['hl:BTC']), MARK, 0.01);
  assert.equal(bins.bidTotal, 5_000_000);
  assert.equal(biggest(bins).bid!.usd, 1_000_000, 'a fifth of the group in each bin, not all of it at its middle');
  assert.ok(Math.abs(bins.askTotal - 1_200_000) < 1e-6, 'the 60 dollars of the ask group above the mark count (3/5 of it), the 40 below do not');
  // A grouped venue's shared top group split at an estimate of the touch (`splitTouch`) is spread over its whole span: a split that moves
  // with the trades does not squeeze the group into fewer bins, which would sound as a wall appearing.
  const split = (cut: number): LevelsFrame => ({ asOf: 0, books: [{ id: 'hl:BTC', venue: 'hl', timestamp: 0, coarse: true, touch: { lo: 99_900, hi: 100_000 },
    bids: band([[99_900, cut, 20_000_000], [99_800, 99_900, 1_000_000]]), asks: band([[cut, 100_000, 3_000_000]]) }] });
  const middle = bookBins(split(99_950), new Set(['hl:BTC']), MARK, 0.01), edge = bookBins(split(99_912.5), new Set(['hl:BTC']), MARK, 0.01);
  assert.deepEqual([...edge.bid].sort((x, y) => x[0] - y[0]), [...middle.bid].sort((x, y) => x[0] - y[0]));
  assert.equal(biggest(middle).bid!.usd, 4_000_000, 'the $20M group over its five bins');
  // The totals count the top groups in full on their own side, wherever the mark sits in the span (here at its top: no ask bins).
  for (const b of [middle, edge]) assert.deepEqual([b.bidTotal, b.askTotal], [21_000_000, 3_000_000]);
  const inside = bookBins(split(99_950), new Set(['hl:BTC']), 99_960, 0.01);
  assert.deepEqual([inside.bidTotal, inside.askTotal], [21_000_000, 3_000_000], 'and with the mark inside the span');
});

const wall = (usd: number, price = 99_900): LevelsFrame => frame([[price, usd], [99_000, 100_000]], [[100_100, 100_000]]);

test('a wall that is there at the start is not news; one that appears later, after the book has settled, is', () => {
  const w = new WallWatch(), ids = new Set(['a:BTC']), at = (t: number, f: LevelsFrame) => w.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  assert.deepEqual(at(0, wall(30_000_000)), [], 'present from the start');
  assert.deepEqual(at(2_000, wall(30_000_000)), []);
  const w2 = new WallWatch(), at2 = (t: number, f: LevelsFrame) => w2.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  at2(0, wall(1_000_000)); at2(2_000, wall(1_000_000));
  assert.deepEqual(at2(4_000, wall(30_000_000)), [], 'inside the first ten seconds nothing sounds');
  at2(6_000, wall(1_000_000)); at2(12_000, wall(1_000_000));
  const signals = at2(14_000, wall(30_000_000));
  assert.deepEqual(signals.map(s => [s.kind, s.side, s.usd]), [['appeared', 'buy', 30_000_000]]);
  assert.deepEqual(at2(16_000, wall(30_000_000)), [], 'once, not on every look');
});

test('a wall that stood and then vanished is pulled, unless the price came to it', () => {
  const ids = new Set(['a:BTC']);
  const run = (markNow: number) => {
    const w = new WallWatch(), at = (t: number, f: LevelsFrame, mark = MARK) => w.update(t, bookBins(f, ids, mark, 0.01), mark, 10_000_000);
    for (let t = 0; t <= 12_000; t += 2_000) at(t, wall(1_000_000));
    assert.equal(at(14_000, wall(25_000_000)).length, 1, 'appeared');
    for (let t = 16_000; t <= 22_000; t += 2_000) at(t, wall(25_000_000));
    return at(24_000, wall(500_000), markNow);
  };
  assert.deepEqual(run(MARK).map(s => [s.kind, s.side]), [['pulled', 'buy']]);
  assert.deepEqual(run(99_905), [], 'the price is at the wall: it was eaten, not pulled');
});

test('ask walls sound as sells, and a wall must stand five seconds before pulling it counts', () => {
  const ids = new Set(['a:BTC']), w = new WallWatch(), at = (t: number, f: LevelsFrame) => w.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  const ask = (usd: number) => frame([[99_900, 100_000]], [[100_150, usd]]);
  for (let t = 0; t <= 12_000; t += 2_000) at(t, ask(1_000_000));
  assert.deepEqual(at(14_000, ask(40_000_000)).map(s => [s.kind, s.side]), [['appeared', 'sell']]);
  assert.deepEqual(at(16_000, ask(100_000)), [], 'gone after two seconds: it never stood');
  assert.deepEqual([18_000, 20_000, 22_000].flatMap(t => at(t, ask(100_000))), [], 'and it is not called pulled later either');
});

test('a wall that moved a bin keeps its standing; one seen during warm-up is not news; one the range left behind is not pulled', () => {
  const ids = new Set(['a:BTC']), watch = () => { const w = new WallWatch(); return (t: number, f: LevelsFrame, mark = MARK) => w.update(t, bookBins(f, ids, mark, 0.01), mark, 10_000_000); };
  const at = watch();
  for (let t = 0; t <= 12_000; t += 2_000) at(t, wall(1_000_000));
  assert.equal(at(14_000, wall(30_000_000, 99_900)).length, 1, 'appeared');
  at(16_000, wall(30_000_000, 99_920)); at(18_000, wall(30_000_000, 99_920));
  assert.deepEqual(at(20_000, wall(500_000, 99_920)).map(s => s.kind), ['pulled'], 'moved one bin at 16 s, it had still stood six seconds');
  const early = watch();
  early(0, wall(1_000_000)); early(2_000, wall(1_000_000));
  assert.deepEqual([4_000, 6_000, 8_000, 10_000, 12_000].flatMap(t => early(t, wall(30_000_000))), [], 'it came while the book was arriving');
  const left = watch();
  for (let t = 0; t <= 12_000; t += 2_000) left(t, wall(30_000_000, 99_000));
  assert.deepEqual(left(14_000, wall(30_000_000, 99_000), 100_011), [], 'the 1 % range moved past it: not seen, not pulled');
  // A small price: the wall's bin is judged on its edges, so the mark at the wall's own price reached it.
  const tiny = new WallWatch(), small = (usd: number): LevelsFrame => frame([[0.000001, usd]], [[0.0000011, 1]]);
  const look = (t: number, usd: number) => tiny.update(t, bookBins(small(usd), ids, 0.000001, 0.01), 0.000001, 100_000);
  for (let t = 0; t <= 12_000; t += 2_000) look(t, 300_000);
  assert.deepEqual(look(14_000, 1_000), [], 'the price is at the wall: it was eaten, not pulled');
});

test('a tracked wall stays itself: a bigger wall close by does not take its place, one far away does not hide its move', () => {
  const ids = new Set(['a:BTC']), two = (a: [number, number] | null, b: [number, number] | null): LevelsFrame => frame([...(a ? [a] : []), ...(b ? [b] : []), [99_000, 100_000]], [[100_100, 100_000]]);
  const w = new WallWatch(), at = (t: number, f: LevelsFrame) => w.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) at(t, two(null, null));
  assert.deepEqual(at(14_000, two([99_900, 25_000_000], null)).map(s => [s.kind, s.price]), [['appeared', 99_910]]);
  for (let t = 16_000; t <= 22_000; t += 2_000) at(t, two([99_900, 25_000_000], [99_940, 40_000_000]));
  assert.deepEqual(at(24_000, two(null, [99_940, 40_000_000])).map(s => [s.kind, s.price]), [['pulled', 99_910]], 'the wall beside it was already there: it is not where this one went');
  const v = new WallWatch(), look = (t: number, f: LevelsFrame) => v.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) look(t, two(null, null));
  look(14_000, two([99_900, 25_000_000], null));
  for (let t = 16_000; t <= 22_000; t += 2_000) look(t, two([99_900, 25_000_000], null));
  assert.deepEqual(look(24_000, two([99_920, 25_000_000], [99_500, 40_000_000])), [], 'it moved a bin while a bigger wall came far away');
  assert.deepEqual(look(26_000, two(null, [99_500, 40_000_000])).map(s => [s.kind, s.price]), [['pulled', 99_930]], 'and its pull, from where it moved to, is heard');
  // Taken down in steps: once under the threshold it keeps the size it stood at, so the steps add up to a pull.
  const s = new WallWatch(), step = (t: number, usd: number) => s.update(t, bookBins(two([99_900, usd], null), ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) step(t, 1_000_000);
  step(14_000, 30_000_000); step(16_000, 30_000_000); step(18_000, 30_000_000); step(20_000, 30_000_000);
  assert.deepEqual([9_000_000, 4_000_000].map((usd, k) => step(22_000 + k * 2_000, usd).map(x => [x.kind, x.usd])), [[], [['pulled', 30_000_000]]]);
  // Shrunk under the threshold and then moved a bin, unchanged: the same wall (what it held at the last look moved), not a pull.
  const m = new WallWatch(), go = (t: number, f: LevelsFrame) => m.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) go(t, two(null, null));
  go(14_000, two([99_900, 25_000_000], null)); go(16_000, two([99_900, 25_000_000], null)); go(18_000, two([99_900, 25_000_000], null)); go(20_000, two([99_900, 25_000_000], null));
  assert.deepEqual(go(22_000, two([99_900, 9_000_000], null)), []);
  assert.deepEqual(go(24_000, two([99_920, 9_000_000], null)), [], 'it moved');
  assert.deepEqual(go(26_000, two([99_920, 1_000_000], null)).map(x => [x.kind, x.usd]), [['pulled', 25_000_000]], 'and when it goes, it is judged against the size it stood at');
  // Moved under the threshold, then taken down in steps: the move keeps the size it stood at, so the steps still add up to a pull.
  const k = new WallWatch(), see = (t: number, f: LevelsFrame) => k.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) see(t, two(null, null));
  for (let t = 14_000; t <= 20_000; t += 2_000) see(t, two([99_900, 12_000_000], null));
  assert.deepEqual([see(22_000, two([99_920, 8_000_000], null)), see(24_000, two([99_920, 4_000_000], null))], [[], []]);
  assert.deepEqual(see(26_000, two([99_920, 3_000_000], null)).map(x => [x.kind, x.usd]), [['pulled', 12_000_000]]);
  // A remnant that moves is not the wall: it went then, after four seconds, so it was never a pull (and is not called one later).
  const r = new WallWatch(), saw = (t: number, f: LevelsFrame) => r.update(t, bookBins(f, ids, MARK, 0.01), MARK, 10_000_000);
  for (let t = 0; t <= 12_000; t += 2_000) saw(t, two(null, null));
  saw(14_000, two([99_900, 12_000_000], null)); saw(16_000, two([99_900, 4_000_000], null));
  assert.deepEqual([18_000, 20_000, 22_000].flatMap(t => saw(t, two([99_920, 2_400_000], null))), []);
});

test('the balance only watches while the book is arriving: a lopsided book found then is not news', () => {
  const w = new ImbalanceWatch();
  assert.deepEqual([0.9, 0.9].map(v => w.update(v, 70, false)), [null, null]);
  assert.deepEqual([0.9, 0.3, 0.8].map(v => w.update(v, 70)), [null, null, 'buy'], 'it has to come back inside the line before it can sound');
  // It starts over with the walls (the orchestrator resets it when they start over): what it saw of other books says nothing now.
  const b = new ImbalanceWatch();
  b.update(0.9, 70, false); b.reset();
  assert.deepEqual([0.5, 0.5].map(v => b.update(v, 70, false)).concat(b.update(0.8, 70)), [null, null, 'buy']);
  const walls = new WallWatch(), first = walls.starts;
  walls.update(0, bookBins(wall(1_000_000), new Set(['a:BTC']), MARK, 0.01), MARK, 10_000_000, 'a|BTC');
  walls.update(2_000, bookBins(wall(1_000_000), new Set(['a:BTC']), MARK, 0.01), MARK, 10_000_000, 'a|ETH');
  assert.ok(walls.starts > first + 1, 'another market: the walls started over (and with them the balance)');
});

test("a grouped venue's top groups count in the totals by their whole span's share inside the range, wherever the split is", () => {
  // A venue priced 1 % off the mark: its top groups straddle the range's edge; moving only the split must not move the totals.
  const band = (rows: [number, number, number][]) => ({ lo: Float64Array.from(rows.map(r => r[0])), hi: Float64Array.from(rows.map(r => r[1])), usd: Float64Array.from(rows.map(r => r[2])) });
  const at = (cut: number) => bookBins({ asOf: 0, books: [{ id: 'hl:BTC', venue: 'hl', timestamp: 0, coarse: true, touch: { lo: 98_900, hi: 99_000 }, bids: band([[98_900, cut, 20_000_000]]), asks: band([[cut, 99_000, 3_000_000]]) }] }, new Set(['hl:BTC']), 99_920, 0.01);
  const a = at(98_912.5), b = at(98_987.5);
  assert.deepEqual([a.bidTotal, a.askTotal], [b.bidTotal, b.askTotal]);
  assert.ok(Math.abs(a.bidTotal - 20_000_000 * 0.792) < 1 && Math.abs(a.askTotal - 3_000_000 * 0.792) < 1, '79.2 of the span lies inside the range');
});

test('the balance tips once and must come back before it tips again', () => {
  const w = new ImbalanceWatch();
  // 0.72 again after only 0.5 does not sound (0.5 is not back inside 60 % of the line); after 0.3 it does.
  assert.deepEqual([0.2, 0.5, 0.71, 0.8, 0.5, 0.72, 0.3, 0.72, -0.9, -0.2, -0.8].map(v => w.update(v, 70)), [null, null, 'buy', null, null, null, null, 'buy', null, null, 'sell']);
  // swinging straight from one side to the other is one tip, not two: -0.9 comes right after a tip and does not sound until the balance has come back
});

// ---- Settings and notes -----------------------------------------------------------------------------------------------------------

test('panel sounds are off by default, read field by field, and clamped', () => {
  assert.deepEqual(readPanelSounds(undefined), DEFAULT_PANEL_SOUNDS);
  assert.equal(Object.values(DEFAULT_PANEL_SOUNDS).every(p => Object.values(p).filter(v => typeof v === 'boolean').every(v => v === false)), true, 'every switch is off');
  const p = readPanelSounds({ flow: { burst: true, usd: 5, sensitivity: 99 }, depth: { pct: 12, imbalance: 'yes' }, book: { usd: 1e15 }, extra: 1 });
  assert.deepEqual([p.flow.burst, p.flow.usd, p.flow.sensitivity, p.depth.pct, p.depth.imbalance, p.book.usd], [true, 100_000, 10, 30, false, 5_000_000_000]);
  assert.deepEqual(DEFAULT_PANEL_SOUNDS.depthPane, { extreme: false, range: 0.2, pct: 99, hours: 6 }, 'the extreme depth sound: the 99th percentile of six hours, within 20 %');
  const d = readPanelSounds({ depthPane: { extreme: true, range: 0.3, pct: 100, hours: 99 } }).depthPane;
  assert.deepEqual(d, { extreme: true, range: 0.2, pct: 99.9, hours: 12 }, 'a range the pane does not offer, a percentile of 100 and too many hours are repaired');
  assert.deepEqual(readPanelSounds({ depthPane: { range: 0.05, pct: 95.04, hours: 1 } }).depthPane, { extreme: false, range: 0.05, pct: 95, hours: 2 });
  assert.deepEqual(readSounds({ on: true }).panels, DEFAULT_PANEL_SOUNDS);
});

test('every alert has notes that rise for buying and fall for selling, and none is silent', () => {
  const kinds: AlertKind[] = ['flow-burst', 'bar-delta', 'wall-appeared', 'wall-pulled', 'imbalance', 'depth-extreme', 'oi-jump'];
  const mean = (n: Note[]) => n[0]!.freq - n[n.length - 1]!.freq;
  for (const kind of kinds) {
    const buy = alertNotes(kind, 'buy', 1), sell = alertNotes(kind, 'sell', 1);
    assert.ok(buy.length >= 2 && buy.every(n => n.gain > 0 && n.freq > 0 && n.decay > 0), kind);
    if (kind === 'flow-burst' || kind === 'bar-delta' || kind === 'imbalance' || kind === 'depth-extreme') assert.ok(mean(buy) < 0 && mean(sell) > 0, `${kind} buying rises, selling falls`);
    assert.ok(alertNotes(kind, 'buy', 0).every(n => n.gain === 0), `${kind} is silent at volume 0`);
  }
});

// ---- The orchestrator -------------------------------------------------------------------------------------------------------------

class FakePlayer implements Player { played: Note[][] = []; running = true; play(notes: readonly Note[]): boolean { if (!this.running) return false; this.played.push([...notes]); return true; } async unlock(): Promise<void> { this.running = true; } }
const T = Date.UTC(2026, 9, 6, 12, 0, 0);

function rig(over: Partial<ReturnType<typeof readPanelSounds>> = {}, on = true) {
  const state: AppState = initialState();
  state.sounds = readSounds({ on, volume: 1, panels: { ...DEFAULT_PANEL_SOUNDS, ...over } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }, { instrumentId: 'aspot:BTC', venue: 'aspot', marketType: 'spot' }];
  state.show = { ...state.show, cvd: true }; state.cvd = { ...state.cvd, bursts: true };
  const flow = new FlowBook(), player = new FakePlayer(), alerts = new Alerts({ state }, flow, player, () => T);
  return { state, flow, player, alerts };
}
const feed = (flow: FlowBook, id: string, now: number, seconds: number, buy: number, sell: number) => {
  const items: [string, number, number, number][] = []; for (let i = seconds - 1; i >= 0; i--) items.push([id, now - i * 1000, buy, sell]); flow.apply(items);
};

test('a flow burst is marked on the column, sounds once when the rule is on, and then waits out its cool-down', () => {
  const { flow, player, alerts, state } = rig({ flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } as never);
  state.sounds = readSounds({ on: true, volume: 1, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) flow.apply([['a:BTC', T - i * 1000, 500_000, 20_000]]);
  alerts.tick(T);
  assert.equal(alerts.bursts.length, 1); assert.equal(alerts.bursts[0]!.family, 'a'); assert.equal(alerts.bursts[0]!.kind, 'perp');
  assert.equal(player.played.length, 1); assert.equal(alerts.log[0]!.kind, 'flow-burst'); assert.equal(alerts.log[0]!.side, 'buy'); assert.equal(alerts.log[0]!.panel, 'flow');
  alerts.tick(T + 5_000);
  assert.equal(player.played.length, 1, 'the same lane does not sound again within 90 s');
});

test('with the rule off the burst is still marked but silent; with sounds off nothing plays', () => {
  const quiet = rig();
  feed(quiet.flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) quiet.flow.apply([['a:BTC', T - i * 1000, 3_000_000, 20_000]]);
  quiet.alerts.tick(T);
  assert.equal(quiet.alerts.bursts.length, 1); assert.equal(quiet.player.played.length, 0);
  const off = rig({}, false); off.state.sounds = readSounds({ on: false, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(off.flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) off.flow.apply([['a:BTC', T - i * 1000, 3_000_000, 20_000]]);
  off.alerts.tick(T);
  assert.equal(off.player.played.length, 0); assert.equal(off.alerts.log.length, 0);
});

test('with the marks off (the default) and the rule off, no burst is looked for at all', () => {
  const quiet = rig(); quiet.state.cvd = { ...quiet.state.cvd, bursts: false };
  feed(quiet.flow, 'a:BTC', T, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) quiet.flow.apply([['a:BTC', T - i * 1000, 3_000_000, 20_000]]);
  quiet.alerts.tick(T);
  assert.equal(quiet.alerts.bursts.length, 0);
});

test('a series that went quiet two seconds ago is history, not news', () => {
  const { flow, alerts, player, state } = rig();
  state.sounds = readSounds({ on: true, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  feed(flow, 'a:BTC', T - 30_000, 2_000, 30_000, 30_000);
  for (let i = 9; i >= 0; i--) flow.apply([['a:BTC', T - 30_000 - i * 1000, 3_000_000, 0]]);
  alerts.tick(T); assert.equal(player.played.length, 0); assert.equal(alerts.bursts.length, 0);
});

test('a candle that closes with a big net delta sounds; the first candle seen, and a small delta, do not', () => {
  const { flow, alerts, player, state } = rig();
  state.sounds = readSounds({ on: true, panels: { bars: { delta: true, usd: 3_000_000 } } });
  state.timeframe = '1m';
  const t0 = Math.floor(T / 60_000) * 60_000;
  feed(flow, 'a:BTC', t0 + 59_000, 60, 100_000, 10_000);                  // 90k/s net for the minute: 5.4M
  state.candles = [[t0 - 60_000, 1, 1, 1, 1, 1], [t0, 1, 1, 1, 1, 1]];
  alerts.tick(T); assert.equal(player.played.length, 0, 'the first candle is history');
  state.candles = [[t0 - 60_000, 1, 1, 1, 1, 1], [t0, 1, 1, 1, 1, 1], [t0 + 60_000, 1, 1, 1, 1, 1]];
  alerts.tick(T + 1_000);
  assert.equal(player.played.length, 1); assert.equal(alerts.log[0]!.kind, 'bar-delta'); assert.equal(alerts.log[0]!.side, 'buy');
  state.candles = [...state.candles, [t0 + 120_000, 1, 1, 1, 1, 1]];
  alerts.tick(T + 2_000);
  assert.equal(player.played.length, 1, 'the next candle had no flow');
});

test('walls and the balance sound from the live book, every two seconds, and the first ten seconds are quiet', () => {
  const { state, alerts, player } = rig();
  state.sounds = readSounds({ on: true, panels: { book: { wall: true, usd: 10_000_000 }, depth: { imbalance: true, pct: 60 } } });
  state.mark = { price: MARK, asOf: T };
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }];
  state.levels = frame([[99_900, 1_000_000]], [[100_100, 1_000_000]], 'a:BTC', T);
  for (let t = 0; t <= 12_000; t += 2_000) { state.levels = { ...state.levels!, asOf: T + t }; alerts.tick(T + t); }
  assert.equal(player.played.length, 0);
  state.levels = { ...frame([[99_900, 30_000_000]], [[100_100, 1_000_000]], 'a:BTC', T + 14_000) };
  alerts.tick(T + 14_000);
  const kinds = alerts.log.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['imbalance', 'wall-appeared'], 'a bid wall of 30M tips the balance and appears at once');
  assert.ok(alerts.log.every(e => e.side === 'buy'));
});

test('no more than four sounds in ten seconds, whatever the kinds', () => {
  const { state, alerts, player, flow } = rig();
  state.sounds = readSounds({ on: true, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  for (const id of ['a:BTC', 'b:BTC', 'c:BTC', 'd:BTC', 'e:BTC', 'f:BTC']) {
    feed(flow, id, T, 2_000, 30_000, 30_000);
    for (let i = 9; i >= 0; i--) flow.apply([[id, T - i * 1000, 500_000, 20_000]]);
  }
  alerts.tick(T);
  assert.equal(alerts.bursts.length, 6, 'all six are marked on the column');
  assert.equal(player.played.length, 4, 'but only four make a sound');
});

test('Test plays a sample whatever the switches say', async () => {
  const { alerts, player } = rig({}, false);
  alerts.test('wall-appeared', 'sell');
  await new Promise(r => setImmediate(r));
  assert.equal(player.played.length, 1);
});

// ---- Notify: alerts sent beside the sounds ------------------------------------------------------------------------------------------

/** A Notify stand-in: which panels it wants, whether this tab sends them, every alert it was handed, and whether a channel sent it. */
function out(wanted: readonly string[], o: { sends?: boolean; delivered?: boolean } = {}) {
  const sent: { panel: string; text: string; key: string }[] = [];
  return {
    sent, wants: (panel: string) => wanted.includes(panel), sends: (panel: string) => wanted.includes(panel) && o.sends !== false,
    deliver: (panel: string, text: string, key: string) => { sent.push({ panel, text, key }); return { channels: 1, done: Promise.resolve(o.delivered !== false) }; },
  };
}
const burstsOn = (flow: FlowBook, ids: readonly string[]): void => {
  for (const id of ids) { feed(flow, id, T, 2_000, 30_000, 30_000); for (let i = 9; i >= 0; i--) flow.apply([[id, T - i * 1000, 500_000, 20_000]]); }
};

test('with Notify off every alert is a sound as before; with sounds off and Notify wanting it, it is sent, listed, and said as no sound due', () => {
  const plain = rig({ flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } as never);
  const none = out([]); plain.alerts.out = none;
  burstsOn(plain.flow, ['a:BTC']); plain.alerts.tick(T);
  assert.equal(plain.player.played.length, 1); assert.deepEqual(none.sent, []); assert.equal(plain.alerts.log[0]!.sent, 0);
  const quiet = rig({ flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } as never, false);
  const sends = out(['flow']); quiet.alerts.out = sends;
  burstsOn(quiet.flow, ['a:BTC']); quiet.alerts.tick(T);
  assert.equal(quiet.player.played.length, 0, 'Sounds is off: nothing plays');
  assert.equal(sends.sent.length, 1, 'but Notify sends it');
  assert.deepEqual([quiet.alerts.log[0]!.audible, quiet.alerts.log[0]!.sent], [true, 1], 'never said as "not heard": no sound was due');
});

test('the sounds\' cap is the ear\'s: a fifth alert in ten seconds is still sent, and open interest\'s never is', () => {
  const { state, alerts, player, flow } = rig();
  state.sounds = readSounds({ on: true, panels: { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } });
  const sends = out(['flow', 'oi']); alerts.out = sends;
  burstsOn(flow, ['a:BTC', 'b:BTC', 'c:BTC', 'd:BTC', 'e:BTC', 'f:BTC']);
  alerts.tick(T);
  assert.equal(player.played.length, 4, 'four sounds');
  assert.equal(sends.sent.length, 6, 'six messages');
  alerts.drawing(T, 'Price reached your level at 100', 'level:x');
  assert.equal(sends.sent.length, 6, 'a bell is the drawing panel\'s, which this stand-in does not want');
});

test('the depth sound reads the recording only while it can be heard or Notify would send it', () => {
  let asked = 0;
  const state: AppState = initialState();
  state.sounds = readSounds({ on: false, panels: { ...DEFAULT_PANEL_SOUNDS, depthPane: { ...DEFAULT_PANEL_SOUNDS.depthPane, extreme: true } } });
  state.markets = [{ instrumentId: 'a:BTC', venue: 'a', marketType: 'perpetual' }]; state.marketId = 'a:BTC';
  const alerts = new Alerts({ state }, new FlowBook(), new FakePlayer(), () => T, undefined, () => { asked++; return new Promise(() => {}); });
  alerts.tick(T);
  assert.equal(asked, 0, 'Sounds off and no Notify: nothing is read (as before Notify)');
  alerts.out = out(['depthPane']);
  alerts.tick(T + 1_000);
  assert.equal(asked, 1, 'Notify sends it: the recording is read');
});

test('a bell reached the person only when it was heard here or sent by this tab: else a bell that goes off once stays on', async () => {
  const quiet = rig({}, false);
  assert.equal(await quiet.alerts.drawing(T, 'Price reached your level at 100', 'level:a'), false, 'Sounds off and no Notify: nobody was told');
  const locked = rig({}, true); locked.player.running = false;
  assert.equal(await locked.alerts.drawing(T, 'Price reached your level at 100', 'level:b'), false, 'a locked sound was not heard');
  const heard = rig({}, true);
  assert.equal(await heard.alerts.drawing(T, 'Price reached your level at 100', 'level:c'), true, 'heard here');
  assert.equal(await heard.alerts.drawing(T + 1_000, 'Price reached your level at 100', 'level:c'), false, 'inside its cool-down nothing happened');
  const sent = rig({}, false); sent.alerts.out = out(['drawing']);
  assert.equal(await sent.alerts.drawing(T, 'Price reached your level at 100', 'level:d'), true, 'sent by this tab and delivered');
  const failed = rig({}, false); failed.alerts.out = out(['drawing'], { delivered: false });
  assert.equal(await failed.alerts.drawing(T, 'Price reached your level at 100', 'level:e'), false, 'every channel failed');
  const other = rig({}, true); other.alerts.out = out(['drawing'], { sends: false });
  assert.equal(await other.alerts.drawing(T, 'Price reached your level at 100', 'level:f'), false, 'heard in a tab that does not send: the tab that sends decides, so the phone is not skipped');
  assert.equal(other.player.played.length, 1, 'it still sounded there');
});

test('a bell that told nobody gives back its cool-down: the next crossing within the minute is heard', async () => {
  const r = rig({}, false);
  assert.equal(await r.alerts.drawing(T, 'Price reached your level at 100', 'level:z'), false, 'Sounds off: nobody heard it');
  r.state.sounds = readSounds({ ...r.state.sounds, on: true });
  assert.equal(await r.alerts.drawing(T + 10_000, 'Price reached your level at 100', 'level:z'), true, 'ten seconds later, with Sounds on: heard');
});

test('a cool-down given back is only the firing\'s own: a newer firing keeps its cool-down', () => {
  const c = new Cooldowns();
  assert.equal(c.take('k', 0, 60_000), true);
  assert.equal(c.take('k', 70_000, 60_000), true, 'a second firing after the first one\'s minute');
  c.release('k', 0);
  assert.equal(c.take('k', 75_000, 60_000), false, 'the first firing\'s late failure leaves the second one\'s cool-down');
  c.release('k', 70_000);
  assert.equal(c.take('k', 76_000, 60_000), true, 'its own release frees it');
});

test('a message gives its size in the page\'s units, as the Recent list does; where the coins were not known, the dollars it fired with', () => {
  const burst = { flow: { burst: true, usd: 1_000_000, sensitivity: 4 } } as never;
  const fired = (price: number) => {
    const r = rig(burst, false), sends = out(['flow']); r.alerts.out = sends;
    burstsOn(r.flow, ['a:BTC']);
    // The coin price of each second (the coin twin's rule): a price, or none for a second that moved without one.
    r.flow.get('a:BTC')!.coinPriceAt = (() => price) as never;
    r.alerts.tick(T);
    return { message: sends.sent[0]!.text, entry: r.alerts.log[0]!, list: r.alerts.text(r.alerts.log[0]!) };
  };
  try {
    setUnits('coin');
    const known = fired(100_000);
    assert.match(known.message, /BTC/, `in coins: ${known.message}`);
    assert.equal(known.message, known.list, 'the words the Recent list shows');
    const unknown = fired(Number.NaN);
    assert.match(unknown.list, /–/, 'the Recent list says it kept no coins');
    assert.equal(unknown.message, unknown.entry.text, `a message cannot be written again: the dollars, not a dash (${unknown.message})`);
    assert.match(unknown.message, /\$/);
    setUnits('usd');
    const dollars = fired(100_000);
    assert.equal(dollars.message, dollars.entry.text, 'in dollars: the sentence as it fired');
  } finally {
    setUnits('usd');
  }
});
