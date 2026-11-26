import { clock, startOfDay } from './format.ts';
import { t } from './i18n.ts';
import { fitText } from './text-fit.ts';

/**
 * The legend's row that says where the map's recorded depth begins (`Hub.depthSince`): the lines it prints in `room` px (`measure` is the
 * width of words in its font), or none. Karl, 2026-11-26: printed beside the dashed line that marks the moment, the note moved with every
 * drag, jumped between rows under the legend and the corner tools, and landed among the legend's own lines. The line still marks the moment on
 * the map (`HeatPane.#paintHistoryStart`); the words are the legend plate's last row, which everything placed under the legend keeps clear of.
 * - Shown while the view begins before the recording: the line in view, or the whole view before it, where the empty map is what the note
 *   explains. A view recorded throughout has nothing for it to explain.
 * - The time alone names a moment of the day on screen; away from the line nothing else says which day, so a start on another day (a tab
 *   open since yesterday, the long history's first window weeks back) carries its date.
 * - Where the sentence does not fit, it breaks before the moment rather than cutting the moment off behind an ellipsis.
 */
export function depthStartLines(measure: (words: string) => number, since: number, t0: number, now: number, room: number): string[] {
  if (!(since > 0) || since <= t0) return [];
  const time = clock(since, startOfDay(since) !== startOfDay(now)), text = t('Depth recorded from {time}', { time });
  if (measure(text) <= room) return [text];
  const at = text.indexOf(time), head = at > 0 ? text.slice(0, at).trim() : '';
  return head ? [fitText(measure, head, room), fitText(measure, text.slice(at).trim(), room)] : [fitText(measure, text, room)];
}
