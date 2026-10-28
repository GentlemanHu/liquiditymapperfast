import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHORS, DRAW_FILE_FORMAT, MAX_PER_COIN, MAX_TEXT, MAX_UNDO, capReached, duplicate, exportText, importInto, moved, newDrawing, newId, readDoc, readDrawing, totalOf, type DrawDoc } from '../src/app/draw/model.ts';
import { History } from '../src/app/draw/history.ts';

const T = Date.UTC(2026, 9, 28, 12);
const at = (k: number, p: number): { t: number; p: number } => ({ t: T + k * 3_600_000, p });

test('a new drawing has exactly its kind\'s points and its kind\'s look; ids are never shared', () => {
  const level = newDrawing('level', [at(0, 81_500), at(1, 1)], T);
  assert.equal(level.points.length, 1, 'a level is one point');
  assert.deepEqual([level.extendLeft, level.extendRight, level.style.color], [true, true, 'blue'], 'across the map, in blue');
  const trend = newDrawing('trend', [at(0, 80_000), at(2, 81_000)], T);
  assert.deepEqual([trend.extendLeft, trend.extendRight], [false, false], 'a segment until set to run on');
  assert.equal(newDrawing('channel', [at(0, 1), at(1, 2), at(2, 3)], T).points.length, ANCHORS.channel);
  const ids = new Set(Array.from({ length: 2000 }, () => newId(T)));
  assert.equal(ids.size, 2000, 'two thousand ids made in one millisecond are all different');
});

test('a saved drawing is read field by field: wrong points drop it, a wrong look falls back to the kind\'s', () => {
  const good = newDrawing('zone', [at(0, 80_000), at(3, 81_000)], T);
  assert.deepEqual(readDrawing(JSON.parse(JSON.stringify(good))), good, 'read back as it was written');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000)] }), null, 'a zone needs two corners');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: T, p: -5 }] }), null, 'a price at or below zero');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: Number.NaN, p: 1 }] }), null, 'a time that is not one');
  assert.equal(readDrawing({ ...good, points: [at(0, 80_000), { t: Date.UTC(1999, 0, 1), p: 1 }] }), null, 'a time before any market');
  assert.equal(readDrawing({ ...good, kind: 'pitchfork' }), null, 'a kind this page does not draw');
  assert.equal(readDrawing({ ...good, id: '<script>' }), null, 'an id not of its own form');
  const odd = readDrawing({ ...good, style: { color: 'chartreuse', width: 7, dashed: 'yes' }, text: 'x'.repeat(MAX_TEXT + 50), alert: true })!;
  assert.deepEqual(odd.style, { color: 'blue', width: 2, dashed: false }, 'the zone\'s own look');
  assert.equal(odd.text.length, MAX_TEXT, 'a long text is cut');
  assert.equal(odd.alert, false, 'only a level sounds');
  assert.equal(readDrawing({ ...newDrawing('level', [at(0, 1)], T), alert: true })!.alert, true);
});

test('a document keeps each coin\'s valid drawings once, at most a coin\'s cap, and a newer document is not read at all', () => {
  const a = newDrawing('level', [at(0, 1)], T), b = newDrawing('vline', [at(1, 1)], T + 1);
  const doc = readDoc({ version: 1, coins: { BTC: [b, a, a, { junk: true }], 'bad coin!': [a], ETH: 'no' } })!;
  assert.deepEqual(doc.coins.BTC!.map(d => d.id), [a.id, b.id], 'oldest first, each once, junk dropped');
  assert.deepEqual(Object.keys(doc.coins), ['BTC']);
  assert.equal(readDoc({ version: 2, coins: {} }), null, 'a newer page wrote it: left alone');
  assert.deepEqual(readDoc(null), { version: 1, coins: {} });
  const many = Array.from({ length: MAX_PER_COIN + 5 }, (_, i) => newDrawing('level', [at(i, 1)], T + i));
  assert.equal(readDoc({ version: 1, coins: { BTC: many } })!.coins.BTC!.length, MAX_PER_COIN, 'the newest kept');
  assert.equal(capReached({ version: 1, coins: { BTC: many.slice(0, MAX_PER_COIN) } }, 'BTC'), 'coin');
  assert.equal(capReached({ version: 1, coins: { BTC: many.slice(0, 3) } }, 'BTC'), null);
});

test('a file is read into what is held: after it, new ids where ids are taken, nothing past the caps, nothing from another format', () => {
  const held = newDrawing('level', [at(0, 81_000)], T), doc: DrawDoc = { version: 1, coins: { BTC: [held] } };
  const file = exportText({ version: 1, coins: { BTC: [held, newDrawing('trend', [at(0, 1), at(1, 2)], T + 5)], ETH: [newDrawing('zone', [at(0, 1), at(1, 2)], T)] } });
  const read = importInto(doc, file, T + 10);
  assert.equal(read.error, null); assert.equal(read.added, 3); assert.equal(read.skipped, 0);
  assert.equal(read.doc.coins.BTC!.length, 3);
  assert.equal(new Set(read.doc.coins.BTC!.map(d => d.id)).size, 3, 'the copy of the held drawing got an id of its own');
  assert.equal(doc.coins.BTC!.length, 1, 'what was held is not changed');
  assert.equal(totalOf(read.doc), 4);
  assert.equal(importInto(doc, JSON.stringify({ format: 'something-else', coins: {} })).error, 'format');
  assert.equal(importInto(doc, '{not json').error, 'format');
  assert.equal(importInto(doc, JSON.stringify({ format: DRAW_FILE_FORMAT, version: 9, coins: {} })).error, 'version');
  const full: DrawDoc = { version: 1, coins: { BTC: Array.from({ length: MAX_PER_COIN }, (_, i) => newDrawing('level', [at(i, 1)], T + i)) } };
  const over = importInto(full, file, T);
  assert.deepEqual([over.added, over.skipped], [1, 2], 'only ETH had room');
});

test('moving and copying keep the shape; Undo goes back a step at a time and a new change ends what Redo held', () => {
  const d = newDrawing('trend', [at(0, 100), at(2, 110)], T);
  const m = moved(d, 60_000, 5);
  assert.deepEqual(m.points.map(q => [q.t - d.points[0]!.t, q.p]), [[60_000, 105], [2 * 3_600_000 + 60_000, 115]]);
  const c = duplicate(d, 1, 1, T + 1);
  assert.notEqual(c.id, d.id); assert.equal(c.alert, false);
  const h = new History(), s0: never[] = [], s1 = [d], s2 = [d, c];
  h.push(s0, s1); h.push(s1, s2);
  assert.deepEqual(h.undo(), s1); assert.deepEqual(h.undo(), s0); assert.equal(h.undo(), null);
  assert.deepEqual(h.redo(), s1);
  h.push(s1, [m]);
  assert.equal(h.canRedo, false, 'a new change ends what Redo held');
  for (let i = 0; i < MAX_UNDO + 20; i++) h.push([], [d]);
  let n = 0; while (h.undo()) n++;
  assert.equal(n, MAX_UNDO, 'at most a hundred steps back');
});
