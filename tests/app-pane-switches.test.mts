import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PANE_SHOW_KEY, STRIP_PANES } from '../src/app/layouts/dock-model.ts';

/**
 * The panes under the map show only while their switch is on. The page hid them from a list written out by hand, and the Funding pane,
 * missing from it, showed for everyone whatever its switch said (2026-11-07). Now every pane of the strip is hidden by its switch.
 */
test('every pane under the map follows its switch, the Funding pane included', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  const block = main.slice(main.indexOf('const strip: LayoutPane[] = ['), main.indexOf('const arrange = new Layout('));
  const ids = [...block.matchAll(/\{ id: '([a-z]+)', root: /g)].map(m => m[1]!);
  assert.deepEqual(ids, ['heat', ...STRIP_PANES.map(p => p.id)], 'the page\'s strip is the layouts\' strip, in its order');
  for (const id of ids) if (id !== 'heat') assert.ok(id in PANE_SHOW_KEY, `${id} has a switch`);
  assert.match(main, /for \(const p of strip\) \{ const key = PANE_SHOW_KEY\[p\.id\]; if \(key && p\.id !== 'script'\) p\.root\.hidden = !s\.show\[key\]; \}/, 'each is hidden by it');
  assert.doesNotMatch(main, /depth\.root\.hidden = !s\.show\.depth/, 'no list written out by hand');
});

/**
 * A pane with a switch has a button in the Panels deck, which a phone's or tablet's Settings also lists. Flow history had none until
 * 2026-11-21: only its rows in the flow column's and the Bar stats' settings switched it on, and Karl found it hard to discover. Scripts is the
 * one without: a script switched on in the Chart deck shows its pane.
 */
test('every pane under the map has its button in the Panels deck, Scripts aside, and a phone lists Flow history once', () => {
  const toolbar = fs.readFileSync('src/app/toolbar.ts', 'utf8');
  const line = toolbar.split('\n').find(l => l.startsWith('const PANE_TOGGLES'));
  assert.ok(line, 'PANE_TOGGLES is one line of toolbar.ts');
  const buttons = new Set([...line.matchAll(/\['(\w+)', /g)].map(m => m[1]!));
  for (const p of STRIP_PANES) {
    const key = PANE_SHOW_KEY[p.id];
    assert.ok(key, `${p.id} has a switch`);
    if (p.id === 'script') assert.ok(!buttons.has(key), 'Scripts has no Panels button');
    else assert.ok(buttons.has(key), `${p.id} has a Panels button`);
  }
  // The phone's Settings shows the deck's own buttons and no second Flow history switch beside them: not the phone's own button it had
  // before (sizesToggle), not the flow column's and Bar stats' switch rows (size-history/switch.ts), and the toolbar names Flow history once.
  assert.match(toolbar, /section\(t\('Panels'\), \[this\.#toggles, el\('p', /);
  assert.doesNotMatch(toolbar, /sizesToggle/);
  assert.doesNotMatch(toolbar, /size-history\/switch|flowHistoryRows/, "the flow column's switch rows stay in their panels");
  assert.equal(toolbar.match(/t\('Flow history'\)/g)?.length, 1, "the toolbar names Flow history once: its button in PANE_TOGGLES");
  // Switched on in a phone's Settings it closes them, the page having opened the Map tab under which the pane stands (main.ts).
  assert.match(toolbar, /if \(key === 'sizes' && on && isPhone\(\)\) this\.#sheet\?\.close\(\);/);
  assert.match(fs.readFileSync('src/app/main.ts', 'utf8'), /if \(sizesOn && isPhone\(\)\) dock\.show\('map'\);/);
});

test('a theme previewed by hover repaints every pane, the Funding and Flow history panes included', () => {
  const main = fs.readFileSync('src/app/main.ts', 'utf8');
  assert.match(main, /const themed = \[heat, ladder, depth, oi, delta, ls, funding, lt, bars, sizes, script, cvd, candle, liq\];/);
  assert.equal(main.match(/for \(const p of themed\) p\.setPalette\(/g)?.length, 3, 'the preview, a picked theme and the first paint');
});
