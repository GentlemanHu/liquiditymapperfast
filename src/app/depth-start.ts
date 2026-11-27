/**
 * The legend's row that says where the map's recorded depth begins (`Hub.depthSince`). Karl, 2026-11-26: printed beside the dashed line that
 * marks the moment, the note moved with every drag, jumped between rows under the legend and the corner tools, and landed among the legend's
 * own lines. The line still marks the moment on the map (`HeatPane.#paintHistoryStart`); the words are the legend plate's last row, which
 * everything placed under the legend keeps clear of.
 */
import { clock, zoneOffsetMs } from './format.ts';
import { t } from './i18n.ts';
import { fitText, wrapText } from './text-fit.ts';

const DAY = 86_400_000;

/**
 * The day `t` falls on, on the page's clock, as a number (whole days since 1970 on the wall): two moments are on one day where these agree.
 * Each moment is moved by its own offset, so a clock change between them (a spring-forward or fall-back morning) does not part one day in
 * two, as comparing the starts of their days did.
 */
export const dayNumber = (t: number): number => Math.floor((t + zoneOffsetMs(t)) / DAY);

/**
 * Whether the row shows over the view `t0` to `t1`: once the view is framed (both ends 0 until the map first places it, when the row would
 * show for a frame and go again), while it begins before the recording, `since`: the line in view, or the whole view before it, where the
 * empty map is what the row explains. A view recorded throughout has nothing for it to explain, nor has a source that recorded nothing yet or
 * is still reading its day (`since` 0).
 */
export function depthStartShown(since: number, t0: number, t1: number): boolean {
  return since > 0 && t1 > t0 && since > t0;
}

/**
 * The row's lines in `room` px (`measure` is the width of words in its font). The time alone names a moment of the day on screen; away from
 * the line nothing else says which day, so a start on another day (a tab open since yesterday, the long history's first window weeks back)
 * carries its date. Where the sentence does not fit it takes two lines: broken before the moment where both parts fit, else at its spaces
 * (`wrapText`). Where even two lines cannot hold it (a 320 px phone's map beside the profile column leaves some 96 px, short of the sentence
 * in French, Italian, Portuguese, German or Spanish), the words before the moment and the moment take a line each, each cut short where it
 * must: an ellipsis at the end of two wrapped lines would cut off the moment, which ends the sentence in most languages.
 */
export function depthStartLines(measure: (words: string) => number, since: number, now: number, room: number): string[] {
  const time = clock(since, dayNumber(since) !== dayNumber(now)), text = t('Depth recorded from {time}', { time });
  if (measure(text) <= room) return [text];
  const at = text.indexOf(time), head = at > 0 ? text.slice(0, at).trim() : '', tail = text.slice(Math.max(0, at)).trim();
  if (head && measure(head) <= room && measure(tail) <= room) return [head, tail];
  const lines = wrapText(measure, text, room, 2);
  return head && lines.some(line => line.includes('…')) ? [fitText(measure, head, room), fitText(measure, tail, room)] : lines;
}
