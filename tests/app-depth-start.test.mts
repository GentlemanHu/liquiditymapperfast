// Where the map's recorded depth begins, said in the legend (Karl, 2026-11-26: printed beside its dashed line, the note travelled with every
// drag, jumped between rows under the legend and the corner tools, and landed among the legend's own lines). When the row shows, what it says,
// how it fits a narrow legend without losing the moment, and that the map prints it there and nowhere else.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { depthStartLines } from '../src/app/depth-start.ts';
import { setTimeZone } from '../src/app/format.ts';
import { LANGUAGES, setLanguage } from '../src/app/i18n.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** 6 px a character: about the legend's 11 px words. */
const wide = (words: string): number => words.length * 6;
const since = Date.UTC(2026, 10, 26, 14, 55), now = since + 20 * MIN;
beforeEach(() => { setTimeZone('utc'); setLanguage('en'); });
afterEach(() => { setTimeZone('local'); setLanguage('en'); });

test('the row shows while the view begins before the recording, wherever the view ends: the line in view, or the whole view before it', () => {
  assert.deepEqual(depthStartLines(wide, since, since - HOUR, now, 400), ['Depth recorded from 14:55'], 'the line in view');
  // Dragged into the past, the whole view before the recording: the empty map is what the row explains, so it stays.
  assert.deepEqual(depthStartLines(wide, since, since - 3 * DAY, now, 400), ['Depth recorded from 14:55'], 'the whole view before it');
  // A view recorded throughout (the line off to the left) has nothing for it to explain; nor has a source that recorded nothing yet or is
  // still reading its day (`Hub.depthSince` 0).
  assert.deepEqual(depthStartLines(wide, since, since, now, 400), []);
  assert.deepEqual(depthStartLines(wide, since, since + MIN, now, 400), []);
  assert.deepEqual(depthStartLines(wide, 0, since - HOUR, now, 400), []);
});

test('a start on another day carries its date: away from the line nothing else says which day', () => {
  assert.deepEqual(depthStartLines(wide, since, since - HOUR, since + 9 * HOUR, 400), ['Depth recorded from 14:55'], 'later the same day');
  assert.deepEqual(depthStartLines(wide, since, since - HOUR, since + 10 * HOUR, 400), ['Depth recorded from Nov 26 14:55'], 'after midnight');
  // The long history's first window, weeks back.
  const first = Date.UTC(2026, 10, 1);
  assert.deepEqual(depthStartLines(wide, first, first - DAY, now, 400), ['Depth recorded from Nov 1 00:00']);
});

test('where the sentence does not fit, it breaks before the moment, which is never cut off; in every language, with a date', () => {
  assert.deepEqual(depthStartLines(wide, since, since - HOUR, since + DAY, 150), ['Depth recorded from', 'Nov 26 14:55']);
  assert.deepEqual(depthStartLines(wide, since, since - HOUR, now, 150), ['Depth recorded from 14:55'], 'one line where it fits');
  // The words' room (`#paintLegend`): a 390 px phone's 300 px plot gives them 218 px, left of its Draw key; a 320 px phone's, and a desktop
  // legend beside the corner tools at its least, 148 px (at 6 px a letter, 24 letters).
  for (const { code } of LANGUAGES) {
    setLanguage(code, code === 'en' ? {} : JSON.parse(fs.readFileSync(`src/app/i18n/${code}.json`, 'utf8')) as Record<string, string>);
    for (const room of [218, 148]) {
      const lines = depthStartLines(wide, since, since - HOUR, since + DAY, room);
      assert.ok(lines.length >= 1 && lines.length <= 2, `${code} in ${room} px: ${JSON.stringify(lines)}`);
      assert.ok(lines.every(line => wide(line) <= room), `${code} in ${room} px: every line fits ${JSON.stringify(lines)}`);
      assert.ok(lines.some(line => line.includes('14:55')), `${code} in ${room} px: the moment kept ${JSON.stringify(lines)}`);
    }
  }
});

test('the map prints the words as the legend\'s last row, never beside the line, and draws again what stands under a legend that grew', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  const body = (name: string): string => { const start = heat.indexOf(`  ${name}(`); assert.ok(start > 0, name); return heat.slice(start, heat.indexOf('\n  }\n', start)); };
  assert.doesNotMatch(body('#paintHistoryStart'), /fillText|measureText/, 'the dashed line alone');
  const legend = body('#paintLegend');
  assert.match(legend, /depthStartLines\(wide, this\.hub\.depthSince\(\), this\.view\.t0, pageNow\(\), depthRoom\)/);
  // The plate is one rectangle from the title down: beside the corner buttons the row keeps to the legend's room, short of the buttons (a
  // phone's Draw key included), so a row wider than the others never carries the plate behind them; under the buttons, the legend's room.
  assert.match(legend, /depthRoom = Math\.max\(40, \(cornerBox && !dy \? Math\.min\(room, cornerBox\.x0 - 20\) : room\) - 12\)/);
  // After the scripts and their count, so their rows and buttons never move when the row comes or goes; in the plate's height, which the
  // levels' note, the bands, the drawing tools and the stripe's captions are placed by; not in the room the corner tools judge their look by.
  assert.ok(legend.indexOf('depthLines.forEach') > legend.indexOf('if (moreScripts)'), 'the last row');
  assert.match(legend, /plateH = textH \+ scriptsH \+ 14 \* depthLines\.length/);
  const need = legend.slice(legend.indexOf('this.#legendNeed ='), legend.indexOf('\n', legend.indexOf('this.#legendNeed =')));
  assert.doesNotMatch(need, /depth/i, 'the corner tools never change their look as the row comes or goes');
  // The overlay is drawn by the legend's last foot: where this one differs, the map is drawn again, in a whole frame too (a whole frame used to
  // check only a band, so without one the levels' note stood a frame under the new row).
  assert.match(body('#paintHoverLayer'), /if \(this\.#legendBox\.bottom !== legendBottom \|\| this\.#bands\.misplaced\(this\.#legendBox\.bottom\)\) this\.invalidate\(\);/);
  assert.doesNotMatch(heat, /#historyNote/, 'nothing keeps clear of a note that no longer moves');
});
