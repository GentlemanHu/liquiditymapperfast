import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PALETTES, cautionInk, chromeFor, contrastRatio } from '../src/app/theme.ts';
import { HEAD_INSET, HEAD_PITCH, PLATE_H, bodyFont, firstLine, headBand, liqHeading, nameFont, plateTop, roleFont, roleInk, rowNameSize, rowNameTop, splitNames, toolsH, toolsRight } from '../src/app/map-top.ts';

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
  for (const [name, p] of Object.entries(PALETTES)) {
    assert.equal(cautionInk(p), chromeFor(p).caution, `${name}: the caution words colour`);
    assert.ok(contrastRatio(cautionInk(p), p.panel) >= 4.5, `${name}: a warning reads on the panel`);
  }
});

test('the split\'s names on the levels button: each as far into its own sub-column as the first into the left one, the divider on the column\'s', () => {
  // A 200 px split column: the button 189 px wide from the column's inset, a 1 px border, 9 px of padding before the words, 22 after (the arrow).
  const plan = splitNames({ subX: 100, room: 189, border: 1, pad: 9, arrow: 22 });
  assert.deepEqual(plan, { firstMax: 79, divider: 92, secondLeft: 109, secondMax: 56 });
  // In the column's own pixels: the button starts at the inset and its padding box a border further.
  const box = HEAD_INSET + 1;
  assert.equal(box + plan.divider, 100, 'the divider through the button continues the column\'s');
  const firstInto = box + 9;
  assert.equal(box + plan.secondLeft - 100, firstInto, 'the second name stands as far into the right sub-column as the first into the left one');
  assert.ok(9 + plan.firstMax < plan.divider, 'the first name never reaches the divider');
  assert.equal(plan.secondLeft + plan.secondMax, 189 - 2 - 22, 'the second never reaches the arrow');
  // A thicker border moves both names and the divider by as much; a button with no room for a second name gives it no width, never less.
  const thick = splitNames({ subX: 100, room: 189, border: 2, pad: 9, arrow: 22 });
  assert.equal(HEAD_INSET + 2 + thick.divider, 100); assert.equal(HEAD_INSET + 2 + thick.secondLeft - 100, HEAD_INSET + 2 + 9);
  assert.equal(splitNames({ subX: 100, room: 120, border: 2, pad: 9, arrow: 22 }).secondMax, 0);
});

test('every column\'s heading draws on the grid: its name on the tools\' row, its figures from the first line', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  // The profile column and a measure's column name themselves on the tools' row in the name's look.
  // A column's name a step above the buttons' labels (rowNameSize), level with them.
  assert.match(heat, /ctx\.fillText\(fit\(t\('Profile'\)\), x0 \+ HEAD_INSET, rowNameTop\(look, nameSize\)\)/);
  assert.match(heat, /measure\(def\.name\(\)\) <= headRoom \? def\.name\(\) : fitText\(measure, def\.short\(\), headRoom\), x0 \+ HEAD_INSET, rowNameTop\(look, nameSize\)\)/);
  assert.equal(heat.match(/const nameSize = rowNameSize\(pw < NARROW_PLOT\);/g)?.length, 2);
  // Their figures, and the liquidation column's, start on the first line; the split's sub-columns too, then the words across, then the notes.
  assert.match(heat, /fit\(t\('LEVEL MAX \{value\}', \{ value: figure\(levelSaid\) \}\)\), x0 \+ HEAD_INSET, first\)/);
  assert.match(heat, /ctx\.fillText\(head, x0 \+ HEAD_INSET, firstY\);/);
  assert.match(heat, /t\('LEVEL MAX \{value\}', \{ value: figure\(levelSaid\) \}\), liqRoom\(W\)\), x0 \+ HEAD_INSET, heading\.first\)/);
  assert.match(heat, /h\.scale\.forEach\(\(line, n\) => ctx\.fillText\(line, sub\.x0 \+ HEAD_INSET, top \+ HEAD_PITCH \* n\)\)/);
  // The split's button names both sub-columns, each over its own (no caption rows on the canvas).
  assert.match(heat, /splitHeads\(wide, \{ maxima:/);
  // History stands where the heading puts it, and the band covers it (the boxes and the readout keep below the band).
  assert.match(heat, /this\.#liqHeadH = heading\.band;/);
  assert.match(heat, /top = `\$\{heading\.historyTop\}px`/);
  // The split's look is taken off the button wherever it is not drawn split (too narrow, unsplit, locked).
  assert.equal(heat.match(/button\.classList\.remove\('split-names'\); button\.style\.width = '';/g)?.length, 2);
  // The names placed by the pure plan, from the button's own border and paddings.
  assert.match(heat, /plan = splitNames\(\{ subX: subColumns\(0, W\)\[1\]\.x0, room, border: button\.clientLeft,/);
  assert.match(heat, /first\.style\.maxWidth = `\$\{plan\.firstMax\}px`; line\.style\.left = `\$\{plan\.divider\}px`;/);
  assert.match(heat, /second\.style\.left = `\$\{plan\.secondLeft\}px`; second\.style\.maxWidth = `\$\{plan\.secondMax\}px`;/);
  // The short halves take over only where a whole name overflows, each over its own sub-column (the left half over the left one).
  assert.match(heat, /if \(first\.scrollWidth > first\.clientWidth \|\| second\.scrollWidth > second\.clientWidth\) \{/);
  assert.match(heat, /if \(shortA && shortB\) \{ first\.textContent = shortA; second\.textContent = shortB; \}/);
  // No crosshair over a measure column's heading, where a press now pans.
  assert.match(heat, /overColumn = hit !== null && y >= \(this\.#columnHeads\.get\(/);
  // A press on a measure column's heading selects nothing: only a press under its band starts a selection.
  assert.match(heat, /this\.#columnHeads\.set\(`\$\{side\}\|\$\{i\}`, headH\);/);
  assert.match(heat, /column && y >= head && y <= this\.plotH/);
  assert.match(heat, /button\.classList\.add\('split-names'\)/);
  // A name with no room on the split's button gives way to its half of the split's short name, as the button said before.
  assert.match(heat, /const \[shortA, shortB\] = splitName\(pair\.split\)\.split\('\|'\)\.map\(half => half\.trim\(\)\);/);
  // A compact map's profile column (84 px, no corner tools' row above it) keeps its two figure lines at the top.
  assert.match(heat, /if \(!strip && COMPACT\) \{[\s\S]{0,800}?x0 \+ 4, 4\); ctx\.fillText\(t\('CUM MAX \{value\}', \{ value: figure\(cumSaid\) \}\), x0 \+ 4, 16\);/);
  // The heading lines' warning ink is the theme's caution words colour, worked out once a palette.
  assert.match(heat, /caution: cautionInk\(p\)/);
  // A measure column's cut record says it in the same caution words colour, as the band's header does (measures/paint.ts).
  assert.match(heat, /ctx\.fillStyle = cautionInk\(p\); else if \(loaded\) ctx\.fillStyle = p\.poc;/);
  assert.match(fs.readFileSync('src/app/measures/paint.ts', 'utf8'), /if \(d\.warn\) ctx\.fillStyle = cautionInk\(p\);/);
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

test("names on the tools' row are a step above the buttons' 11 px labels, level with them, and a lane's plate centred on them (Karl, 2026-11-24)", () => {
  assert.equal(rowNameSize(false), 12); assert.equal(rowNameSize(true), 11);
  for (const frame of [undefined, 'bevel']) {
    for (const size of [11, 12]) {
      const middle = 8 + toolsH(frame) / 2, words = rowNameTop(frame, size) + size / 2;
      assert.ok(Math.abs(words - middle) <= 1, `${size} px words level with the buttons (${frame ?? 'editor'}): ${words} against ${middle}`);
    }
    const plate = plateTop(frame) + PLATE_H / 2, middle = 8 + toolsH(frame) / 2;
    assert.ok(Math.abs(plate - middle) <= 1, `the plate centred on the buttons (${frame ?? 'editor'})`);
  }
});

test('the corner tools end left of the liquidation lanes and their titles, else in the corner, with slack at the switch (Karl, 2026-11-24)', () => {
  // Karl's 8787 map: a 1,561 px plot, the stripe from 1,436, a 430 px row (about 190 as drawings alone).
  assert.deepEqual(toolsRight({ pw: 1561, edge: 1436, width: 190, minLeft: 160, anchored: false }), { right: 1428, anchored: true });
  // No stripe (levels off, another coin, a replay, the live edge off the map): the corner, 8 px in.
  assert.deepEqual(toolsRight({ pw: 1561, edge: null, width: 190, minLeft: 160, anchored: true }), { right: 1553, anchored: false });
  // A stripe reaching the plot's right edge (nothing to keep clear of): the corner.
  assert.deepEqual(toolsRight({ pw: 1561, edge: 1600, width: 190, minLeft: 160, anchored: false }), { right: 1553, anchored: false });
  // The live edge so far left that the row would leave the legend under 160 px: the corner, as before.
  assert.equal(toolsRight({ pw: 1561, edge: 300, width: 190, minLeft: 160, anchored: false }).anchored, false);
  // At the switch: 16 px of slack each way, so a width at the edge does not flip back and forth.
  const at = 8 + 190 + 160; // the edge where the row just leaves the legend its room
  assert.equal(toolsRight({ pw: 1561, edge: at + 10, width: 190, minLeft: 160, anchored: false }).anchored, false, 'not yet: 16 px more first');
  assert.equal(toolsRight({ pw: 1561, edge: at + 17, width: 190, minLeft: 160, anchored: false }).anchored, true);
  assert.equal(toolsRight({ pw: 1561, edge: at - 10, width: 190, minLeft: 160, anchored: true }).anchored, true, 'kept until 16 px past');
  assert.equal(toolsRight({ pw: 1561, edge: at - 17, width: 190, minLeft: 160, anchored: true }).anchored, false);
});

test('the corner tools follow the lanes only where the row is on the map: no frame asks for another on a phone or under the compact bar (review r1)', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  assert.match(heat, /this\.#toolsLive = !!tools && !isPhone\(\);\n    if \(!tools \|\| !this\.#toolsLive\) \{ this\.#toolsAt = \{ right: Infinity, anchored: false \}; return; \}/);
  assert.match(heat, /if \(this\.#toolsLive\) \{ const at = this\.#cornerAt\(pw\); if \(at\.right !== this\.#toolsAt\.right \|\| at\.anchored !== this\.#toolsAt\.anchored\) this\.invalidate\(\); \}/);
  // The legend stands 20 px beside the row: the row moves only where that leaves the legend its least room.
  assert.match(heat, /minLeft: LEGEND_MIN_BESIDE_PX \+ 20,/);
  // The out-of-date plates are placed with the titles, after them, so none lands on a title, a note or past the foot.
  assert.match(heat, /const ys = placeCaptions\(\[\.\.\.plates, \.\.\.warns\], keep, plateTop\(look\), PLATE_H, this\.plotH\);/);
});
