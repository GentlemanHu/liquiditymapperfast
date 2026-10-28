import test from 'node:test';
import assert from 'node:assert/strict';
import { View } from '../src/app/view.ts';
import { DrawController, type DrawHost } from '../src/app/draw/controller.ts';
import { DRAW_DEFAULTS, readDrawSettings, type DrawSettings } from '../src/app/draw/settings.ts';
import type { DrawStore } from '../src/app/draw/storage.ts';
import type { DrawDoc } from '../src/app/draw/model.ts';
import { MAX_PER_COIN, newDrawing } from '../src/app/draw/model.ts';

const T = Date.UTC(2026, 9, 28, 0), H = 3_600_000;

/** A map 1000 x 500 px over ten hours and the prices 100 to 200, with one candle (10:00 to 11:00 is not on it: 2:00 to 3:00, high 160). */
function setup(o: { settings?: Partial<DrawSettings>; replay?: boolean; doc?: DrawDoc | null; walls?: { p: number; usd: number }[] } = {}) {
  const view = new View({ t0: T, t1: T + 10 * H, p0: 100, p1: 200 });
  let settings: DrawSettings = { ...DRAW_DEFAULTS, ...o.settings };
  let coin = 'BTC', saved: DrawDoc | null = o.doc === undefined ? { version: 1, coins: {} } : o.doc;
  const calls: string[] = [], alerts: string[] = [], inspected: unknown[] = [], focused: { t0: number; t1: number; p0: number; p1: number }[] = [];
  let failSave = false, other: (() => void) | null = null;
  const host: DrawHost = {
    view, plotW: () => 1000, plotH: () => 500,
    candleAt: x => (x >= 200 && x < 300 ? { t: T + 2.5 * H, x: 250, open: 150, high: 160, low: 140, close: 155, y: p => view.yOf(p, 500) } : null),
    closesOnly: () => false, wallsAt: () => o.walls ?? [], restingAt: () => ({ bid: 1e6, ask: 0, step: 1 }),
    mark: () => 150, coin: () => coin, now: () => T + 9 * H, replaying: () => o.replay === true, settings: () => settings, reveal: () => { settings = { ...settings, shown: true }; },
    holdStill: () => calls.push('hold'), disarmOthers: () => calls.push('disarm-others'), focus: box => { calls.push('focus'); focused.push(box); },
    inspect: box => inspected.push(box), alert: text => alerts.push(text), redraw: () => {},
  };
  const store: DrawStore = { load: () => saved, save: doc => { if (failSave) return false; saved = JSON.parse(JSON.stringify(doc)); return true; }, onOtherTab: l => { other = l; } };
  const draw = new DrawController(host, store);
  return {
    draw, calls, alerts, inspected, focused, view,
    get saved() { return saved; }, set coin(c: string) { coin = c; }, set settings(s: Partial<DrawSettings>) { settings = { ...settings, ...s }; },
    set failSave(v: boolean) { failSave = v; }, otherTab(doc: DrawDoc) { saved = doc; other?.(); },
  };
}
const y = (p: number): number => (200 - p) * 5, x = (hours: number): number => hours * 100;

test('a level is one click; the weak magnet lands it on the candle\'s high, Alt places it where the pointer is', () => {
  const s = setup();
  s.draw.arm('level');
  assert.deepEqual(s.calls, ['disarm-others'], 'Range and VWAP anchoring are put away');
  assert.equal(s.draw.click({ x: 260, y: y(160) + 5 }, false, false), true);
  const [d] = s.draw.list();
  assert.equal(d!.kind, 'level'); assert.equal(d!.points[0]!.p, 160, 'on the high');
  assert.equal(s.draw.tool, null, 'one drawing, then back to the map');
  assert.equal(s.draw.selected, d!.id, 'the new drawing is selected');
  s.draw.arm('level'); s.draw.click({ x: 260, y: y(160) + 5 }, true, false);
  assert.ok(Math.abs(s.draw.list()[1]!.points[0]!.p - 159) < 1e-9, 'Alt: one dollar under the high, where the pointer was');
  assert.equal(s.saved!.coins.BTC!.length, 2, 'kept as it was drawn');
});

test('a zone takes two clicks; the same point twice is not the second; Keep the tool keeps it armed', () => {
  const s = setup({ settings: { keep: true, magnet: 'off' } });
  s.draw.arm('zone');
  s.draw.click({ x: 400, y: 100 }, false, false);
  assert.equal(s.draw.draft?.points.length, 1);
  s.draw.click({ x: 401, y: 101 }, false, false);
  assert.equal(s.draw.draft?.points.length, 1, 'a double click is not the second corner');
  s.draw.click({ x: 600, y: 200 }, false, false);
  assert.equal(s.draw.list().length, 1); assert.equal(s.draw.tool, 'zone', 'kept armed');
  assert.deepEqual(s.calls.filter(c => c === 'hold'), ['hold'], 'the map stopped following at the first point');
});

test('only the selected drawing drags: a handle moves its point, its stroke moves it whole, one step to undo', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('trend'); s.draw.click({ x: x(1), y: y(150) }, false, false); s.draw.click({ x: x(5), y: y(170) }, false, false);
  const id = s.draw.selected!;
  s.draw.selected = null;
  assert.equal(s.draw.down({ x: x(1), y: y(150) }, false), false, 'not selected: the press pans the map');
  s.draw.click({ x: x(3), y: y(160) }, false, false);
  assert.equal(s.draw.selected, id, 'a click on its stroke selects it');
  assert.equal(s.draw.down({ x: x(1), y: y(150) }, false), true, 'its first handle');
  s.draw.move({ x: x(2), y: y(140) }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [140, 170]);
  assert.equal(s.draw.down({ x: x(3.5), y: y(155) }, false), true, 'its stroke, where the line now runs');
  s.draw.move({ x: x(4.5), y: y(165) }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points.map(q => Math.round(q.p)), [150, 180], 'moved ten dollars up');
  s.draw.undo();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [140, 170], 'the move taken back in one step');
  s.draw.undo();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [150, 170], 'then the handle');
  s.draw.redo();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [140, 170]);
});

test('Esc goes back one level at a time: a drag, a half-placed drawing, an armed tool, the selection', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: 250 }, false, false);
  const id = s.draw.selected!;
  s.draw.down({ x: 500, y: 250 }, false); s.draw.move({ x: 500, y: 100 }, false, false);
  assert.equal(s.draw.cancel(), true);
  assert.equal(s.draw.get(id)!.points[0]!.p, 150, 'the drag went back');
  s.draw.arm('trend'); s.draw.click({ x: 100, y: 100 }, false, false);
  assert.equal(s.draw.cancel(), true); assert.equal(s.draw.draft, null); assert.equal(s.draw.tool, 'trend');
  assert.equal(s.draw.cancel(), true); assert.equal(s.draw.tool, null);
  s.draw.selected = id;
  assert.equal(s.draw.cancel(), true); assert.equal(s.draw.selected, null);
  assert.equal(s.draw.cancel(), false, 'nothing left: the key goes on');
});

test('the keys: Delete removes the selection, Ctrl+Z undoes, nothing is taken while a field has the keys', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: 250 }, false, false);
  const key = (k: string, mods: Partial<KeyboardEvent> = {}, target: unknown = null) => s.draw.key({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: target as EventTarget, defaultPrevented: false, ...mods }, false);
  assert.equal(key('Delete', {}, { tagName: 'INPUT' }), false, 'typing in a field');
  assert.equal(key('Delete'), true); assert.equal(s.draw.list().length, 0);
  assert.equal(key('z', { ctrlKey: true }), true); assert.equal(s.draw.list().length, 1);
  assert.equal(key('z', { ctrlKey: true, shiftKey: true }), true); assert.equal(s.draw.list().length, 0);
  assert.equal(key('y', { metaKey: true }), false, 'nothing left to redo: the browser keeps the key');
});

test('a locked drawing cannot move or go; Lock all, a replay and a newer page\'s drawings stop every change', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: 250 }, false, false);
  const id = s.draw.selected!;
  s.draw.update(id, { locked: true });
  assert.equal(s.draw.down({ x: 500, y: 250 }, false), false); s.draw.remove(id); s.draw.update(id, { text: 'x' });
  assert.deepEqual([s.draw.list().length, s.draw.get(id)!.text], [1, ''], 'still there, unchanged');
  s.draw.update(id, { locked: false }); assert.equal(s.draw.get(id)!.locked, false, 'unlocking is the one change allowed');
  s.settings = { locked: true };
  s.draw.arm('zone'); assert.equal(s.draw.tool, null); assert.match(s.draw.message!.text, /locked/);
  const r = setup({ replay: true }); r.draw.arm('level'); assert.equal(r.draw.tool, null);
  const newer = setup({ doc: null }); assert.equal(newer.draw.readOnly, true); assert.match(newer.draw.message!.text, /newer version/);
  newer.draw.arm('level'); assert.equal(newer.draw.tool, null);
});

test('each coin has its own drawings and its own Undo; another coin lets go of what was in hand', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('trend'); s.draw.click({ x: 100, y: 100 }, false, false);
  s.coin = 'ETH';
  assert.equal(s.draw.list().length, 0); assert.equal(s.draw.draft, null, 'the half-placed line belonged to BTC');
  assert.equal(s.draw.undo(), false, 'nothing of ETH to undo');
  s.draw.arm('level'); s.draw.click({ x: 500, y: 250 }, false, false);
  s.coin = 'BTC';
  assert.equal(s.draw.list().length, 0); s.coin = 'ETH'; assert.equal(s.draw.list().length, 1);
});

test('a coin keeps a hundred drawings; a failed save is said and the next good one clears it; another tab\'s save is read', () => {
  const full = { version: 1 as const, coins: { BTC: Array.from({ length: MAX_PER_COIN }, (_, i) => newDrawing('level', [{ t: T + i, p: 150 }], T + i)) } };
  const s = setup({ doc: full, settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: 250 }, false, false);
  assert.equal(s.draw.list().length, MAX_PER_COIN); assert.match(s.draw.message!.text, /100/);
  const f = setup({ settings: { magnet: 'off' } });
  f.failSave = true; f.draw.arm('level'); f.draw.click({ x: 500, y: 250 }, false, false);
  assert.match(f.draw.message!.text, /could not be kept/);
  f.failSave = false; f.draw.arm('level'); f.draw.click({ x: 500, y: 200 }, false, false);
  assert.equal(f.draw.message, null);
  f.otherTab({ version: 1, coins: { BTC: [newDrawing('zone', [{ t: T, p: 120 }, { t: T + H, p: 130 }], T)] } });
  assert.deepEqual(f.draw.list().map(d => d.kind), ['zone'], 'what the other tab kept');
  assert.equal(f.draw.canUndo, false, 'its steps no longer fit');
});

test('a level with its alert sounds when the price crosses or reaches it, and not when it stays on one side', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(155) }, false, false);
  const id = s.draw.selected!;
  s.draw.markMoved(150); s.draw.markMoved(154);
  assert.deepEqual(s.alerts, [], 'no alert asked for');
  s.draw.update(id, { alert: true, text: 'Big ask wall' });
  s.draw.markMoved(156);
  assert.equal(s.alerts.length, 1); assert.match(s.alerts[0]!, /Big ask wall/);
  s.draw.markMoved(157); assert.equal(s.alerts.length, 1, 'still above: nothing');
  s.draw.markMoved(155); assert.equal(s.alerts.length, 2, 'back down to it');
});

test('Inspect asks the Range tool about a zone\'s box, and about a level\'s row over the time on the map', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(130) }, false, false); s.draw.click({ x: x(4), y: y(120) }, false, false);
  s.draw.inspect(s.draw.selected!);
  assert.deepEqual(s.inspected[0], { t0: T + H, t1: T + 4 * H, p0: 120, p1: 130 });
  s.draw.arm('level'); s.draw.click({ x: x(5), y: y(150) }, false, false);
  s.draw.inspect(s.draw.selected!);
  assert.deepEqual(s.inspected[1], { t0: T, t1: T + 9 * H, p0: 149.5, p1: 150.5 }, 'up to now, one row of the book');
});

test('a wall near the pointer is a magnet target too, while that is on', () => {
  const s = setup({ walls: [{ p: 170, usd: 5e6 }] });
  s.draw.arm('level'); s.draw.click({ x: 600, y: y(170) + 4 }, false, false);
  assert.equal(s.draw.list()[0]!.points[0]!.p, 170);
  const off = setup({ walls: [{ p: 170, usd: 5e6 }], settings: { walls: false } });
  off.draw.arm('level'); off.draw.click({ x: 600, y: y(170) + 4 }, false, false);
  assert.notEqual(off.draw.list()[0]!.points[0]!.p, 170);
});

test('the settings are read field by field, a weak magnet from the first visit', () => {
  assert.deepEqual(readDrawSettings(undefined), { magnet: 'weak', walls: true, keep: false, shown: true, locked: false });
  assert.deepEqual(readDrawSettings({ magnet: 'mega', walls: 'no', keep: true }), { magnet: 'weak', walls: true, keep: true, shown: true, locked: false });
});

test('a drag stops where a drawing could not be kept; Undo never goes past the caps; a newer save in another tab locks this one; Lock all stops a file', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(110) }, false, false);
  const id = s.draw.selected!;
  s.draw.down({ x: 500, y: y(110) }, false); s.draw.move({ x: 500, y: 1200 }, false, false); s.draw.up();
  assert.ok(s.draw.get(id)!.points[0]!.p > 0, 'never at or below zero');
  const many = { version: 1 as const, coins: { ETH: Array.from({ length: MAX_PER_COIN }, (_, i) => newDrawing('level', [{ t: T + i, p: 150 }], T + i)) } };
  const c = setup({ settings: { magnet: 'off' } });
  c.draw.arm('level'); c.draw.click({ x: 500, y: 250 }, false, false);
  c.draw.remove(c.draw.selected!);
  // Another tab fills the page to the brim (ten coins of a hundred), then this tab undoes the delete.
  const full = { version: 1 as const, coins: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`C${k}`, many.coins.ETH])) };
  c.otherTab(full);
  assert.equal(c.draw.undo(), false, 'nothing to undo after the other tab: its steps were let go');
  const n = setup({ settings: { magnet: 'off' } });
  n.otherTab(null as never);
  assert.equal(n.draw.readOnly, true, 'a newer page wrote them in another tab');
  n.draw.arm('level'); assert.equal(n.draw.tool, null);
  const l = setup({ settings: { locked: true } });
  assert.match(l.draw.importText('{"format":"liquiditymapperfast-drawings","version":1,"coins":{}}'), /locked/);
});

test('Find centres a level without zooming out (each press the same view); Undo that would pass the cap of the page is refused', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(130) }, false, false);
  const id = s.draw.selected!;
  s.draw.find(id); s.draw.find(id);
  for (const box of s.focused) { assert.equal(box.t0, box.t1, 'no span of time of its own'); assert.equal(box.p0, 130); assert.equal(box.p1, 130); }
  // Nine coins of a hundred and 99 on ETH: 999. BTC places one and deletes it; ETH then takes the last place on the page.
  const many = (n: number) => Array.from({ length: n }, (_, i) => newDrawing('level', [{ t: T + i, p: 150 }], T + i));
  const coins: Record<string, ReturnType<typeof many>> = Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`C${k}`, many(MAX_PER_COIN)]));
  coins.ETH = many(99);
  const c = setup({ settings: { magnet: 'off' }, doc: { version: 1, coins } });
  c.draw.arm('level'); c.draw.click({ x: 500, y: 250 }, false, false);
  c.draw.remove(c.draw.selected!);
  c.coin = 'ETH'; c.draw.arm('level'); c.draw.click({ x: 500, y: 250 }, false, false);
  assert.equal(c.draw.list().length, 100);
  c.coin = 'BTC';
  assert.equal(c.draw.undo(), false, 'bringing the deleted one back would make 1,001');
  assert.equal(c.draw.list().length, 0);
  assert.match(c.draw.message?.text ?? '', /1,000|100/);
  // A locked drawing is still hidden and shown.
  const l = setup({ settings: { magnet: 'off' } });
  l.draw.arm('level'); l.draw.click({ x: 500, y: 250 }, false, false);
  const lid = l.draw.selected!;
  l.draw.update(lid, { locked: true }); l.draw.update(lid, { hidden: true });
  assert.equal(l.draw.get(lid)!.hidden, true); l.draw.update(lid, { hidden: false }); assert.equal(l.draw.get(lid)!.hidden, false);
  l.draw.update(lid, { text: 'no' }); assert.equal(l.draw.get(lid)!.text, '', 'nothing else changes it');
});
