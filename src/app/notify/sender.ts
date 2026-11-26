/**
 * One tab of a coin sends its alerts: two tabs on BTC would otherwise send every message twice. The browser's Web Locks hold the role: the
 * first tab of a coin takes it and keeps it while it lives; the next waits in line and takes over when that one closes. A tab that pauses
 * (a replay: it sends nothing while it plays the past) gives the role up, and asks for it again when the pause ends. A browser without Web
 * Locks has every tab send.
 *
 * Every tab still judges the coin's bells and sounds them (draw/controller.ts `markMoved`); while Notify sends bells, only this tab switches
 * off one that goes off once, after it reached the person (sound/alerts.ts `drawing`).
 *
 * The recorder's lock (browser/feeds.worker.ts) is held inside the feeds worker and means something else (who writes the recording), so this
 * one is the page's own.
 */

interface Locks { request(name: string, callback: () => Promise<void>): Promise<unknown> }

export class SenderLock {
  /** Whether this tab holds the role. */
  holder = false;
  /** Whether it waits in line behind another tab of the coin. */
  waiting = false;
  #wanted = true;
  /** A request waits in the browser's line: asked once, never again until it is granted (it cannot be taken back). */
  #pending = false;
  /** Lets the lock go (the held promise settles). */
  #release: (() => void) | null = null;
  readonly #name: string;

  constructor(coin: string, private onChange: () => void = () => {}, private locks: Locks | undefined = (globalThis.navigator as Navigator & { locks?: Locks } | undefined)?.locks) {
    this.#name = `lmf-alerts:${coin}`;
    if (!locks || typeof locks.request !== 'function') { this.holder = true; return; }
    this.#ask();
  }

  #ask(): void {
    const locks = this.locks!;
    this.waiting = true;
    if (this.#pending) return;
    this.#pending = true;
    // Held until the page goes away or pauses: the promise settles only then, and the browser lets the lock go with the page.
    locks.request(this.#name, () => new Promise<void>(release => {
      this.#pending = false;
      if (!this.#wanted) { release(); return; }
      this.holder = true; this.waiting = false; this.#release = release;
      this.onChange();
    })).catch(() => { this.#pending = false; if (this.#wanted) { this.holder = true; this.waiting = false; this.onChange(); } });
  }

  /** Give the role up for a while (`true`: a replay began) or ask for it again (`false`). */
  pause(paused: boolean): void {
    if (!this.locks || typeof this.locks.request !== 'function' || paused === !this.#wanted) return;
    this.#wanted = !paused;
    if (paused) {
      this.#release?.(); this.#release = null;
      this.holder = false; this.waiting = false;
      this.onChange();
    } else this.#ask();
  }
}
