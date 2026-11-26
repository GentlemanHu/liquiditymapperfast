// Where the map's recorded depth begins, said in the legend (Karl, 2026-11-26: printed beside its dashed line, the note travelled with every
// drag, jumped between rows under the legend and the corner tools, and landed among the legend's own lines). When the row shows, what it says,
// how it fits a narrow legend without losing the moment, and that the map prints it there and nowhere else.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dayNumber, depthStartLines, depthStartShown } from '../src/app/depth-start.ts';
import { setTimeZone, startOfDay } from '../src/app/format.ts';
import { LANGUAGES, setLanguage } from '../src/app/i18n.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** 6 px a character: about the legend's 11 px words. */
const wide = (words: string): number => words.length * 6;
const since = Date.UTC(2026, 10, 26, 14, 55), now = since + 20 * MIN;
const pack = (code: string): Record<string, string> => code === 'en' ? {} : JSON.parse(fs.readFileSync(`src/app/i18n/${code}.json`, 'utf8')) as Record<string, string>;
beforeEach(() => { setTimeZone('utc'); setLanguage('en'); });
afterEach(() => { setTimeZone('local'); setLanguage('en'); });

test('the row shows once the view is framed and while it begins before the recording, wherever the view ends', () => {
  assert.equal(depthStartShown(since, since - HOUR, since + HOUR), true, 'the line in view');
  // Dragged into the past, the whole view before the recording: the empty map is what the row explains, so it stays.
  assert.equal(depthStartShown(since, since - 3 * DAY, since - 2 * DAY), true, 'the whole view before it');
  // A view recorded throughout (the line off to the left) has nothing for it to explain; nor has a source that recorded nothing yet or is
  // still reading its day (`Hub.depthSince` 0).
  assert.equal(depthStartShown(since, since, since + HOUR), false, 'the view begins where the recording does');
  assert.equal(depthStartShown(since, since + MIN, since + HOUR), false, 'a view recorded throughout');
  assert.equal(depthStartShown(0, since - HOUR, since + HOUR), false, 'nothing recorded yet');
  // The map starts with a view of 0 to 0 until it is first framed: the row would show for a frame and go again.
  assert.equal(depthStartShown(since, 0, 0), false, 'a view not framed yet');
});

test('a start on another day carries its date: away from the line nothing else says which day', () => {
  assert.deepEqual(depthStartLines(wide, since, since + 9 * HOUR, 400), ['Depth recorded from 14:55'], 'later the same day');
  assert.deepEqual(depthStartLines(wide, since, since + 10 * HOUR, 400), ['Depth recorded from Nov 26 14:55'], 'after midnight');
  // The long history's first window, weeks back.
  const first = Date.UTC(2026, 10, 1);
  assert.deepEqual(depthStartLines(wide, first, now, 400), ['Depth recorded from Nov 1 00:00']);
});

test('one day on the page\'s clock across a clock change: no date on a spring-forward or fall-back morning, a date on the next day', () => {
  const zone = process.env.TZ, machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = 'Europe/Madrid';
  setTimeZone('local');
  try {
    // 2027-03-28, 02:00 became 03:00: 01:00 is 00:00 UTC (an hour ahead), 05:00 is 03:00 UTC (two ahead). The starts of their days, each worked
    // out with its own offset, are an hour apart, and the row used to say the date of the morning it was still in.
    const spring = Date.UTC(2027, 2, 28, 0), springLater = Date.UTC(2027, 2, 28, 3);
    assert.notEqual(startOfDay(spring), startOfDay(springLater), 'the starts of the day differ across the change');
    assert.equal(dayNumber(spring), dayNumber(springLater));
    assert.deepEqual(depthStartLines(wide, spring, springLater, 400), ['Depth recorded from 01:00']);
    // 2027-10-31, 03:00 became 02:00 again: 01:00 is 23:00 UTC the evening before, 05:00 is 04:00 UTC.
    const fall = Date.UTC(2027, 9, 30, 23), fallLater = Date.UTC(2027, 9, 31, 4);
    assert.notEqual(startOfDay(fall), startOfDay(fallLater), 'the starts of the day differ across the change');
    assert.equal(dayNumber(fall), dayNumber(fallLater));
    assert.deepEqual(depthStartLines(wide, fall, fallLater, 400), ['Depth recorded from 01:00']);
    // An ordinary day (summer time, two hours ahead), and the step into the next one.
    assert.deepEqual(depthStartLines(wide, Date.UTC(2027, 5, 10, 7), Date.UTC(2027, 5, 10, 16), 400), ['Depth recorded from 09:00']);
    assert.deepEqual(depthStartLines(wide, Date.UTC(2027, 5, 10, 21, 30), Date.UTC(2027, 5, 10, 22, 30), 400), ['Depth recorded from Jun 10 23:30']);
  } finally {
    // Deleting TZ does not take Node on Windows back to the machine's zone (it stays on the last one set), so the zone it had is named again.
    process.env.TZ = zone ?? machine;
    setTimeZone('utc');
  }
});

test('where the sentence does not fit it takes two lines, broken before the moment where both parts fit, else between words, the moment kept', () => {
  assert.deepEqual(depthStartLines(wide, since, since + DAY, 150), ['Depth recorded from', 'Nov 26 14:55']);
  assert.deepEqual(depthStartLines(wide, since, now, 150), ['Depth recorded from 14:55'], 'one line where it fits');
  // The words' room (`#depthRow`): a 390 px phone's 300 px plot gives them 218 px, left of its Draw key; a 320 px phone's, and a desktop
  // legend beside the corner tools at its least, 148 px (at 6 px a letter, 24 letters). Today's time and an earlier day's date, both. A 320 px
  // phone's map beside the profile column (a coin without the levels' column) leaves 96 px and a little more, where two lines cannot hold the
  // sentence in several languages: words are cut short there, never the moment.
  for (const { code } of LANGUAGES) {
    setLanguage(code, pack(code));
    for (const room of [218, 148, 110, 96]) for (const at of [now, since + DAY]) {
      const lines = depthStartLines(wide, since, at, room), said = `${code} in ${room} px: ${JSON.stringify(lines)}`;
      assert.ok(lines.length >= 1 && lines.length <= 2, said);
      assert.ok(lines.every(line => wide(line) <= room), `${said}: every line fits`);
      if (room >= 148) assert.ok(lines.every(line => !line.includes('…')), `${said}: no word cut short`);
      assert.ok(lines.some(line => line.includes('14:55')), `${said}: the moment kept`);
    }
  }
  // The two the review saw cut: French, whose words before the moment are wider than 148 px ("Profondeur enregistrée dep…"), and Turkish,
  // whose moment comes first with a long verb after it ("26 Kas 14:55 itibar…"). Both break between words now.
  setLanguage('fr', pack('fr'));
  assert.deepEqual(depthStartLines(wide, since, since + DAY, 148), ['Profondeur enregistrée', 'depuis 26 nov. 14:55']);
  setLanguage('tr', pack('tr'));
  assert.deepEqual(depthStartLines(wide, since, since + DAY, 148), ['Derinlik 26 Kas 14:55', 'itibarıyla kaydedildi']);
  // In 96 px two wrapped lines ended "from Nov 26 14:…" (English) and "enregistrée dep…" (French): the words before the moment are cut short
  // instead, the moment on a line of its own.
  setLanguage('en');
  assert.deepEqual(depthStartLines(wide, since, since + DAY, 96), ['Depth recorded…', 'Nov 26 14:55']);
  setLanguage('fr', pack('fr'));
  assert.deepEqual(depthStartLines(wide, since, now, 96), ['Profondeur enre…', '14:55']);
});

test('the map prints the words as the legend\'s last row, never beside the line, and draws again what stands under a legend that grew', () => {
  const heat = fs.readFileSync('src/app/panes/heat-pane.ts', 'utf8');
  const body = (name: string): string => { const start = heat.indexOf(`  ${name}(`); assert.ok(start > 0, name); return heat.slice(start, heat.indexOf('\n  }\n', start)); };
  assert.doesNotMatch(body('#paintHistoryStart'), /fillText|measureText/, 'the dashed line alone');
  const legend = body('#paintLegend'), row = body('#depthRow');
  // Worked out only while the row shows (the corner buttons are read then alone), once the view is framed, and kept by what changes it.
  assert.match(legend, /const depth = depthStartShown\(since, this\.view\.t0, this\.view\.t1\) \? this\.#depthRow\(wide, since, room, dy\) : null;/);
  assert.match(row, /key = `\$\{since\}\|\$\{dayNumber\(since\) === dayNumber\(now\)\}\|\$\{depthRoom\}\|\$\{language\(\)\}\|\$\{timeZone\(\)\}`/);
  // The plate is one rectangle from the title down: beside the corner buttons the row keeps to the legend's room, short of the buttons (a
  // phone's Draw key included), so a row wider than the others never carries the plate behind them; under the buttons, the legend's room.
  assert.match(row, /depthRoom = Math\.round\(Math\.max\(40, \(cornerBox && !dy \? Math\.min\(room, cornerBox\.x0 - 20\) : room\) - 12\)\)/);
  // After the scripts and their count, so their rows and buttons never move when the row comes or goes; in the plate's height, which the
  // levels' note, the bands, the drawing tools and the stripe's captions are placed by; not in the room the corner tools judge their look by.
  assert.ok(legend.indexOf('depthLines.forEach') > legend.indexOf('if (moreScripts)'), 'the last row');
  assert.match(legend, /plateH = textH \+ scriptsH \+ 14 \* depthLines\.length/);
  const need = legend.slice(legend.indexOf('this.#legendNeed ='), legend.indexOf('\n', legend.indexOf('this.#legendNeed =')));
  assert.doesNotMatch(need, /depth/i, 'the corner tools never change their look as the row comes or goes');
  const hover = body('#paintHoverLayer');
  // A young recording's first load has the row, the levels' note ("Liquidation levels are loading.") and "Collecting depth history…" at once:
  // that line stands under the legend and under the note while the levels are on (their box is kept from an earlier frame when they are off),
  // and is left out where it would reach the volume strip's names (a phone held sideways: a 138 px map).
  assert.match(hover, /const y = Math\.max\(50, this\.#legendBox\.bottom \+ 8, state\.liqLevels\.on && this\.#liqNoteBox \? this\.#liqNoteBox\.bottom \+ 8 : 0\);/);
  assert.match(hover, /const foot = state\.show\.volume && this\.candlesDrawn\(state\)\.length \? stripNamesTop\(ph, volumeBand\(ph\)\) : ph;\s+if \(y \+ 6 <= foot\) \{[^}]*fillText\(t\('Collecting depth history…'\), 12, y\)/);
  // The overlay is drawn by the legend's last foot: where this one differs, the map is drawn again, in a whole frame too (a whole frame used to
  // check only a band, so without one the levels' note stood a frame under the new row).
  assert.match(hover, /if \(this\.#legendBox\.bottom !== legendBottom \|\| this\.#bands\.misplaced\(this\.#legendBox\.bottom\)\) this\.invalidate\(\);/);
  assert.doesNotMatch(heat, /#historyNote/, 'nothing keeps clear of a note that no longer moves');
});
