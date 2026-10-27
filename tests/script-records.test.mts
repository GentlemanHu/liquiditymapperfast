import test from 'node:test';
import assert from 'node:assert/strict';
import { FILE_FORMAT, MAX_SCRIPTS, MAX_SOURCE_CHARS, ROW_DEFAULT, ROW_MAX, SCRIPT_API, cleanName, exportFile, importText, loadScripts, mergeScripts, newId, readOptions, readScript, readScripts, storeScripts, type ScriptRecord } from '../src/app/script/records.ts';

const script = (id: string, patch: Partial<ScriptRecord> = {}): ScriptRecord => ({ id, name: id, source: 'line(cum(vbuy - vsell))', options: {}, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: 'pane', ...patch });

test('a script read back keeps what it was and drops what it cannot be', () => {
  assert.deepEqual(readScript(script('cvd-aaaaaa')), script('cvd-aaaaaa'));
  assert.equal(readScript({ name: '   ', source: 'x' }), null, 'no name');
  assert.equal(readScript({ name: 'a', source: 5 }), null, 'no text');
  assert.equal(readScript({ name: 'a', source: 'x'.repeat(MAX_SOURCE_CHARS + 1) }), null, 'too long');
  const made = readScript({ name: 'My  CVD', source: 'a\r\nb\rc', height: 9_999, api: 99, on: 0 })!;
  assert.match(made.id, /^my-cvd-[a-z0-9]{6}$/);
  assert.equal(made.source, 'a\nb\nc', 'line ends kept as newlines');
  assert.equal(made.height, ROW_MAX);
  assert.equal(made.api, 99, 'a script keeps the version it was written for, a newer one too (the pane then does not run it)');
  assert.deepEqual(importText(JSON.stringify({ format: FILE_FORMAT, version: 999, scripts: [script('a-000001')] }), 'x'), { error: 'newer' }, 'a file of a later version is refused, not read as this one');
  assert.deepEqual(loadScripts(null), []);
  assert.equal(made.on, true, 'only false switches a script off');
  assert.equal(made.place, 'pane');
  assert.equal(readScript({ name: 'a', source: 'x', place: 'map' })!.place, 'map');
  assert.equal(cleanName(`  ${'x'.repeat(60)} `)!.length, 40);
});

test('options keep plain values a few levels deep and nothing that could reach an object\'s machinery', () => {
  const raw = JSON.parse('{"length": 14, "color": "rgb(1,2,3)", "on": true, "nan": null, "scaleMargins": {"top": 0.1, "bottom": 0.2}, "bad key": 1, "__proto__": {"x": 1}, "deep": {"a": {"b": {"c": {"d": 1}}}}, "f": "' + 'x'.repeat(3_000) + '"}');
  const o = readOptions(raw);
  assert.deepEqual(Object.keys(o).sort(), ['color', 'deep', 'length', 'nan', 'on', 'scaleMargins']);
  assert.deepEqual(o.scaleMargins, { top: 0.1, bottom: 0.2 });
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.deepEqual(o.deep, { a: { b: {} } }, 'cut three levels down');
});

test('a list keeps one script per id, the later one, and at most the maximum', () => {
  const list = readScripts([script('a-000001'), script('b-000001'), script('a-000001', { name: 'again' }), 'junk', null]);
  assert.deepEqual(list.map(s => `${s.id}:${s.name}`), ['b-000001:b-000001', 'a-000001:again']);
  const many = readScripts(Array.from({ length: MAX_SCRIPTS + 5 }, (_, i) => script(`s-${String(i).padStart(6, '0')}`)));
  assert.equal(many.length, MAX_SCRIPTS);
  assert.equal(readScripts({}).length, 0);
});

test('Export writes a file Import reads back as it was', () => {
  const list = [script('a-000001', { options: { length: 20 } }), script('b-000001', { on: false })];
  const text = exportFile(list);
  assert.equal(JSON.parse(text).format, FILE_FORMAT);
  assert.deepEqual(importText(text, 'x'), { scripts: list });
});

test('an indicator file, a workspace and a plain text are each read as scripts', () => {
  const one = importText(JSON.stringify({ name: 'OBV', script: 'plotline(cum(vbuy))', options: { color: 'red' } }), 'x');
  assert.ok('scripts' in one && one.scripts.length === 1 && one.scripts[0]!.name === 'OBV' && one.scripts[0]!.options.color === 'red');
  const wrapped = importText(JSON.stringify({ type: 'indicator', name: 'Wrapped', data: { script: 'line(1)' } }), 'x');
  assert.ok('scripts' in wrapped && wrapped.scripts[0]!.name === 'Wrapped');
  const workspace = { name: 'w', states: { chart: { indicators: { price: { id: 'price', name: 'Price', script: 'plotcandlestick(avg_ohlc(bar))' }, cvd: { id: 'cvd', displayName: 'CVD', name: 'cvd', script: 'line(cum(vbuy - vsell))' }, vwap: { id: 'vwap', name: 'VWAP', script: 'line(1)', options: { priceScaleId: 'right' } } } }, trades: {} } };
  const read = importText(JSON.stringify(workspace), 'x');
  assert.ok('scripts' in read);
  assert.deepEqual(read.scripts.map(s => `${s.name}:${s.place}`), ['CVD:pane', 'VWAP:map'], 'the price candles are the map\'s own; an indicator on the price scale goes on the map');
  const plain = importText('line(cum(vbuy - vsell))\n', 'Pasted');
  assert.ok('scripts' in plain && plain.scripts[0]!.name === 'Pasted' && plain.scripts[0]!.source === 'line(cum(vbuy - vsell))\n');
  assert.deepEqual(importText('  \n ', 'x'), { error: 'empty' });
  assert.deepEqual(importText('{"states": {}}', 'x'), { error: 'empty' });
  assert.ok('scripts' in importText('{ not json but a block\n}', 'Block'), 'a text that starts with a brace but is no JSON is a script');
});

test('merging replaces an id in its place and counts what did not fit', () => {
  const full = Array.from({ length: MAX_SCRIPTS }, (_, i) => script(`s-${String(i).padStart(6, '0')}`));
  const merged = mergeScripts(full, [script('s-000003', { name: 'new three' }), script('extra-000001')]);
  assert.equal(merged.list[3]!.name, 'new three');
  assert.deepEqual([merged.added, merged.replaced, merged.skipped], [0, 1, 1]);
});

test('scripts are kept in storage and read back; a refusing storage says so', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
  assert.ok(storeScripts([script('a-000001')], storage));
  assert.deepEqual(loadScripts(storage), [script('a-000001')]);
  assert.equal(storeScripts([script('a-000001')], { setItem: () => { throw new Error('full'); } }), false);
  assert.deepEqual(loadScripts({ getItem: () => '{broken' }), []);
  assert.match(newId('Ünïcode name!', () => 0.5), /^unicode-name-[a-z0-9]{6}$/);
});
