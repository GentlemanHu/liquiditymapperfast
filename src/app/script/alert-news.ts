import type { AlertOut, AlertSound, ScriptResult } from './protocol.ts';

/**
 * Which of a script's alerts are news (`alert(...)`). A run hands back the alerts of its newest candles every time it runs; the page sounds
 * each one once. Pure, so the rules are tested without a page.
 */

/** A closed candle's alert sounds only this soon after the candle closed: later it is history (a tab that slept, an answer that came late). */
export const ALERT_FRESH_MS = 30_000;
/** The most charts whose alerts are remembered; one forgotten starts again by taking note (it never sounds what it held). */
export const ALERT_CHARTS = 64;

/** A script's alert for the page to sound: its script, what it says, its sound, and the key its cool-down is kept under (the script and call). */
export interface ScriptAlert { id: string; name: string; text: string; sound: AlertSound; key: string }

/** A short fingerprint of a text (FNV-1a), to tell one version of a script from another without keeping its text. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k++) { h ^= text.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * The alerts seen, per chart (a version of a script on a market and a timeframe). Each alert counts once per call, candle and kind. The first
 * answer for a chart only takes note of what it holds, as the page's other alerts never sound on what was there when they started; an alert
 * meant for the close waits for its candle to close; any is news only until `ALERT_FRESH_MS` after its candle's close. A chart keeps
 * only the alerts of the candles that can still alert (from `since`, the oldest candle a run hands back), so what it holds never outgrows two
 * candles' alerts and nothing still handed back is forgotten.
 */
export class AlertNews {
  readonly #charts = new Map<string, Map<string, number>>();

  /** The news in an answer for `chart`; `since` is the start of the oldest candle its run could alert at. */
  take(res: Extract<ScriptResult, { ok: true }>, chart: string, tf: number, since: number, now: number): AlertOut[] {
    let seen = this.#charts.get(chart);
    const first = !seen;
    if (seen) this.#charts.delete(chart); else seen = new Map();
    // Kept in the order last answered: the chart answered longest ago is the one let go.
    this.#charts.set(chart, seen);
    if (this.#charts.size > ALERT_CHARTS) this.#charts.delete(this.#charts.keys().next().value!);
    for (const [key, t] of seen) if (t < since) seen.delete(key);
    const out: AlertOut[] = [];
    for (const a of res.alerts ?? []) {
      if (a.when === 'close' && a.forming) continue;
      const key = `${a.site}|${a.t}|${a.when}`;
      if (seen.has(key)) continue;
      seen.set(key, a.t);
      // Past its candle's close by more than the window, an alert is history, whether or not the run saw the candle under way (an answer
      // can come late: a worker that loaded again).
      if (first || now - (a.t + tf) > ALERT_FRESH_MS) continue;
      out.push(a);
    }
    return out;
  }
}
