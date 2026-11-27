import type { Message, Outcome, Problem } from './channels.ts';

/**
 * The way out for alerts that leave the page (pure, tests/notify-delivery.test.mts): one lane per channel, each with its own limits, so a
 * phone is never flooded and a service never refuses the page for asking too often. These limits are apart from the sounds' cap (four sounds
 * in ten seconds, sound/alerts.ts): a burst of wall sounds must not swallow a price alert on its way to a phone.
 *
 * A lane sends one message at a time. It may send `LIMITS.burst` at once, then one every `LIMITS.everyMs`, and at most `LIMITS.perHour` in an
 * hour, of which the last `LIMITS.bellReserve` only bells may use (a busy hour of panel alerts never spends what a price alert needs); it
 * holds at most `LIMITS.queue` waiting (the oldest that is not a bell goes first when it is full) and none older than `LIMITS.staleMs` (a price
 * alert that late would say something that is no longer so). A send that failed for a reason that passes (the network, a timeout, a busy
 * service) is tried once more; a service that says when to come back is waited for.
 *
 * Each push answers whether any channel sent it (`done`): a bell that goes off once switches itself off only then (draw/controller.ts).
 */

export type ChannelId = 'desktop' | 'telegram' | 'ntfy' | 'discord';
/** A message on its way: what it says, the alert it is (`key`: its cool-down's), when the alert went off, and whether it is a bell's. */
export interface Outgoing extends Message { key: string; at: number; sticky?: boolean }
export interface Sender { readonly id: ChannelId; send(m: Outgoing): Promise<Outcome> }

/** What became of a message on one channel: sent, failed (and why), or not sent for the limits or for being too late. */
export interface DeliveryEntry { at: number; channel: ChannelId; title: string; outcome: 'sent' | 'failed' | 'limited' | 'late'; problem?: Problem }

export const LIMITS = { burst: 4, everyMs: 5_000, perHour: 60, bellReserve: 15, queue: 8, staleMs: 5 * 60_000, retryMs: 10_000, maxWaitMs: 15 * 60_000 } as const;
/** Problems that pass: worth one more try. A token, a chat, a topic or a webhook that is wrong stays wrong. */
const PASSING: ReadonlySet<Problem> = new Set<Problem>(['timeout', 'network', 'busy', 'answer']);

/** One message's channels still out, and how it ends: true at its first send, false once every channel has finished without one. */
interface Tracker { out: number; settled: boolean; resolve: (sent: boolean) => void }
interface Waiting { m: Outgoing; tried: boolean; track: Tracker }
interface Lane { queue: Waiting[]; tokens: number; filledAt: number; sent: number[]; busy: boolean; until: number; timer: boolean; gen: number }

export class Delivery {
  /** The newest outcomes, oldest first (the panel shows the last few). */
  readonly log: DeliveryEntry[] = [];
  /** Something was sent, failed or dropped (the panel redraws). */
  onChange: () => void = () => {};
  readonly #lanes = new Map<ChannelId, Lane>();
  readonly #senders = new Map<ChannelId, Sender>();

  constructor(private clock: () => number = Date.now, private later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }) {}

  /** Queue a message on each of `senders`' channels: the channels it was queued on, and whether any of them sent it. */
  push(m: Outgoing, senders: readonly Sender[]): { channels: ChannelId[]; done: Promise<boolean> } {
    let resolve: (sent: boolean) => void = () => {};
    const done = new Promise<boolean>(r => { resolve = r; });
    const track: Tracker = { out: senders.length, settled: false, resolve };
    if (!senders.length) { track.settled = true; resolve(false); }
    const channels: ChannelId[] = [];
    for (const sender of senders) {
      this.#senders.set(sender.id, sender);
      const lane = this.#lane(sender.id);
      if (lane.queue.length >= LIMITS.queue) {
        // Full: the oldest that is not a bell makes room; with bells alone waiting, a panel alert is the one turned away (a bell then makes
        // room only for another bell).
        const i = lane.queue.findIndex(w => !w.m.sticky);
        if (i < 0 && !m.sticky) { this.#end(sender.id, { m, tried: false, track }, 'limited'); continue; }
        const [dropped] = lane.queue.splice(i >= 0 ? i : 0, 1);
        this.#end(sender.id, dropped!, 'limited');
      }
      lane.queue.push({ m, tried: false, track });
      channels.push(sender.id);
      this.#pump(sender.id);
    }
    return { channels, done };
  }

  /** How many messages wait on a channel (sent or not yet). */
  waiting(id: ChannelId): number { return this.#lanes.get(id)?.queue.length ?? 0; }

  /**
   * Forget what waits on a channel (its bot, topic or webhook was taken away or switched off): nothing more goes out on it with the old one.
   * A send already on its way finishes.
   */
  clear(id: ChannelId): void {
    const lane = this.#lanes.get(id);
    this.#senders.delete(id);
    if (!lane) return;
    lane.gen++;
    for (const w of lane.queue.splice(0)) this.#settle(w.track, false);
  }

  #lane(id: ChannelId): Lane {
    let lane = this.#lanes.get(id);
    if (!lane) { lane = { queue: [], tokens: LIMITS.burst, filledAt: this.clock(), sent: [], busy: false, until: 0, timer: false, gen: 0 }; this.#lanes.set(id, lane); }
    return lane;
  }

  /** One channel finished with a message: noted, and the message's answer given once it is sent or every channel has finished. */
  #end(channel: ChannelId, w: Waiting, outcome: DeliveryEntry['outcome'], problem?: Problem): void {
    this.log.push({ at: this.clock(), channel, title: w.m.body.split('\n')[0] ?? w.m.title, outcome, ...(problem ? { problem } : {}) });
    if (this.log.length > 50) this.log.splice(0, this.log.length - 50);
    this.#settle(w.track, outcome === 'sent');
    this.onChange();
  }

  #settle(track: Tracker, sent: boolean): void {
    track.out--;
    if (track.settled) return;
    if (sent || track.out <= 0) { track.settled = true; track.resolve(sent); }
  }

  /** Come back to a lane in `ms` (once: a lane already waiting for its timer is not given another). */
  #wake(id: ChannelId, lane: Lane, ms: number): void {
    if (lane.timer) return;
    lane.timer = true;
    this.later(() => { lane.timer = false; this.#pump(id); }, Math.max(0, Math.min(ms, LIMITS.maxWaitMs)));
  }

  #pump(id: ChannelId): void {
    const lane = this.#lane(id), sender = this.#senders.get(id);
    if (lane.busy || !sender) return;
    const now = this.clock();
    // Late ones go first: whatever waited past the stale limit is dropped before anything is sent.
    for (let i = 0; i < lane.queue.length;) {
      if (now - lane.queue[i]!.m.at > LIMITS.staleMs) this.#end(id, lane.queue.splice(i, 1)[0]!, 'late'); else i++;
    }
    if (!lane.queue.length) return;
    if (now < lane.until) { this.#wake(id, lane, lane.until - now); return; }
    lane.tokens = Math.min(LIMITS.burst, lane.tokens + (now - lane.filledAt) / LIMITS.everyMs); lane.filledAt = now;
    while (lane.sent.length && now - lane.sent[0]! >= 3_600_000) lane.sent.shift();
    // The hour's messages spent: what waits is dropped (said in the panel) rather than sent an hour late; past what panels may use, bells alone go on.
    if (lane.sent.length >= LIMITS.perHour) { for (const w of lane.queue.splice(0)) this.#end(id, w, 'limited'); return; }
    if (lane.sent.length >= LIMITS.perHour - LIMITS.bellReserve) {
      for (let i = 0; i < lane.queue.length;) { if (!lane.queue[i]!.m.sticky) this.#end(id, lane.queue.splice(i, 1)[0]!, 'limited'); else i++; }
      if (!lane.queue.length) return;
    }
    if (lane.tokens < 1) { this.#wake(id, lane, (1 - lane.tokens) * LIMITS.everyMs); return; }
    const w = lane.queue.shift()!, gen = lane.gen;
    lane.tokens -= 1; lane.sent.push(now); lane.busy = true;
    const done = (outcome: Outcome): void => {
      lane.busy = false;
      if (outcome.ok) this.#end(id, w, 'sent');
      // The lane was cleared while this was on its way (its bot, topic or webhook taken away): no second try with the old one.
      else if (gen !== lane.gen) this.#end(id, w, 'failed', outcome.problem);
      else if (!w.tried && PASSING.has(outcome.problem)) {
        // One more try, after the wait the service asked for or a short one, ahead of anything that came since.
        lane.queue.unshift({ ...w, tried: true });
        lane.until = Math.max(lane.until, this.clock() + (outcome.retryAfterMs ?? LIMITS.retryMs));
      } else {
        if (outcome.retryAfterMs) lane.until = Math.max(lane.until, this.clock() + outcome.retryAfterMs);
        this.#end(id, w, 'failed', outcome.problem);
      }
      this.#pump(id);
    };
    let sending: Promise<Outcome>;
    try { sending = sender.send(w.m); } catch { sending = Promise.resolve({ ok: false, problem: 'network' }); }
    sending.then(done, () => done({ ok: false, problem: 'network' }));
  }
}
