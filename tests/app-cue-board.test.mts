import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIGHT_SHARE, CONTACT_LIFE_MS, CREST_MS, CUE_LIFE_MS, CellMap, CueBoard, evictFairly, shedEvents, MARK_LIFE_MS, MAX_CUE_AREA, MIN_CUE_AREA, MIN_CUE_STRENGTH, markKey, maxAreaFor, bodyLight, crestAt, crestLight, markLight, pushStrongest, shareAt, type Cue, type CueRow, type Geometry } from '../src/app/panes/ladder-cues.ts';
import { cueShows, heatTone, paintCue } from '../src/app/panes/ladder-cue-paint.ts';
import { PALETTES, contrastRatio } from '../src/app/theme.ts';
import { nearDirection } from '../src/app/cvd/colors.ts';
import { PULSE_ATTACK_MS, pulseEnvelope } from '../src/app/candle/model.ts';

let seq = 0;
const row = (id: string, side: 'bid' | 'ask', rowIx: number, usd: number, strength: number, extra: Partial<CueRow> = {}): CueRow =>
  ({ id, side, row: rowIx, usd, strength, wall: 1_000, seq: ++seq, removed: false, added: false, pair: false, band: false, ...extra });
/** Every cell 100 x 10 px and every row on screen, unless said. */
const flat = (visible: (row: number) => boolean = () => true, cell: (id: string, side: 'bid' | 'ask', row: number) => boolean = () => true): Geometry =>
  ({ rowVisible: visible, cell: (id, side, r) => cell(id, side, r) ? { x: 0, y: 0, w: 100, h: 10, usd: 5e6 } : null });

test('the crest runs out through the cell for an addition and back in for a decrease, over the same time', () => {
  assert.equal(crestAt(1, 0), 0); assert.equal(crestAt(1, CREST_MS), 1); assert.equal(crestAt(1, 5 * CREST_MS), 1);
  assert.equal(crestAt(-1, 0), 1); assert.equal(crestAt(-1, CREST_MS), 0); assert.equal(crestAt(-1, -50), 1);
  for (const age of [0, 50, 190, 380]) assert.ok(Math.abs(crestAt(1, age) + crestAt(-1, age) - 1) < 1e-12, 'mirror images');
});

test('the light is as strong as the change, the same for both signs, and gone with the cue', () => {
  for (const age of [0, 40, 80, 200, 600, 1_400]) assert.equal(bodyLight(0.5, age), 0.5 * pulseEnvelope(age));
  assert.equal(bodyLight(0.8, 0), 0); assert.ok(bodyLight(0.8, 80) > 0.79);
  assert.equal(crestLight(0.7, -1), 0); assert.equal(crestLight(0.7, CUE_LIFE_MS + 1), 0); assert.ok(crestLight(0.7, 0) === 0.7 && crestLight(0.7, 520) < 0.26);
  assert.ok(bodyLight(0.4, 300) < bodyLight(0.9, 300), 'a larger change is brighter at the same moment');
  assert.equal(markLight(-1), 0); assert.equal(markLight(0), 1); assert.equal(markLight(MARK_LIFE_MS + 1), 0); assert.ok(markLight(MARK_LIFE_MS / 2) > 0 && markLight(MARK_LIFE_MS * 0.9) < markLight(MARK_LIFE_MS * 0.2));
});

test('the cell map answers for the cells of the last draw, by venue, side and row, and forgets them at the next', () => {
  const map = new CellMap();
  map.begin(100, 4); // rows 100, 99, 98, 97
  map.set('a:BTC', 0, 1, 10, 20, 50, 13, 7e6); map.set('a:BTC', 2, 0, 12, 60, 40, 13, 3e6); map.set('b:BTC', 1, 1, 5, 40, 90, 13, 9e6);
  assert.deepEqual(map.cell('a:BTC', 'ask', 100), { x: 10, y: 20, w: 50, h: 13, usd: 7e6 });
  assert.equal(map.cell('a:BTC', 'bid', 100), null, 'the row shows the other side');
  assert.deepEqual(map.cell('a:BTC', 'bid', 98), { x: 12, y: 60, w: 40, h: 13, usd: 3e6 });
  assert.equal(map.cell('b:BTC', 'ask', 99)!.w, 90); assert.equal(map.cell('b:BTC', 'ask', 100), null, 'the venue has no cell on that row');
  assert.equal(map.cell('zz:BTC', 'ask', 100), null);
  assert.equal(map.cell('a:BTC', 'ask', 101), null, 'above the first row'); assert.equal(map.cell('a:BTC', 'ask', 96), null, 'below the last');
  assert.ok(map.rowVisible(100) && map.rowVisible(97) && !map.rowVisible(101) && !map.rowVisible(96));
  assert.equal(map.rowOf(0), 100); assert.equal(map.rowOf(3), 97);
  map.set('a:BTC', 9, 0, 1, 1, 1, 1, 1); assert.equal(map.cell('a:BTC', 'bid', 91), null, 'a row past the draw is ignored');
  map.begin(110, 6);
  assert.equal(map.cell('a:BTC', 'ask', 100), null, 'a new draw starts empty'); assert.equal(map.rowVisible(110) && map.rowVisible(105), true);
  map.set('a:BTC', 5, 1, 1, 2, 3, 4, 5); assert.deepEqual(map.cell('a:BTC', 'ask', 105), { x: 1, y: 2, w: 3, h: 4, usd: 5 }, 'longer than before: the arrays grew');
  map.forget(new Set(['b:BTC'])); assert.equal(map.cell('a:BTC', 'ask', 105), null);
});

test('a change on a row that is on screen lights its cell and leaves its mark', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 2e6, 0.6)]);
  assert.equal(board.waiting, 1);
  board.admit(1_000, 'wash', flat());
  assert.equal(board.waiting, 0); assert.equal(board.active.length, 1);
  const cue = board.active[0]!;
  assert.deepEqual([cue.id, cue.side, cue.row, cue.sign, cue.strength, cue.t0], ['a:BTC', 'ask', 5, 1, 0.6, 1_000]);
  assert.ok(cue.cost > 0 && cue.cost <= 100 * 10);
  const mark = board.marks.get(markKey(5))!;
  assert.deepEqual([mark.sign, mark.lit, mark.t0], [1, true, 1_000]);
  board.push([row('a:BTC', 'bid', 3, -4e6, 0.9, { removed: true })]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active[1]!.sign, -1); assert.equal(board.active[1]!.removed, false, 'the cell is still drawn: the row holds something, so it is not emptied');
  const gone = new CueBoard();
  gone.push([row('a:BTC', 'bid', 3, -4e6, 0.9, { removed: true })]); gone.admit(1_000, 'wash', flat(() => true, () => false));
  assert.equal(gone.marks.get(markKey(3))!.removed, true, 'no cell is drawn for the row any more: it is emptied');
});

test('a row off screen, a venue with no cell there and a change too small to see light nothing; only a visible row keeps a mark', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 2e6, 0.6), row('b:BTC', 'ask', 6, 2e6, 0.6), row('c:BTC', 'ask', 7, 2e6, MIN_CUE_STRENGTH / 2)]);
  board.admit(1_000, 'wash', flat(r => r !== 5, (id) => id !== 'b:BTC'));
  assert.equal(board.active.length, 0);
  assert.equal(board.marks.has(markKey(5)), false, 'off screen: nothing');
  assert.equal(board.marks.get(markKey(6))!.lit, false, 'on screen with no cell for that venue: a mark, no light');
  assert.equal(board.marks.get(markKey(7))!.lit, false, 'too small');
  board.push([row('a:BTC', 'ask', 8, 0, 0.9), row('a:BTC', 'ask', 9, NaN, 0.9)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 0, 'no change, no light');
});

test('light is spent from a budget: the cell count and the area are capped and nothing bypasses them', () => {
  const caps = { maxCues: 3, maxArea: 1e9 }, board = new CueBoard(caps);
  board.push([1, 2, 3, 4, 5].map(i => row(`v${i}:BTC`, 'ask', i, 1e6, 0.5)));
  board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 3); assert.equal(board.stats.turnedDown, 2);
  board.push([row('big:BTC', 'ask', 20, 5e9, 1)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active.length, 3, 'a huge change does not bypass the cap'); assert.ok(board.marks.has(markKey(20)), 'but it leaves its mark');
  const area = new CueBoard({ maxCues: 100, maxArea: 2_500 });
  area.push([1, 2, 3, 4, 5, 6].map(i => row(`v${i}:BTC`, 'bid', i, -1e6, 1)));
  area.admit(1_000, 'wash', flat());
  assert.equal(area.active.length, 2, 'a 100 x 10 cell at full strength costs 1,000 px2: two fit under 2,500');
  assert.ok(area.used <= 2_500);
});

test('the largest changes are lit first, and every venue gets its largest before any venue its second', () => {
  const board = new CueBoard({ maxCues: 3, maxArea: 1e9 });
  board.push([row('busy:BTC', 'ask', 1, 1e6, 0.9), row('busy:BTC', 'ask', 2, 1e6, 0.85), row('busy:BTC', 'ask', 3, 1e6, 0.8), row('busy:BTC', 'ask', 4, 1e6, 0.75), row('quiet:BTC', 'ask', 5, 1e6, 0.1), row('mid:BTC', 'ask', 6, 1e6, 0.3)]);
  board.admit(1_000, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id).sort(), ['busy:BTC', 'mid:BTC', 'quiet:BTC'], 'one busy venue cannot take every place');
  assert.equal(board.active.find(c => c.id === 'busy:BTC')!.row, 1, 'its largest');
  const again = new CueBoard({ maxCues: 2, maxArea: 1e9 });
  again.push([row('a:BTC', 'bid', 1, -1, 0.2), row('b:BTC', 'bid', 2, -1, 0.9), row('c:BTC', 'bid', 3, -1, 0.5)]);
  again.admit(1_000, 'wash', flat());
  assert.deepEqual(again.active.map(c => c.id), ['b:BTC', 'c:BTC'], 'then the larger of the venues');
});

test('another change at a lit cell renews it when it has the same sign and replaces it when it has the other, without paying twice', () => {
  const board = new CueBoard({ maxCues: 10, maxArea: 1_500 });
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  const cost = board.used;
  board.push([row('a:BTC', 'ask', 5, 3e6, 0.8)]); board.admit(1_200, 'wash', flat());
  assert.equal(board.active.length, 1); assert.equal(board.active[0]!.strength, 0.8); assert.equal(board.active[0]!.usd, 4e6); assert.equal(board.active[0]!.t0, 1_200); assert.equal(board.stats.renewed, 1);
  assert.ok(board.used > cost && board.used <= 1_000 * 0.85 + 1e-6, 'the one cell is charged once, at its new strength');
  board.push([row('a:BTC', 'ask', 5, -2e6, 0.3)]); board.admit(1_300, 'wash', flat());
  assert.equal(board.active.length, 1); assert.equal(board.active[0]!.sign, -1); assert.equal(board.active[0]!.strength, 0.3); assert.equal(board.stats.reversed, 1);
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.4), row('a:BTC', 'ask', 5, 1e6, 0.6)]); board.admit(1_400, 'wash', flat());
  assert.equal(board.active.length, 1, 'two in one batch are one cell');
});

test('a cue is over after its life, a mark after its own, and what is over frees its budget', () => {
  const board = new CueBoard({ maxCues: 1, maxArea: 1e9 });
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.prune(1_000 + CUE_LIFE_MS), true); assert.equal(board.prune(1_000 + CUE_LIFE_MS + 1), false);
  assert.equal(board.active.length, 0); assert.equal(board.marks.size, 1);
  board.prune(1_000 + MARK_LIFE_MS + 1); assert.equal(board.marks.size, 0);
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  board.push([row('b:BTC', 'ask', 6, 1e6, 0.5)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active.length, 1, 'full'); board.push([row('b:BTC', 'ask', 6, 1e6, 0.5)]); board.admit(1_000 + CUE_LIFE_MS + 10, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id), ['b:BTC'], 'the first cue ended and made room');
});

test('a cue shows a share of its peak: its body or its crest, whichever is brighter, held at full through the attack; a contact\'s ripple runs out sooner', () => {
  const change = { kind: 'depth' as const, life: CUE_LIFE_MS }, contact = { kind: 'contact' as const, life: CONTACT_LIFE_MS };
  assert.equal(shareAt(change, 0), 1); assert.equal(shareAt(change, PULSE_ATTACK_MS - 1), 1, 'still rising: the budget does not assume less');
  for (const age of [PULSE_ATTACK_MS, 200, 600, 1_000]) assert.ok(shareAt(change, age) >= pulseEnvelope(age) - 1e-12 && shareAt(change, age) >= crestLight(1, age) - 1e-12, `age ${age}`);
  assert.equal(shareAt(change, -1), 0); assert.equal(shareAt(change, CUE_LIFE_MS + 1), 0);
  assert.ok(shareAt(change, 500) > BRIGHT_SHARE && shareAt(change, 600) < BRIGHT_SHARE, 'a change is a tail after about half a second');
  assert.equal(shareAt(contact, 0), 1); assert.ok(shareAt(contact, 300) < 0.5 && shareAt(contact, CONTACT_LIFE_MS) === 0 && shareAt(contact, CONTACT_LIFE_MS + 1) === 0);
});

test('the budget counts the light that shows: a cue running out holds no place and little area, and the caps still hold against those that show', () => {
  const board = new CueBoard({ maxCues: 1, maxArea: 1_100 });
  board.push([row('a:BTC', 'ask', 1, 1e6, 1)]); board.admit(1_000, 'wash', flat());
  board.push([row('b:BTC', 'ask', 2, 1e6, 1)]); board.admit(1_100, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id), ['a:BTC'], 'a shows light: the one place is taken'); assert.equal(board.stats.turnedDown, 1);
  board.push([row('b:BTC', 'ask', 2, 1e6, 1)]); board.admit(1_700, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id), ['a:BTC', 'b:BTC'], 'at 700 ms a is a tail, under a tenth of its peak: no place, 5 % of its area');
  assert.equal(board.brightCount(1_700), 1); assert.ok(board.litArea(1_700) > 1_000 && board.litArea(1_700) < 1_100); assert.equal(board.used, 2_000, 'at their peaks the two cost both');
});

test('a cue that paints nothing any more is left alone: its cell is neither restored nor repainted', () => {
  const change = { kind: 'depth' as const, life: CUE_LIFE_MS, strength: 0.6 } as Cue, contact = { kind: 'contact' as const, life: CONTACT_LIFE_MS, strength: 0.6 } as Cue;
  assert.equal(cueShows('wash', change, 0), true, 'at its first instant the body is still dark but the crest is already there'); assert.equal(cueShows('wash', change, 100), true);
  assert.equal(cueShows('wash', change, 900), true, 'the crest is the last thing to go'); assert.equal(cueShows('wash', change, CUE_LIFE_MS + 1), false);
  assert.equal(cueShows('marks', change, 100), false);
  assert.equal(cueShows('wash', contact, 10), true); assert.equal(cueShows('wash', contact, CONTACT_LIFE_MS - 1), false, 'a ripple is under a hundredth of itself before it ends');
  assert.equal(cueShows('marks', contact, 10), false, 'Signs and reduced motion light nothing: a ripple that was running when the look changed goes with it');
});

/** A canvas context that records where light is laid: the clip in force and every fill. */
function recorder(): { m: CanvasRenderingContext2D; fills: { x: number; y: number; w: number; h: number; clip: number[] | null }[] } {
  const fills: { x: number; y: number; w: number; h: number; clip: number[] | null }[] = [], stack: (number[] | null)[] = [];
  let clip: number[] | null = null, path: number[] | null = null;
  const m = { globalAlpha: 1, fillStyle: '', save: () => { stack.push(clip); }, restore: () => { clip = stack.pop() ?? null; }, beginPath: () => { path = null; }, rect: (x: number, y: number, w: number, h: number) => { path = [x, y, w, h]; },
    clip: () => { clip = path; }, fillRect: (x: number, y: number, w: number, h: number) => { fills.push({ x, y, w, h, clip }); } } as unknown as CanvasRenderingContext2D;
  return { m, fills };
}

test('light stays inside the changed cell, in every look and for a contact, so a neighbouring piece never takes any', () => {
  const cell = { x: 100, y: 40, w: 30, h: 15, usd: 1e6 };
  const mk = (kind: 'depth' | 'contact', sign: 1 | -1): Cue => ({ key: 'k', id: 'a:BTC', side: 'ask', row: 5, sign, strength: 0.8, usd: 1e6 * sign, t0: 0, removed: false, added: false, pair: false, band: false, cost: 100, seq: 1, kind, life: kind === 'contact' ? CONTACT_LIFE_MS : CUE_LIFE_MS, buy: sign > 0 });
  for (const palette of [PALETTES.dark!, PALETTES.light!]) for (const look of ['wash', 'rim', 'deposit'] as const) for (const kind of ['depth', 'contact'] as const) for (const sign of [1, -1] as const) for (const age of [0, 40, 120, 300, 500]) {
    const { m, fills } = recorder();
    paintCue(m, look, mk(kind, sign), cell, age, palette);
    for (const f of fills) {
      const c = f.clip; assert.ok(c, `${palette.dark ? 'dark' : 'light'} ${look} ${kind} ${sign} at ${age}: a fill outside any clip`);
      assert.deepEqual(c, [cell.x, cell.y, cell.w, cell.h], 'the clip is the cell');
    }
  }
  const { m, fills } = recorder();
  paintCue(m, 'wash', mk('depth', 1), cell, 380, PALETTES.dark!);
  const crest = fills.find(f => f.w === 2.2)!;
  assert.ok(crest && crest.x >= cell.x && crest.x + crest.w <= cell.x + cell.w + 1e-9, 'at the end of its run the crest lies inside the cell, against its outer edge');
  const none = recorder(); paintCue(none.m, 'marks', mk('depth', 1), cell, 100, PALETTES.dark!); paintCue(none.m, 'marks', mk('contact', 1), cell, 100, PALETTES.dark!);
  assert.equal(none.fills.length, 0, 'the Signs look paints no light, contacts included');
});

test('the heat strip has a tone that reads on every theme and is not near its buy or sell colour', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    const tone = heatTone(p);
    assert.match(tone, /^#[0-9a-f]{6}$/i, `${name}: a colour`);
    assert.ok(contrastRatio(tone, p.panel) >= 3 - 1e-9, `${name}: ${tone} on ${p.panel} reads at ${contrastRatio(tone, p.panel).toFixed(2)}`);
    assert.ok(tone === p.text || !nearDirection(tone, p), `${name}: ${tone} is near its buy or sell colour`);
  }
});

test('a strong change is lit while faint ones are still running out', () => {
  const board = new CueBoard({ maxCues: 3, maxArea: 1e9 });
  board.push([1, 2, 3].map(i => row(`v${i}:BTC`, 'ask', i, 1e6, 0.5))); board.admit(1_000, 'wash', flat());
  board.push([row('big:BTC', 'ask', 9, 9e6, 1)]); board.admit(1_900, 'wash', flat());
  assert.equal(board.active.length, 4); assert.equal(board.brightCount(1_900), 1); assert.equal(board.stats.turnedDown, 0);
});

test('the changes waiting at a cell are taken in the order they happened: the newest decides its sign, whatever its size, and the same sign adds up', () => {
  const later = new CueBoard();
  later.push([row('a:BTC', 'ask', 5, 3e6, 0.8, { seq: 11 }), row('a:BTC', 'ask', 5, -1e6, 0.4, { seq: 12 })]);
  later.admit(1_000, 'wash', flat());
  assert.equal(later.active.length, 1); assert.deepEqual([later.active[0]!.sign, later.active[0]!.strength], [-1, 0.4], 'the decrease came last: the cell ends lower, though the addition was larger');
  const earlier = new CueBoard();
  earlier.push([row('a:BTC', 'ask', 5, 3e6, 0.8, { seq: 22 }), row('a:BTC', 'ask', 5, -1e6, 0.4, { seq: 21 })]); // queued newest first
  earlier.admit(1_000, 'wash', flat());
  assert.deepEqual([earlier.active[0]!.sign, earlier.active[0]!.strength], [1, 0.8], 'the older decrease cannot take the place of the newer addition');
  const same = new CueBoard();
  same.push([row('a:BTC', 'ask', 5, 1e6, 0.5, { seq: 31 }), row('a:BTC', 'ask', 5, 2e6, 0.7, { seq: 32 })]); same.admit(1_000, 'wash', flat());
  assert.equal(same.active.length, 1); assert.deepEqual([same.active[0]!.usd, same.active[0]!.strength], [3e6, 0.7]);
  assert.equal(same.marks.get(markKey(5))!.sign, 1);
});

test('a renewed cue is charged at the strength it keeps, and every cue is charged for the cell it lights after each draw', () => {
  const board = new CueBoard({ maxCues: 10, maxArea: 1e9 });
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); board.admit(1_000, 'wash', flat());
  board.push([row('a:BTC', 'ask', 5, 1e5, 0.2)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active[0]!.strength, 0.9);
  assert.ok(Math.abs(board.active[0]!.cost - 1_000 * (0.25 + 0.75 * 0.9)) < 1e-9, 'the 0.9 it keeps, not the 0.2 that renewed it');
  const grown = (w: number): Geometry => ({ rowVisible: () => true, cell: () => ({ x: 0, y: 0, w, h: 10, usd: 5e6 }) });
  board.reprice(1_150, 'wash', grown(400));
  assert.ok(Math.abs(board.active[0]!.cost - 4_000 * (0.25 + 0.75 * 0.9)) < 1e-9, 'the cell grew: so did the charge');
  board.reprice(1_150, 'rim', grown(400));
  assert.ok(Math.abs(board.active[0]!.cost - 4_000 * (0.25 + 0.75 * 0.9) * 0.2) < 1e-9, 'another look lights another share of it');
  board.reprice(1_150, 'wash', { rowVisible: () => true, cell: () => null });
  assert.equal(board.active.length, 0, 'a cue whose cell is gone ends');
});

test('cells that grew past the area cap end the dimmest cue first, and only as many as the cap needs', () => {
  const board = new CueBoard({ maxCues: 10, maxArea: 5_200 });
  board.push([row('a:BTC', 'ask', 1, 1e6, 1), row('b:BTC', 'ask', 2, 1e6, 0.3), row('c:BTC', 'ask', 3, 1e6, 0.6)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 3);
  board.reprice(1_000, 'wash', { rowVisible: () => true, cell: () => ({ x: 0, y: 0, w: 300, h: 10, usd: 1 }) });
  assert.deepEqual(board.active.map(c => c.id).sort(), ['a:BTC', 'c:BTC'], 'the faintest went: 6,525 px2 became 5,100');
  assert.ok(board.litArea(1_000) <= 5_200);
});

test('the area cap follows the ladder on screen: a share of it, capped, and never under what lights a few cells', () => {
  assert.equal(maxAreaFor(420, 540), 0.05 * 420 * 540, 'a desktop book: about 11,000 px2');
  assert.equal(maxAreaFor(1_000, 1_000), MAX_CUE_AREA, 'a large one: the cap');
  assert.equal(maxAreaFor(375, 210), 0.05 * 375 * 210, 'a phone\'s book: a third of that');
  assert.equal(maxAreaFor(50, 50), MIN_CUE_AREA);
  const board = new CueBoard({ maxCues: 10, maxArea: 1e9 });
  board.setMaxArea(2_500);
  board.push([1, 2, 3, 4].map(i => row(`v${i}:BTC`, 'bid', i, -1e6, 1))); board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 2, 'two 1,000 px2 cells at full strength fit under 2,500');
});

test('a full list drops its weakest, not its oldest, so a flood of faint changes cannot push out a strong one', () => {
  const list: { strength: number; n: number }[] = [];
  for (let i = 0; i < 5; i++) pushStrongest(list, { strength: 0.5, n: i }, 5);
  pushStrongest(list, { strength: 0.9, n: 5 }, 5); pushStrongest(list, { strength: 0.1, n: 6 }, 5);
  assert.deepEqual(list.map(x => x.n).sort(), [1, 2, 3, 4, 5], 'the new strong one took the first weakest\'s place; the faintest of all was not let in');
  const board = new CueBoard();
  board.push([row('quiet:BTC', 'ask', 1, 5e6, 0.95)]);
  board.push(Array.from({ length: 600 }, (_, i) => row('busy:BTC', 'ask', 100 + i, 1e5, 0.15)));
  assert.equal(board.waiting, 512);
  board.admit(1_000, 'wash', flat());
  assert.ok(board.active.some(c => c.id === 'quiet:BTC'), 'the quiet venue\'s strongest change survived 600 weaker ones queued after it'); assert.ok(board.marks.has(markKey(1)));
});

test('a newer change is never behind an older one in a full queue, and a quiet venue keeps its only change however faint', () => {
  const board = new CueBoard();
  // an older strong decrease at a cell, then 600 stronger changes of other cells, then a newer weak addition at the first cell
  board.push([row('a:BTC', 'ask', 1, -3e6, 0.9, { seq: 1 })]);
  board.push(Array.from({ length: 600 }, (_, i) => row(`v${i % 14}:BTC`, 'bid', 100 + i, -4e6, 0.95, { seq: 2 + i })));
  board.push([row('a:BTC', 'ask', 1, 3e5, 0.2, { seq: 700 })]);
  assert.ok(board.waiting <= 512);
  board.admit(1_000, 'wash', flat());
  const cue = board.active.find(c => c.id === 'a:BTC' && c.row === 1);
  assert.ok(cue && cue.sign === 1 && cue.strength === 0.2, 'the cell was last seen adding: it is not painted as the older removal');
  const fair = new CueBoard();
  fair.push([row('quiet:BTC', 'ask', 1, 1e5, 0.12, { seq: 1 })]);
  fair.push(Array.from({ length: 700 }, (_, i) => row('busy:BTC', 'ask', 100 + i, 2e6, 0.5, { seq: 2 + i })));
  fair.admit(1_000, 'wash', flat());
  assert.ok(fair.active.some(c => c.id === 'quiet:BTC') && fair.marks.has(markKey(1)), 'a weaker quiet venue survives a flood of stronger changes: it gets light and a mark');
  const list = [...Array.from({ length: 6 }, (_, i) => ({ id: 'busy', strength: 0.5 + i / 100 })), { id: 'quiet', strength: 0.01 }];
  const dropped = evictFairly(list, 4);
  assert.equal(dropped.length, 3); assert.ok(dropped.every(x => x.id === 'busy'), 'what it let go is what it returns');
  assert.deepEqual(list.map(x => x.id).sort(), ['busy', 'busy', 'busy', 'quiet'], 'the busy venue gave up three of its faintest, the quiet one kept its only');
  assert.ok(list.filter(x => x.id === 'busy').every(x => x.strength >= 0.53), 'its three strongest stayed');
});

test('a shed event queue keeps no older direction of a cell whose newer change it let go', () => {
  const ev = (id: string, lo: number, usd: number, seq: number, strength: number) => ({ id, side: 'ask' as const, lo, hi: lo + 20, seq, strength, usd });
  const queue = [ev('a:BTC', 81_000, -3e6, 1, 0.9), ...Array.from({ length: 511 }, (_, i) => ev(`v${i % 11}:BTC`, 82_000 + 20 * i, -4e6, 2 + i, 0.95))];
  queue.push(ev('a:BTC', 81_000, 3e5, 700, 0.2));   // the cell's newer change: weak, and in the busiest venue's company, so it is the first to go
  shedEvents(queue, 512);
  assert.ok(queue.length <= 512);
  assert.ok(!queue.some(e => e.id === 'a:BTC' && e.lo === 81_000 && e.seq < 700) || queue.some(e => e.id === 'a:BTC' && e.lo === 81_000 && e.seq === 700), 'the older -$3M is not left standing as the cell\'s latest');
  const small = [ev('x:BTC', 1, 1e6, 1, 0.5), ev('x:BTC', 1, -1e6, 2, 0.1), ev('y:BTC', 2, 1e6, 3, 0.9)];
  shedEvents(small, 2);
  assert.deepEqual(small.map(e => [e.id, e.seq]), [['y:BTC', 3]], 'x lost its weakest (the newer one, seq 2): its older one goes with it, and y keeps its own');
});

test('the crest is part of the light a cue holds a place by: both are under a tenth of their peak after about half a second', () => {
  const change = { kind: 'depth' as const, life: CUE_LIFE_MS };
  for (let age = 0; age <= CUE_LIFE_MS; age += 10) {
    assert.ok(shareAt(change, age) >= pulseEnvelope(age) - 1e-12 && shareAt(change, age) >= crestLight(1, age) - 1e-12 && shareAt(change, age) <= 1, `age ${age}`);
  }
  assert.ok(crestLight(1, CREST_MS) > 0.45, 'the crest keeps its brightness while it crosses the cell');
  assert.ok(shareAt(change, 500) > BRIGHT_SHARE && shareAt(change, 620) < BRIGHT_SHARE, `at 620 ms a crest of ${crestLight(1, 620).toFixed(3)} no longer holds a place`);
});

test('a row has one mark whichever side made it, and it keeps the side it was made on; Single mode keeps one for each venue', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'bid', 5, -2e6, 0.7)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.markAt(5)!.side, 'bid');
  board.push([row('b:BTC', 'ask', 5, 3e6, 0.9)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.marks.size, 1, 'one mark a box'); assert.deepEqual([board.markAt(5)!.side, board.markAt(5)!.id], ['ask', 'b:BTC']);
  const single = new CueBoard();
  single.push([row('a:BTC', 'bid', 5, -2e6, 0.7), row('b:BTC', 'ask', 5, 3e6, 0.9)]); single.admit(1_000, 'wash', flat(), true);
  assert.equal(single.marks.size, 2); assert.equal(single.markAt(5, 'a:BTC')!.side, 'bid'); assert.equal(single.markAt(5, 'b:BTC')!.side, 'ask'); assert.equal(single.markAt(5), undefined);
});

test('dim() puts the light out and keeps the marks', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 1);
  board.dim(); assert.equal(board.active.length, 0); assert.equal(board.marks.size, 1);
});

test('a row\'s mark is the strongest recent change on it, and the look of marks only lights nothing', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); board.admit(1_000, 'wash', flat());
  board.push([row('b:BTC', 'ask', 5, 1e5, 0.05)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.marks.get(markKey(5))!.id, 'a:BTC', 'a weak change does not replace a strong one');
  board.push([row('c:BTC', 'ask', 5, -5e6, 0.8)]); board.admit(1_200, 'wash', flat());
  assert.equal(board.marks.get(markKey(5))!.id, 'c:BTC', 'a comparable change of the other sign does');
  board.push([row('d:BTC', 'ask', 5, 2e5, 0.9)]); board.admit(1_000 + MARK_LIFE_MS - 50, 'wash', flat());
  assert.equal(board.marks.get(markKey(5))!.id, 'd:BTC', 'a fading mark gives way to a fresh one of the same strength');
  const marks = new CueBoard();
  marks.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); marks.admit(1_000, 'marks', flat());
  assert.equal(marks.active.length, 0); assert.equal(marks.marks.get(markKey(5))!.lit, false); assert.equal(marks.stats.off, 1);
});

test('a look pays for the area it lights: a rim costs a fifth of a wash', () => {
  const wash = new CueBoard(), rim = new CueBoard(), deposit = new CueBoard();
  for (const [b, look] of [[wash, 'wash'], [rim, 'rim'], [deposit, 'deposit']] as const) { b.push([row('a:BTC', 'ask', 5, 1e6, 1)]); b.admit(1_000, look, flat()); }
  assert.ok(Math.abs(rim.used / wash.used - 0.2) < 1e-9); assert.ok(Math.abs(deposit.used / wash.used - 0.6) < 1e-9);
});

test('the waiting changes are bounded, and clear() empties everything', () => {
  const board = new CueBoard();
  board.push(Array.from({ length: 1_000 }, (_, i) => row('a:BTC', 'ask', i, 1e6, 0.5)));
  assert.equal(board.waiting, 512);
  board.admit(1_000, 'wash', flat()); assert.ok(board.active.length > 0 && board.marks.size > 0);
  board.push([row('a:BTC', 'ask', 1, 1e6, 0.5)]); board.clear();
  assert.deepEqual([board.active.length, board.marks.size, board.waiting], [0, 0, 0]);
});
