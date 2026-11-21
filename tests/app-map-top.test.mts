import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PALETTES, chromeFor, contrastRatio } from '../src/app/theme.ts';
import { HEAD_INSET, HEAD_PITCH, bodyFont, firstLine, headBand, liqHeading, nameFont, roleFont, roleInk, rowNameTop, toolsH } from '../src/app/map-top.ts';

test('the map\'s top strip is one grid: the tools\' row, then every column\'s first line (Karl, 2026-11-21)', () => {
  // A map button is 26 px from 8 px down; the Bevel frame's are 23 px (styles.css), so its first line is 3 px higher.
  assert.equal(toolsH(undefined), 26); assert.equal(toolsH('editor'), 26); assert.equal(toolsH('bevel'), 23);
  assert.equal(firstLine(undefined), 38, '4 px under the tools\' row'); assert.equal(firstLine('bevel'), 35);
  // A name on the tools' row reads level with the buttons' labels: 10 px words centred on the button's middle.
  assert.equal(rowNameTop(undefined), 15); assert.equal(rowNameTop('bevel'), 14);
  for (const frame of [undefined, 'bevel']) {
    const middle = 8 + toolsH(frame) / 2, words = rowNameTop(frame) + 5;
    assert.ok(Math.abs(words - middle) <= 1, `level with the buttons (${frame ?? 'editor'}): ${words} against ${middle}`);
  }
  // Two lines of figures (the profile column, a measure's column without its difference) and the gap after them.
  assert.equal(headBand(undefined, 2), 38 + 2 * HEAD_PITCH + 4); assert.equal(headBand(undefined, 3), 78); assert.equal(headBand('bevel', 2), 63);
  assert.equal(HEAD_INSET, 7, 'every column\'s words, and its button, stand 7 px in');
});

test('the liquidation column\'s heading: its lines, then History, a map button, inside the band', () => {
  // Unsplit: LEVEL MAX and CUM MAX, History under them; the band covers History and its 3 px shadow.
  assert.deepEqual(liqHeading(undefined, 2, true), { first: 38, historyTop: 66, band: 66 + 26 + 3 + 4 });
  // A split on one scale: its figures, the words across, History.
  assert.deepEqual(liqHeading(undefined, 3, true), { first: 38, historyTop: 78, band: 111 });
  // Without History (loading, or the Depth pane already shows the history) the band ends with the lines, as every other column's does.
  assert.deepEqual(liqHeading(undefined, 2, false), { first: 38, historyTop: 66, band: 66 });
  assert.equal(liqHeading(undefined, 2, false).band, headBand(undefined, 2), 'the same band as the profile column\'s');
  // Bevel: 23 px buttons, no shadow drawn but the same room kept.
  assert.deepEqual(liqHeading('bevel', 2, true), { first: 35, historyTop: 63, band: 63 + 23 + 3 + 4 });
});

test('three roles, one look each: a name is bold in the text colour, a figure or note is muted, a warning in the theme\'s caution words', () => {
  const ink = { text: '#111111', muted: '#777777', caution: '#8a6400' };
  assert.equal(roleFont('name'), nameFont()); assert.equal(roleFont('note'), bodyFont()); assert.equal(roleFont('warn', 9.5), bodyFont(9.5));
  assert.match(nameFont(), /^600 10px /); assert.match(bodyFont(), /^10px /);
  assert.equal(roleInk('name', ink), ink.text); assert.equal(roleInk('note', ink), ink.muted); assert.equal(roleInk('warn', ink), ink.caution);
  // The caution words colour reads on every theme's panel (the raw amber #e6a700 is 2:1 on white).
  for (const [name, p] of Object.entries(PALETTES)) assert.ok(contrastRatio(chromeFor(p).caution, p.panel) >= 4.5, `${name}: a warning reads on the panel`);
});

test('every column\'s heading draws on the grid: its name on the tools\' row, its figures from the first line', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  // The profile column and a measure's column name themselves on the tools' row in the name's look.
  assert.match(heat, /ctx\.fillText\(fit\(t\('Profile'\)\), x0 \+ HEAD_INSET, rowNameTop\(look\)\)/);
  assert.match(heat, /measure\(def\.name\(\)\) <= headRoom \? def\.name\(\) : fitText\(measure, def\.short\(\), headRoom\), x0 \+ HEAD_INSET, rowNameTop\(look\)\)/);
  // Their figures, and the liquidation column's, start on the first line; the split's sub-columns too, then the words across, then the notes.
  assert.match(heat, /fit\(t\('LEVEL MAX \{value\}', \{ value: usd\(maxLevel\) \}\)\), x0 \+ HEAD_INSET, first\)/);
  assert.match(heat, /ctx\.fillText\(head, x0 \+ HEAD_INSET, first\);/);
  assert.match(heat, /t\('LEVEL MAX \{value\}', \{ value: usd\(maxLevel\) \}\), liqRoom\(W\)\), x0 \+ HEAD_INSET, heading\.first\)/);
  assert.match(heat, /h\.scale\.forEach\(\(line, n\) => ctx\.fillText\(line, sub\.x0 \+ HEAD_INSET, top \+ HEAD_PITCH \* n\)\)/);
  // The split's button names both sub-columns, each over its own (no caption rows on the canvas).
  assert.match(heat, /splitHeads\(wide, \{ captions: null,/);
  assert.match(heat, /button\.classList\.add\('split-names'\)/);
  // A name with no room on the split's button gives way to its half of the split's short name, as the button said before.
  assert.match(heat, /const \[shortA, shortB\] = splitName\(pair\.split\)\.split\('\|'\)\.map\(half => half\.trim\(\)\);/);
  // A compact map's profile column (84 px, no corner tools' row above it) keeps its two figure lines at the top.
  assert.match(heat, /if \(!strip && COMPACT\) \{[\s\S]{0,800}?x0 \+ 4, 4\); ctx\.fillText\(t\('CUM MAX \{value\}', \{ value: usd\(maxCum\) \}\), x0 \+ 4, 16\);/);
  // The heading lines' warning ink is the theme's caution words colour, worked out once a palette.
  assert.match(heat, /caution: chromeFor\(p\)\.caution/);
  // The stripe's captions are labels, not buttons: a plate without an edge.
  assert.doesNotMatch(heat, /ctx\.strokeRect\(x \+ 0\.5, y \+ 0\.5, w - 1, 14\)/);
  // No leftovers of the old constants.
  assert.doesNotMatch(heat, /\bLIQ_(PAD|KIND_TOP|KIND_H|HEAD_H|LINK_H)\b/);
});

test('History is a map button like the levels button and the corner tools, with a drawn glyph', () => {
  const css = fs.readFileSync('src/app/styles.css', 'utf8'), chrome = fs.readFileSync('src/app/chrome.css', 'utf8');
  const rule = css.match(/\.pane\.heat \.liq-history \{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /height: 26px/); assert.match(rule, /box-shadow: 3px 3px 0 var\(--shadow\)/); assert.match(rule, /font-size: 11px/);
  assert.match(css, /\.pane\.heat \.liq-history::before \{[^}]*mask:/, 'a drawn glyph, not a typed one');
  assert.match(css, /:root\[data-frame="bevel"\] \.pane\.heat \.liq-history \{ height: 23px; box-shadow: none; \}/);
  assert.match(chrome, /\.pane\.heat :is\([^)]*\.liq-kind, \.liq-history\) \{ border-radius: var\(--radius\); background: var\(--face\)/);
});
