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
  let coin = 'BTC', saved: DrawDoc | null = o.doc === undefined ? { version: 1, coins: {} } : o.doc, reachedThem = true;
  let answer: (() => Promise<boolean>) | null = null;
  const calls: string[] = [], alerts: string[] = [], inspected: unknown[] = [], focused: { t0: number; t1: number; p0: number; p1: number }[] = [];
  let failSave = false, other: (() => void) | null = null;
  const host: DrawHost = {
    view, plotW: () => 1000, plotH: () => 500,
    candleAt: x => (x >= 200 && x < 300 ? { t: T + 2.5 * H, x: 250, open: 150, high: 160, low: 140, close: 155, y: p => view.yOf(p, 500) } : null),
    closesOnly: () => false, wallsAt: () => o.walls ?? [], restingAt: () => ({ bid: 1e6, ask: 0, step: 1 }),
    mark: () => 150, coin: () => coin, now: () => T + 9 * H, replaying: () => o.replay === true, settings: () => settings, reveal: () => { settings = { ...settings, shown: true }; },
    disarmOthers: () => calls.push('disarm-others'), focus: box => { calls.push('focus'); focused.push(box); },
    inspect: box => inspected.push(box), alert: text => { alerts.push(text); return answer ? answer() : Promise.resolve(reachedThem); }, redraw: () => {},
  };
  const store: DrawStore = { load: () => saved, save: doc => { if (failSave) return false; saved = JSON.parse(JSON.stringify(doc)); return true; }, onOtherTab: l => { other = l; } };
  const draw = new DrawController(host, store);
  return {
    draw, calls, alerts, inspected, focused, view,
    get saved() { return saved; }, set coin(c: string) { coin = c; }, set settings(s: Partial<DrawSettings>) { settings = { ...settings, ...s }; }, set reachedThem(v: boolean) { reachedThem = v; }, set stored(doc: DrawDoc) { saved = doc; }, set alertAnswer(f: () => Promise<boolean>) { answer = f; },
    set failSave(v: boolean) { failSave = v; }, otherTab(doc: DrawDoc) { saved = doc; other?.(); },
  };
}
const y = (p: number): number => (200 - p) * 5, x = (hours: number): number => hours * 100;
/** Prices read a second apart on one market, as the page reads the chart market's (no candle: the bells judge the prices alone). */
let clockAt = T + 9 * H;
const look = (price: number, market = 'binance:BTCUSDT') => ({ market, price, at: (clockAt += 1_000), candle: null });

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

test('a level with its bell goes off when the price crosses or reaches it, from the reading after the bell stood, never staying on one side', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(155) }, false, false);
  const id = s.draw.selected!;
  s.draw.markMoved(look(150)); s.draw.markMoved(look(154));
  assert.deepEqual(s.alerts, [], 'no bell, no alert');
  s.draw.update(id, { alert: true, text: 'Big ask wall' });
  s.draw.markMoved(look(156));
  assert.deepEqual(s.alerts, [], 'a bell switched on is judged from the reading after it stood: the price was not seen moving through it yet');
  s.draw.markMoved(look(154));
  assert.equal(s.alerts.length, 1, 'back down through it'); assert.match(s.alerts[0]!, /Big ask wall/);
  s.draw.markMoved(look(153)); assert.equal(s.alerts.length, 1, 'still below: nothing');
  s.draw.markMoved(look(155)); assert.equal(s.alerts.length, 2, 'up to it: a bell kept every time goes off again');
  s.draw.markMoved(look(170, 'binance:BTCUSDT_PERP')); s.draw.markMoved(look(150, 'binance:BTCUSDT_PERP'));
  assert.equal(s.alerts.length, 3, 'another market\'s first price is no move; its next one through the level is');
  s.draw.forgetPrice(); s.draw.markMoved(look(160, 'binance:BTCUSDT_PERP')); s.draw.markMoved(look(161, 'binance:BTCUSDT_PERP'));
  assert.equal(s.alerts.length, 3, 'forgetting the price starts afresh');
});

test('a bell put, moved or brought back onto the price does not go off at once', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.markMoved(look(150));
  assert.equal(s.draw.addAlertLevel(150.05), true, 'a bell a hair above the price');
  s.draw.markMoved(look(150.1));
  assert.deepEqual(s.alerts, [], 'the tick after it was put: it had not stood a reading yet');
  const id = s.draw.selected!;
  s.draw.markMoved(look(150.2)); s.draw.update(id, { points: [{ t: T + 9 * H, p: 150.3 }] });
  s.draw.markMoved(look(150.4));
  assert.deepEqual(s.alerts, [], 'moved across the price between two readings: a drawing moved, not the price');
  s.draw.markMoved(look(150.2));
  assert.equal(s.alerts.length, 1, 'once it stood, the price moving through it is an alert');
});

test('a bell that goes off once switches itself off only when the alert reached the person, in no step of Undo', async () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(155) }, false, false);
  const id = s.draw.selected!;
  s.draw.update(id, { alert: true, alertOnce: true });
  s.draw.update(id, { text: 'Weekly high' });
  s.reachedThem = false;
  s.draw.markMoved(look(150)); s.draw.markMoved(look(156));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.alerts.length, 1);
  assert.equal(s.draw.get(id)!.alert, true, 'heard by nobody, sent nowhere: the bell stays on for the next time');
  s.reachedThem = true;
  s.draw.markMoved(look(150));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.alerts.length, 2); assert.match(s.alerts[1]!, /155.*Weekly high/);
  assert.equal(s.draw.get(id)!.alert, false, 'reached them: switched off');
  assert.equal(s.saved!.coins.BTC!.find(d => d.id === id)!.alert, false, 'and kept so, for the other tabs');
  s.draw.markMoved(look(160)); s.draw.markMoved(look(150));
  assert.equal(s.alerts.length, 2, 'never again');
  assert.equal(s.draw.undo(), true);
  assert.equal(s.draw.get(id)!.text, '', 'Undo takes back the label, the person\'s last step');
  assert.equal(s.draw.get(id)!.alert, false, 'and does not switch the bell back on');
  assert.equal(s.draw.redo(), true);
  assert.equal(s.draw.get(id)!.alert, false, 'nor does Redo');
});

test('another tab\'s bell going off changes the bells here and keeps the steps, a drawing half placed and the drag', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(155) }, false, false);
  const id = s.draw.selected!;
  s.draw.update(id, { alert: true, alertOnce: true });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(130) }, false, false);
  assert.ok(s.draw.draft, 'a zone half placed');
  const there = JSON.parse(JSON.stringify(s.saved)) as DrawDoc;
  there.coins.BTC!.find(d => d.id === id)!.alert = false;
  s.otherTab(there);
  assert.equal(s.draw.get(id)!.alert, false, 'the bell went off there');
  assert.equal(s.draw.canUndo, true, 'the steps here are kept');
  assert.ok(s.draw.draft, 'and the zone half placed');
  assert.equal(s.draw.undo(), true); assert.equal(s.draw.get(id)?.alert ?? false, false, 'an Undo here does not switch it back on');
});

test('data that comes while the price stays put keeps the last reading current: a move after a quiet minute is judged', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.addAlertLevel(100);
  const at = (k: number) => T + 9 * H + k * 1_000;
  s.draw.markMoved({ market: 'm', price: 99, at: at(0), candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: at(1), candle: null });
  for (const k of [40, 80, 110]) s.draw.alive(at(k));
  s.draw.markMoved({ market: 'm', price: 101, at: at(120), candle: null });
  assert.equal(s.alerts.length, 1, 'the feed was alive all along: the price really went through');
  const q = setup({ settings: { magnet: 'off' } });
  q.draw.addAlertLevel(100);
  q.draw.markMoved({ market: 'm', price: 99, at: at(0), candle: null }); q.draw.markMoved({ market: 'm', price: 99, at: at(1), candle: null });
  q.draw.markMoved({ market: 'm', price: 101, at: at(120), candle: null });
  assert.equal(q.alerts.length, 0, 'nothing came for two minutes (the tab asleep): no comparison');
});

test('the Notify panel lists every coin\'s bells, changes another coin\'s at once, and adds a bell at a price', () => {
  const eth = { ...newDrawing('zone', [{ t: T, p: 120 }, { t: T + H, p: 130 }], T), alert: true };
  const s = setup({ settings: { magnet: 'off' }, doc: { version: 1, coins: { ETH: [eth] } } });
  assert.equal(s.draw.addAlertLevel(142.5), true);
  const mine = s.draw.selected!;
  assert.deepEqual(s.draw.bells().map(b => [b.coin, b.drawing.kind, b.drawing.alertOnce]).sort(), [['BTC', 'level', true], ['ETH', 'zone', false]]);
  s.draw.setBell('ETH', eth.id, { alertOnce: true });
  assert.equal(s.saved!.coins.ETH![0]!.alertOnce, true, 'another coin\'s bell, written at once');
  s.draw.setBell('BTC', mine, { alert: false });
  assert.equal(s.draw.get(mine)!.alert, false);
  assert.equal(s.draw.undo(), true); assert.equal(s.draw.get(mine)!.alert, true, 'this coin\'s change is a step Undo takes back');
  assert.equal(s.draw.addAlertLevel(Number.NaN), false, 'no price, no bell');
  const r = setup({ replay: true });
  assert.equal(r.draw.addAlertLevel(150), false, 'none added during a replay');
  assert.match(r.draw.message!.text, /replay/, 'and it says why');
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

/** A zone from 1 h at 180 to 4 h at 130 (x 100 to 400, y 100 to 350), drawn with the magnet off, selected, the magnet then at `magnet`. */
function boxed(magnet: DrawSettings['magnet'] = 'weak') {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(180) }, false, false); s.draw.click({ x: x(4), y: y(130) }, false, false);
  const id = s.draw.selected!, was = s.draw.get(id)!.points.map(q => ({ ...q }));
  s.settings = { magnet };
  return { s, id, was };
}

test('a zone\'s bottom edge moves a price alone: the weak magnet lands it on the candle under the pointer, Alt leaves it free, one step to undo', () => {
  const { s, id, was } = boxed();
  assert.equal(s.draw.down({ x: x(2.5), y: y(130) }, false), true, 'the middle of the bottom edge is a handle');
  assert.equal(s.draw.dragAxis, 'p');
  s.draw.move({ x: x(2.5), y: y(155) + 3 }, false, false);   // 3 px under the close of 155, over the candle (200 to 300 px)
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [180, 155], 'the close of the candle under the pointer');
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), was.map(q => q.t), 'no time moved');
  assert.equal(s.draw.cursor?.snap?.field, 'close'); assert.equal(s.draw.cursor?.x, 250, 'its ring stands on the candle that was read');
  s.draw.move({ x: x(2.5), y: y(140) + 4 }, false, false);
  assert.equal(s.draw.get(id)!.points[1]!.p, 140, 'and on its low, with the pointer moved on');
  s.draw.move({ x: x(2.5), y: y(155) + 3 }, true, false);
  assert.ok(Math.abs(s.draw.get(id)!.points[1]!.p - 154.4) < 1e-9, 'Alt: where the pointer is');
  s.draw.move({ x: x(2.5), y: y(170) }, false, false);
  assert.equal(s.draw.get(id)!.points[1]!.p, 170, 'far from every target: where the pointer is');
  s.draw.move({ x: x(2.5), y: y(160) + 2 }, false, false); s.draw.up();
  assert.equal(s.draw.dragAxis, null);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [180, 160], 'the high');
  s.draw.undo();
  assert.deepEqual(s.draw.get(id)!.points, was, 'one step back');
  assert.equal(s.draw.canUndo, true, 'the drawing\'s own step is still there');
});

test('a zone\'s top edge, over a candle\'s body: the box from a wick to a body (the price and nothing else moves)', () => {
  // The box starts at the low wick of 140 and is pulled up to the body: its bottom edge from the low to the open.
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: 250, y: y(140) }, false, false); s.draw.click({ x: x(5), y: y(175) }, false, false);
  const id = s.draw.selected!;
  s.settings = { magnet: 'weak' };
  const [a, b] = s.draw.get(id)!.points;
  assert.equal(s.draw.down({ x: (250 + x(5)) / 2, y: y(140) }, false), true, 'the bottom edge');
  s.draw.move({ x: 250, y: y(150) - 2 }, false, false); s.draw.up();
  const after = s.draw.get(id)!.points;
  assert.deepEqual(after.map(q => q.p), [150, 175], 'the open: the body\'s edge');
  assert.deepEqual(after.map(q => q.t), [a!.t, b!.t], 'its sides stayed');
});

test('a zone\'s sides move a time alone, to the candle\'s centre; a corner with no point takes one point\'s time and the other\'s price', () => {
  const { s, id, was } = boxed();
  assert.equal(s.draw.down({ x: x(1), y: (y(180) + y(130)) / 2 }, false), true, 'the left edge\'s middle');
  assert.equal(s.draw.dragAxis, 't');
  s.draw.move({ x: 253, y: 40 }, false, false);
  assert.equal(s.draw.get(id)!.points[0]!.t, T + 2.5 * H, 'the candle\'s centre');
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), was.map(q => q.p), 'no price moved');
  s.draw.move({ x: 253, y: 40 }, true, false);
  assert.ok(Math.abs(s.draw.get(id)!.points[0]!.t - (T + 2.53 * H)) < 1000, 'Alt: where the pointer is');
  s.draw.up(); s.draw.undo();
  assert.deepEqual(s.draw.get(id)!.points, was);
  // The corner at the first point's time and the second's price.
  assert.equal(s.draw.down({ x: x(1), y: y(130) }, false), true);
  assert.equal(s.draw.dragAxis, 'both');
  s.draw.move({ x: 250, y: y(140) }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points, [{ t: T + 2.5 * H, p: 180 }, { t: was[1]!.t, p: 140 }], 'the low of the candle, at its centre');
});

test('an edge pulled past the other edge is still the same point: the box turns over, and what was not moved stays', () => {
  const { s, id, was } = boxed('off');
  assert.equal(s.draw.down({ x: x(2.5), y: y(180) }, false), true, 'the top edge');
  s.draw.move({ x: x(2.5), y: y(110) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [110, 130], 'the top edge is under the bottom one');
  s.draw.move({ x: x(2.5), y: y(190) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), [190, 130], 'and back over it: still the first point, not the second');
  s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), was.map(q => q.t));
});

test('a level moved by its stroke lands on what the magnet catches at the pointer, an event line on a candle\'s time; the other drawings move as they were grabbed', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: x(5), y: y(120) }, false, false);
  const level = s.draw.selected!;
  s.settings = { magnet: 'weak' };
  assert.equal(s.draw.down({ x: x(7), y: y(120) }, false), true, 'by its stroke, away from its point');
  assert.equal(s.draw.dragAxis, 'both');
  s.draw.move({ x: 250, y: y(140) + 4 }, false, false);
  assert.equal(s.draw.get(level)!.points[0]!.p, 140, 'the low of the candle under the pointer');
  assert.equal(s.draw.cursor?.snap?.field, 'low');
  s.draw.move({ x: 250, y: y(140) + 4 }, true, false);
  assert.ok(Math.abs(s.draw.get(level)!.points[0]!.p - 139.2) < 1e-9, 'Alt: moved by the pointer own distance, 19.2 up from 120');
  s.draw.move({ x: x(7), y: y(130) }, false, false);
  assert.equal(s.draw.get(level)!.points[0]!.p, 130, 'over no candle: moved by the pointer\'s own distance');
  assert.equal(s.draw.cursor, null);
  s.draw.up();
  s.draw.undo();
  assert.equal(s.draw.get(level)!.points[0]!.p, 120);
  // An event line.
  s.draw.arm('vline'); s.draw.click({ x: x(5), y: 100 }, false, false);
  const line = s.draw.selected!;
  assert.equal(s.draw.down({ x: x(5), y: 100 }, false), true);
  s.draw.move({ x: 253, y: 100 }, false, false);
  assert.equal(s.draw.get(line)!.points[0]!.t, T + 2.5 * H, 'on the candle\'s time');
  s.draw.move({ x: 253, y: 100 }, true, false);
  assert.ok(Math.abs(s.draw.get(line)!.points[0]!.t - (T + 5 * H + (253 - x(5)) / 100 * H)) < 1000, 'Alt: moved by the pointer\'s distance');
  s.draw.up();
  // A trend line moves whole, over the candle or not.
  s.draw.arm('trend'); s.draw.click({ x: x(1), y: y(150) }, false, false); s.draw.click({ x: x(4), y: y(170) }, false, false);
  const trend = s.draw.selected!, before = s.draw.get(trend)!.points.map(q => ({ ...q }));
  assert.equal(s.draw.down({ x: x(2.5), y: y(160) }, false), true);
  s.draw.move({ x: 250, y: y(160) + 40 }, false, false); s.draw.up();
  const after = s.draw.get(trend)!.points;
  assert.deepEqual(after.map((q, i) => [q.t - before[i]!.t, q.p - before[i]!.p]), after.map(() => [0, -8]), 'both points by the same amount: no catch');
});

test('hovering the middle of an edge says which way it moves', () => {
  const { s } = boxed();
  const axis = (): string | null => (s.draw.hover && 'axis' in s.draw.hover ? s.draw.hover.axis : null);
  s.draw.move({ x: x(2.5), y: y(130) }, false, false);
  assert.equal(axis(), 'p');
  s.draw.move({ x: x(1), y: (y(180) + y(130)) / 2 }, false, false);
  assert.equal(axis(), 't');
  s.draw.move({ x: x(1), y: y(130) }, false, false);
  assert.equal(axis(), 'both');
});

test('the left edge of a zone that runs on follows the pointer past the time of the other point; the right point goes with it, and Undo takes both back', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(180) }, false, false); s.draw.click({ x: x(4), y: y(130) }, false, false);
  const id = s.draw.selected!, was = s.draw.get(id)!.points.map(q => ({ ...q }));
  s.draw.update(id, { extendRight: true });
  assert.equal(s.draw.down({ x: x(1), y: (y(180) + y(130)) / 2 }, false), true, 'the middle of the left edge');
  s.draw.move({ x: x(6), y: 200 }, false, false);
  const times = s.draw.get(id)!.points.map(q => q.t);
  assert.equal(Math.min(...times), T + 6 * H, 'the left boundary is where the pointer is, not stopped at the other point');
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.p), was.map(q => q.p), 'no price moved');
  s.draw.move({ x: x(2), y: 200 }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 2 * H, was[1]!.t], 'pulled back, the right point is where it was: nothing is kept that the pointer left');
  s.draw.up(); s.draw.undo();
  assert.deepEqual(s.draw.get(id)!.points, was);
});

test('once the left edge of a zone that runs on has carried the other point (equal times), each corner at the left boundary still moves the boundary', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(180) }, false, false); s.draw.click({ x: x(4), y: y(130) }, false, false);
  const id = s.draw.selected!;
  s.draw.update(id, { extendRight: true });
  assert.equal(s.draw.down({ x: x(1), y: (y(180) + y(130)) / 2 }, false), true, 'the middle of the left edge');
  s.draw.move({ x: x(6), y: 200 }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 6 * H, T + 6 * H], 'the two times are equal now');
  assert.equal(s.draw.down({ x: x(6), y: y(130) }, false), true, 'the lower left corner, where two handles overlap');
  s.draw.move({ x: x(7), y: y(130) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 7 * H, T + 7 * H], 'the boundary follows the corner to the right');
  s.draw.up();
  assert.equal(s.draw.down({ x: x(7), y: y(180) }, false), true, 'the upper left corner');
  s.draw.move({ x: x(8), y: y(180) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 8 * H, T + 8 * H]);
  s.draw.up();
});

test('a zone that runs on and was drawn from right to left: its left edge carries the other point, and each corner at the left boundary keeps doing so', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(4), y: y(130) }, false, false); s.draw.click({ x: x(1), y: y(180) }, false, false);
  const id = s.draw.selected!;
  s.draw.update(id, { extendRight: true });
  assert.equal(s.draw.down({ x: x(1), y: (y(180) + y(130)) / 2 }, false), true, 'the middle of the left edge, which is the second point\'s time');
  s.draw.move({ x: x(6), y: 200 }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 6 * H, T + 6 * H], 'the first point went along');
  assert.equal(s.draw.down({ x: x(6), y: y(130) }, false), true, 'the lower left corner');
  s.draw.move({ x: x(7), y: y(130) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 7 * H, T + 7 * H]);
  s.draw.up();
  assert.equal(s.draw.down({ x: x(7), y: y(180) }, false), true, 'the upper left corner');
  s.draw.move({ x: x(8), y: y(180) }, false, false);
  assert.deepEqual(s.draw.get(id)!.points.map(q => q.t), [T + 8 * H, T + 8 * H]);
  s.draw.up();
});

test('a level pressed and wobbled does not hop to a candle; once the pointer has left the spot it does, and the ring stands on the candle', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('level'); s.draw.click({ x: x(7), y: y(141) }, false, false);
  const id = s.draw.selected!;
  s.settings = { magnet: 'weak' };
  // The press is on its stroke over the candle, 1 dollar (5 px) above the candle's low: a 2 px wobble is not yet a move to a catch.
  assert.equal(s.draw.down({ x: 250, y: y(141) }, false), true);
  s.draw.move({ x: 252, y: y(141) + 1 }, false, false);
  assert.ok(Math.abs(s.draw.get(id)!.points[0]!.p - 140.8) < 1e-9, 'moved by the wobble alone, 0.2 dollars');
  assert.equal(s.draw.cursor, null);
  s.draw.move({ x: 250, y: y(141) + 4 }, false, false);
  assert.equal(s.draw.get(id)!.points[0]!.p, 140, 'on the candle\'s low once it is 4 px from the spot it pressed');
  const ringX = (): number | undefined => s.draw.cursor?.x;
  assert.equal(ringX(), 250, 'the ring on the candle');
  s.draw.move({ x: 250, y: y(141) }, false, false);
  assert.equal(s.draw.get(id)!.points[0]!.p, 140, 'back on the spot it pressed it still holds the candle: the leave is remembered');
  s.draw.up();
});

test('a locked drawing cannot be dragged, and says so: canDrag is false for it and for every drawing while the drawings are read-only', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(180) }, false, false); s.draw.click({ x: x(4), y: y(130) }, false, false);
  const id = s.draw.selected!;
  assert.equal(s.draw.canDrag(id), true);
  s.draw.update(id, { locked: true });
  assert.equal(s.draw.canDrag(id), false); assert.equal(s.draw.down({ x: x(2.5), y: y(130) }, false), false);
  s.draw.update(id, { locked: false });
  s.settings = { locked: true };
  assert.equal(s.draw.canDrag(id), false, 'Lock all');
  assert.equal(s.draw.canDrag('nope'), false);
});

test('a finger finds its handles with the wider rule: a box 40 px wide has no top middle for it, and has one for a mouse', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.arm('zone'); s.draw.click({ x: x(1), y: y(180) }, false, false); s.draw.click({ x: x(1.4), y: y(130) }, false, false);
  assert.equal(s.draw.edgeMin, 28);
  s.draw.move({ x: x(1.2), y: y(130) }, false, true);
  assert.equal(s.draw.edgeMin, 48, 'the last pointer was a finger');
  assert.equal(s.draw.down({ x: x(1.2), y: y(130) }, true), true, 'the press finds a corner or the stroke: the middle is not there');
  assert.notEqual(s.draw.dragAxis, 'p');
  s.draw.up();
  s.draw.move({ x: x(1.2), y: y(130) }, false, false);
  assert.equal(s.draw.edgeMin, 28);
  assert.equal(s.draw.down({ x: x(1.2), y: y(130) }, false), true);
  assert.equal(s.draw.dragAxis, 'p', 'the mouse has the middle of the bottom');
  s.draw.up();
});

test('a position is placed by its entry, its stop and its target; a target on the stop\'s side is refused; it saves as version 2', () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.list(); // as the page does on its first frame: the controller learns the coin (a coin change drops a half-placed drawing)
  s.draw.arm('position');
  assert.match(s.draw.hint(false)!, /entry/);
  s.draw.click({ x: x(1), y: y(150) }, false, false);
  s.draw.click({ x: x(3), y: y(140) }, false, false);
  assert.equal(s.draw.draft?.points.length, 2, 'the entry and the stop');
  assert.match(s.draw.hint(false)!, /target/);
  s.draw.click({ x: x(4), y: y(145) }, false, false);
  assert.equal(s.draw.list().length, 0, 'a target below the entry, as the stop is, is not one');
  assert.match(s.draw.message!.text, /other side/); assert.equal(s.draw.draft?.points.length, 2, 'the stop stays placed');
  s.draw.cancel(); assert.equal(s.draw.message, null, 'Esc drops the half-placed position and its warning');
  s.draw.arm('position'); s.draw.click({ x: x(1), y: y(150) }, false, false); s.draw.click({ x: x(3), y: y(140) }, false, false); s.draw.click({ x: x(4), y: y(145) }, false, false);
  s.settings = { shown: false }; s.draw.settingsChanged(); assert.equal(s.draw.message, null, 'so does switching the drawings off');
  s.settings = { shown: true }; s.draw.arm('position'); s.draw.click({ x: x(1), y: y(150) }, false, false); s.draw.click({ x: x(3), y: y(140) }, false, false); s.draw.click({ x: x(4), y: y(145) }, false, false);
  s.otherTab({ version: 1, coins: { ...s.saved!.coins, ETH: [newDrawing('level', [{ t: T, p: 1 }], T)] } }); assert.equal(s.draw.message, null, 'and another tab saving a change to its drawings');
  s.settings = { shown: true }; s.draw.arm('position');
  s.draw.click({ x: x(1), y: y(150) }, false, false); s.draw.click({ x: x(3), y: y(140) }, false, false);
  s.draw.click({ x: x(5), y: y(170) }, false, false);
  const d = s.draw.list()[0]!;
  assert.equal(d.kind, 'position'); assert.equal(s.draw.message, null, 'the warning goes with the click that is taken');
  assert.deepEqual(d.points.map(q => [(q.t - T) / H, Math.round(q.p)]), [[1, 150], [5, 140], [5, 170]], 'it ends where the target was clicked');
  assert.equal(s.saved!.version, 2, 'saved as a document older pages leave alone');
  // The stop's handle moves its price; dragged across the entry it stays where it last made a position.
  assert.equal(s.draw.down({ x: x(1), y: y(140) }, false), true);
  s.draw.move({ x: x(2), y: y(135) }, false, false); s.draw.move({ x: x(2), y: y(160) }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(d.id)!.points.map(q => Math.round(q.p)), [150, 135, 170]);
  assert.equal(s.draw.get(d.id)!.points[1]!.t, T + 5 * H, 'its time is the end\'s');
  // The end's handle on the entry line moves the stop's and the target's time together.
  assert.equal(s.draw.down({ x: x(5), y: y(150) }, false), true);
  s.draw.move({ x: x(7), y: y(150) }, false, false); s.draw.up();
  assert.deepEqual(s.draw.get(d.id)!.points.map(q => (q.t - T) / H), [1, 7, 7]);
  s.draw.flip(d.id);
  assert.deepEqual(s.draw.get(d.id)!.points.map(q => Math.round(q.p)), [150, 165, 130], 'flipped into a short');
  assert.equal(s.draw.undo(), true); assert.deepEqual(s.draw.get(d.id)!.points.map(q => Math.round(q.p)), [150, 135, 170], 'one step back');
  s.draw.remove(d.id);
  assert.equal(s.saved!.version, 1, 'without a position the document is version 1 again');
});

test('a bell going off never throws away what this tab holds when storage is full or switched off', async () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.addAlertLevel(100);
  s.failSave = true;
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(150) }, false, false);
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(160) }, false, false);
  assert.equal(s.draw.list().length, 3, 'two drawings held here that storage did not take');
  s.draw.markMoved({ market: 'm', price: 99, at: T + 9 * H, candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: T + 9 * H + 1_000, candle: null });
  s.draw.markMoved({ market: 'm', price: 101, at: T + 9 * H + 2_000, candle: null });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.draw.list().length, 3, 'still all three: the bell going off did not read the older copy back over them');
  assert.equal(s.draw.list().find(d => d.points[0]!.p === 100)!.alert, false, 'and the bell is off');
});

test('after a file was read in here, another tab\'s bell change still keeps this tab\'s steps', () => {
  const s = setup({ settings: { magnet: 'off' } });
  const file = JSON.stringify({ format: 'liquiditymapperfast-drawings', version: 1, coins: { BTC: [newDrawing('zone', [{ t: T, p: 120 }, { t: T + H, p: 130 }], T - 5 * H)] } });
  s.draw.importText(file);
  s.draw.addAlertLevel(150);
  const id = s.draw.selected!;
  const there = JSON.parse(JSON.stringify(s.saved)) as DrawDoc;
  there.coins.BTC = [...there.coins.BTC!].sort((a, b) => a.created - b.created).map(d => d.id === id ? { ...d, alert: false } : d);
  s.otherTab(there);
  assert.equal(s.draw.get(id)!.alert, false);
  assert.equal(s.draw.canUndo, true, 'the order a document is read back in is no change of drawings');
});

test('a bell the person changed while its message was on its way is left as they left it', async () => {
  let settle: (ok: boolean) => void = () => {};
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.addAlertLevel(100);
  const id = s.draw.selected!;
  s.alertAnswer = () => new Promise<boolean>(r => { settle = r; });
  s.draw.markMoved({ market: 'm', price: 99, at: T + 9 * H, candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: T + 9 * H + 1_000, candle: null });
  s.draw.markMoved({ market: 'm', price: 101, at: T + 9 * H + 2_000, candle: null });
  s.draw.setBell('BTC', id, { alertOnce: false });
  settle(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.draw.get(id)!.alert, true, 'set to go off every time meanwhile: it stays on');
});

test('a bell that reached them goes off though its label changed meanwhile; one switched off and on again meanwhile stays on', async () => {
  let settle: (ok: boolean) => void = () => {};
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.addAlertLevel(100);
  const id = s.draw.selected!;
  s.alertAnswer = () => new Promise<boolean>(r => { settle = r; });
  const at = (k: number) => T + 9 * H + k * 1_000;
  s.draw.markMoved({ market: 'm', price: 99, at: at(0), candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: at(1), candle: null });
  s.draw.markMoved({ market: 'm', price: 101, at: at(2), candle: null });
  s.draw.update(id, { text: 'Weekly high' });
  settle(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.draw.get(id)!.alert, false, 'a new label is no new choice about the bell');
  s.draw.update(id, { alert: true, alertOnce: true });
  s.draw.markMoved({ market: 'm', price: 101, at: at(3), candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: at(4), candle: null });
  s.draw.update(id, { alert: false }); s.draw.update(id, { alert: true });
  settle(true); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.draw.get(id)!.alert, true, 'switched off and on again while it was on its way: their new choice stands');
});

test('a bell switched on in another tab, not yet read here, survives a bell going off here', async () => {
  const s = setup({ settings: { magnet: 'off' } });
  s.draw.addAlertLevel(100);
  const fired = s.draw.selected!;
  s.draw.arm('level'); s.draw.click({ x: 500, y: y(150) }, false, false);
  const other = s.draw.selected!;
  const there = JSON.parse(JSON.stringify(s.saved)) as DrawDoc;
  there.coins.BTC = there.coins.BTC!.map(d => d.id === other ? { ...d, alert: true, alertOnce: true } : d);
  s.stored = there;
  const at = (k: number) => T + 9 * H + k * 1_000;
  s.draw.markMoved({ market: 'm', price: 99, at: at(0), candle: null }); s.draw.markMoved({ market: 'm', price: 99, at: at(1), candle: null });
  s.draw.markMoved({ market: 'm', price: 101, at: at(2), candle: null });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(s.draw.get(fired)!.alert, false, 'the bell that went off is off');
  assert.equal(s.saved!.coins.BTC!.find(d => d.id === other)!.alert, true, 'the other tab\'s bell is kept, not written over');
});
