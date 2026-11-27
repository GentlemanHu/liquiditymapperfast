import { t } from '../i18n.ts';
import { price as fmtPrice } from '../format.ts';
import { AUTHOR } from '../author.ts';
import type { AlertPanel } from '../sound/alerts.ts';
import { botOf, chatOf, discordOutcome, discordSend, ntfyOutcome, ntfySend, telegramMe, telegramOutcome, telegramSend, telegramUpdates, type Outcome, type Problem } from './channels.ts';
import { Delivery, type ChannelId, type Outgoing, type Sender } from './delivery.ts';
import { askDesktop, desktopPermission, popUp } from './desktop.ts';
import { SenderLock } from './sender.ts';
import { Transport } from './transport.ts';
import { NOTIFY_KEY, loadNotify, readNotify, saveNotify, type NotifySettings } from './settings.ts';

/**
 * Notify (Karl, 2026-11-26): the page's alerts as a pop-up on this computer and as messages to a phone, sent by this browser while the page
 * is open. A bell on a drawing, a script's `alert` and a panel's alert all go off in sound/alerts.ts (`#fire`), which hands each one here
 * when Notify wants it (`wants`); here it becomes a message (`messageOf`) and goes out on every channel switched on, through `Delivery`'s
 * lanes. Only the tab that holds the coin's role sends (`SenderLock`), so two tabs never send the same alert twice.
 *
 * The settings are this browser's (settings.ts `NOTIFY_KEY`): another tab's change is read here as it is made.
 */

export type PhoneChannel = 'telegram' | 'ntfy' | 'discord';

/**
 * Channels whose real send has not been seen yet (each needs a bot or a webhook of the owner's own): offered on a page served from this
 * computer (Karl's own server, where he tries them) or with `?notify=all`, not yet on the public page. ntfy and the pop-up were seen to work
 * end to end on 2026-11-26; Telegram on 2026-11-27 (Karl's own bot made with BotFather, its chat found by Find my chat, the test message
 * received in Telegram from the page on his computer). Discord waits for a webhook of his to receive one.
 */
const UNSEEN: ReadonlySet<ChannelId> = new Set<ChannelId>(['discord']);
export function offered(id: ChannelId): boolean {
  if (!UNSEEN.has(id)) return true;
  if (typeof location === 'undefined') return true;
  return /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || new URLSearchParams(location.search).get('notify') === 'all';
}

/** The address a message opens: the public page on the alert's coin (a phone cannot reach a page served from the computer itself). */
export const chartUrl = (coin: string): string => `${AUTHOR.site}?coin=${encodeURIComponent(coin)}`;

/** An alert as a message: "BTC alert", what went off, and the price now when it is known. */
export function messageOf(text: string, coin: string, price: number, at: number, key: string, sticky: boolean): Outgoing {
  const body = price > 0 && Number.isFinite(price) ? `${text}\n${t('Now {price}', { price: fmtPrice(price) })}` : text;
  return { title: t('{coin} alert', { coin }), body, url: chartUrl(coin), key, at, sticky };
}

/** What a person reads for a problem a channel had. */
export function problemText(problem: Problem): string {
  switch (problem) {
    case 'timeout': return t('No answer in time: try again.');
    case 'network': return t('Could not reach it: check the connection.');
    case 'token': return t('Telegram does not know this token: copy it again from BotFather.');
    case 'chat': return t('The bot cannot write to you: open it in Telegram and press Start.');
    case 'webhook': return t('Discord does not know this webhook: copy its address again.');
    case 'topic': return t('ntfy refused this topic: choose another.');
    case 'busy': return t('The service asked to wait: messages go out again shortly.');
    case 'conflict': return t('This bot sends its messages to a webhook, so the page cannot read them: make a new bot for alerts.');
    case 'refused': return t('This browser does not allow it here.');
    case 'answer': return t('An answer that could not be read: try again later.');
  }
}

export class Notify {
  #s: NotifySettings;
  readonly delivery: Delivery;
  readonly sender: SenderLock;
  readonly #transport = new Transport();
  readonly #listeners = new Set<() => void>();
  /** When each channel was last tested, so a button pressed again and again sends one test at a time. */
  readonly #tested = new Map<ChannelId, number>();

  /** `coin`: the page's coin (the role is held per coin); `price`: the chart market's price now, for the message. */
  constructor(private coin: string, private price: () => number, private storage: Storage | null = safeStorage(), clock: () => number = Date.now) {
    this.#s = loadNotify(storage);
    this.delivery = new Delivery(clock);
    this.delivery.onChange = () => this.#emit();
    this.sender = new SenderLock(coin, () => this.#emit());
    if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === NOTIFY_KEY) this.#apply(loadNotify(storage), false); });
  }

  get settings(): NotifySettings { return this.#s; }

  /**
   * Change the settings (checked as a kept copy is: a channel without what it needs is off) and keep them. A channel switched off, or given
   * another bot, chat, topic, server or webhook, drops what still waits on it, so nothing more goes out with the old one.
   */
  set(patch: Partial<NotifySettings>): boolean { return this.#apply(readNotify({ ...this.#s, ...patch }), true); }

  /** Take settings (this tab's change, kept; or another tab's, read), dropping what waits on any channel they changed or switched off. */
  #apply(now: NotifySettings, keep: boolean): boolean {
    const was = this.#s, off = !now.on;
    this.#s = now;
    if (off || !now.desktop) this.delivery.clear('desktop');
    if (off || !now.telegram.on || now.telegram.token !== was.telegram.token || now.telegram.chat !== was.telegram.chat) this.delivery.clear('telegram');
    if (off || !now.ntfy.on || now.ntfy.topic !== was.ntfy.topic || now.ntfy.server !== was.ntfy.server) this.delivery.clear('ntfy');
    if (off || !now.discord.on || now.discord.url !== was.discord.url) this.delivery.clear('discord');
    const kept = keep ? saveNotify(this.storage, now) : true;
    this.#emit();
    return kept;
  }

  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(): void { for (const listener of this.#listeners) listener(); }

  /** The channels that would get a message now: switched on and ready (a pop-up only where the browser allows one). */
  channels(): ChannelId[] {
    const s = this.#s, out: ChannelId[] = [];
    if (s.desktop && desktopPermission() === 'granted') out.push('desktop');
    if (s.telegram.on) out.push('telegram');
    if (s.ntfy.on) out.push('ntfy');
    if (s.discord.on) out.push('discord');
    return out.filter(offered);
  }

  /** Whether Notify is on with somewhere to send: the Notify button is lit, and the panels' alerts are looked for even with Sounds off. */
  get active(): boolean { return this.#s.on && this.channels().length > 0; }

  /** Whether an alert of this panel would be sent: bells, scripts and the other panels each by their switch; open interest's never. */
  wants(panel: AlertPanel): boolean {
    if (!this.active) return false;
    const send = this.#s.send;
    if (panel === 'drawing') return send.bells;
    if (panel === 'script') return send.scripts;
    if (panel === 'oi') return false;
    return send.panels;
  }

  /** Whether this tab sends alerts of this panel: Notify wants them, and this tab holds the coin's role (`SenderLock`). */
  sends(panel: AlertPanel): boolean { return this.wants(panel) && this.sender.holder; }

  /**
   * Send an alert that went off (sound/alerts.ts): how many channels took it and whether any of them sent it; null where this tab does not send
   * it (another tab of the coin does, or Notify does not want it) or no channel took it.
   */
  deliver(panel: AlertPanel, text: string, key: string, at: number): { channels: number; done: Promise<boolean> } | null {
    if (!this.sends(panel)) return null;
    const pushed = this.delivery.push(messageOf(text, this.coin, this.price(), at, key, panel === 'drawing'), this.#senders(this.channels()));
    return pushed.channels.length ? { channels: pushed.channels.length, done: pushed.done } : null;
  }

  /** Send a test message on one channel now, past the lanes (a click's answer is wanted at once), at most one every three seconds a channel. */
  async test(id: ChannelId): Promise<Outcome> {
    const now = Date.now(), last = this.#tested.get(id) ?? 0;
    if (now - last < 3_000) return { ok: false, problem: 'busy' };
    this.#tested.set(id, now);
    const sender = this.#senders([id])[0];
    if (!sender) return { ok: false, problem: 'refused' };
    const m = messageOf(t('Test: alerts from LiquidityMapper will arrive here.'), this.coin, this.price(), now, `test:${id}`, false);
    return sender.send(m);
  }

  /** Ask the browser to allow pop-ups (after a click) and switch them on when it does. */
  async enableDesktop(): Promise<ReturnType<typeof desktopPermission>> {
    const answer = await askDesktop();
    if (answer === 'granted') this.set({ desktop: true });
    else this.#emit();
    return answer;
  }

  /** Who a token's bot is (Telegram's `getMe`). */
  async telegramBot(token: string): Promise<{ ok: true; username: string; name: string } | { ok: false; problem: Problem }> {
    const outcome = telegramOutcome(await this.#transport.request(telegramMe(token)));
    if (!outcome.ok) return outcome;
    const bot = botOf(outcome.result);
    return bot ? { ok: true, ...bot } : { ok: false, problem: 'answer' };
  }

  /** The person's chat with the bot: whoever pressed Start in it within the last quarter of an hour. */
  async telegramChat(token: string): Promise<{ ok: true; id: string; name: string } | { ok: false; problem: Problem | 'none' }> {
    const outcome = telegramOutcome(await this.#transport.request(telegramUpdates(token)));
    if (!outcome.ok) return outcome;
    const chat = chatOf(outcome.result, Date.now());
    return chat ? { ok: true, ...chat } : { ok: false, problem: 'none' };
  }

  #senders(ids: readonly ChannelId[]): Sender[] {
    const s = this.#s, out: Sender[] = [];
    for (const id of ids) {
      if (id === 'desktop') out.push({ id, send: m => Promise.resolve(popUp(m)) });
      else if (id === 'telegram' && s.telegram.token && s.telegram.chat) {
        const { token, chat } = s.telegram;
        out.push({ id, send: async m => telegramOutcome(await this.#transport.request(telegramSend(token, chat, m, t('Open chart')))) });
      } else if (id === 'ntfy' && s.ntfy.topic) {
        const { server, topic } = s.ntfy;
        out.push({ id, send: async m => ntfyOutcome(await this.#transport.request(ntfySend(server, topic, m))) });
      } else if (id === 'discord' && s.discord.url) {
        const { url } = s.discord;
        out.push({ id, send: async m => discordOutcome(await this.#transport.request(discordSend(url, m))) });
      }
    }
    return out;
  }
}

function safeStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
