/**
 * Where the page's alerts go besides a sound (Karl, 2026-11-26: an alarm for a price or an area with "a popup on pc or/and smartphones", and
 * Telegram if the browser can do it): a pop-up on this computer, and messages to the person's own Telegram bot, ntfy topic or Discord
 * webhook. The browser sends them itself; no server of the page watches anyone's alerts or holds their addresses.
 *
 * Kept in this browser under a key of its own (`NOTIFY_KEY`), never in the page's settings, a layout or a backup (backup.ts leaves
 * `notifyKey` keys out, as it does Plus's): a bot's token, a webhook's address and an ntfy topic let anyone who has them send messages there.
 * Pure but for `loadNotify`/`saveNotify` (tests/notify-settings.test.mts).
 */

export const NOTIFY_KEY = 'lmf.notify';
/** One of Notify's keys (`lmf.notify`, and any `lmf.notify.…` a later page adds): it belongs to this browser and never travels. */
export const notifyKey = (key: string): boolean => key === NOTIFY_KEY || key.startsWith(`${NOTIFY_KEY}.`);

/** A Telegram bot of the person's own (its token from BotFather), the chat it writes to, and the names shown for both. */
export interface TelegramChannel { on: boolean; token: string; chat: string; bot: string; name: string }
/** An ntfy server (ntfy.sh unless the person runs their own) and the topic the phone's ntfy app is subscribed to. */
export interface NtfyChannel { on: boolean; server: string; topic: string }
/** A Discord webhook (a channel's Integrations), whose address alone lets a page post there. */
export interface DiscordChannel { on: boolean; url: string }

export interface NotifySettings {
  /** The Notify switch: nothing is sent or popped up while it is off (Sounds goes its own way). */
  on: boolean;
  /** A pop-up on this computer (the browser's notification, which the system shows). */
  desktop: boolean;
  telegram: TelegramChannel;
  ntfy: NtfyChannel;
  discord: DiscordChannel;
  /**
   * What is sent: the bells on drawings (on at first), scripts' `alert` calls and the panels' alerts switched on in Sounds (off at first). A
   * tab in the background was measured to keep reading prices, which is all a bell needs (2026-11-26, Research_Findings.md); the scripts and
   * the panels lean on more of the page, so they are each person's choice. Open interest's alert is never sent: a hidden page drops its
   * readings (hub.ts `#oiPush`).
   */
  send: { bells: boolean; scripts: boolean; panels: boolean };
}

export const NTFY_SERVER = 'https://ntfy.sh';

export const notifyDefaults = (): NotifySettings => ({
  on: false, desktop: false,
  telegram: { on: false, token: '', chat: '', bot: '', name: '' },
  ntfy: { on: false, server: NTFY_SERVER, topic: '' },
  discord: { on: false, url: '' },
  send: { bells: true, scripts: false, panels: false },
});

/** A bot token as BotFather gives it: the bot's number, a colon, then its secret. */
export const TELEGRAM_TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
/** A chat's id: a person's or a group's number (a group's is negative). */
export const TELEGRAM_CHAT = /^-?\d{1,20}$/;
/** A bot's username, which Telegram keeps to letters, digits and underscores. */
const TELEGRAM_BOT = /^[A-Za-z0-9_]{3,64}$/;
/** A topic: what ntfy accepts in a topic's name. */
export const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
/** A Discord webhook's address (discord.com, or the older discordapp.com, with its id and token). */
export const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}$/;

/**
 * An ntfy server's address, tidied: https anywhere, plain http only on this computer (a server of the person's own), no path, query or
 * trailing slash. Null for anything else.
 */
export function ntfyServer(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

const text = (v: unknown, max: number): string => typeof v === 'string' ? v.slice(0, max) : '';
const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/**
 * What was kept, checked field by field: anything malformed falls back to its default, and a channel without what it needs (a token and a
 * chat, a topic, a webhook) cannot be on.
 */
export function readNotify(raw: unknown): NotifySettings {
  const d = notifyDefaults(), s = record(raw), tg = record(s.telegram), nt = record(s.ntfy), dc = record(s.discord), send = record(s.send);
  const token = text(tg.token, 200), chat = text(tg.chat, 40), bot = text(tg.bot, 64);
  const telegram: TelegramChannel = {
    token: TELEGRAM_TOKEN.test(token) ? token : '',
    chat: TELEGRAM_CHAT.test(chat) ? chat : '',
    bot: TELEGRAM_BOT.test(bot) ? bot : '',
    name: text(tg.name, 64),
    on: false,
  };
  telegram.on = flag(tg.on, false) && telegram.token !== '' && telegram.chat !== '';
  const server = ntfyServer(text(nt.server, 300)) ?? d.ntfy.server, topic = text(nt.topic, 64);
  const ntfy: NtfyChannel = { server, topic: NTFY_TOPIC.test(topic) ? topic : '', on: false };
  ntfy.on = flag(nt.on, false) && ntfy.topic !== '';
  const url = text(dc.url, 300);
  const discord: DiscordChannel = { url: DISCORD_WEBHOOK.test(url) ? url : '', on: false };
  discord.on = flag(dc.on, false) && discord.url !== '';
  return {
    on: flag(s.on, d.on), desktop: flag(s.desktop, d.desktop), telegram, ntfy, discord,
    send: { bells: flag(send.bells, d.send.bells), scripts: flag(send.scripts, d.send.scripts), panels: flag(send.panels, d.send.panels) },
  };
}

/** Whether a phone channel is ready to send (on, and holding what it needs). */
export const phoneChannels = (s: NotifySettings): ('telegram' | 'ntfy' | 'discord')[] =>
  (['telegram', 'ntfy', 'discord'] as const).filter(id => readNotify(s)[id].on);

/**
 * A topic nobody would guess and a person can still type into the ntfy app: "lmf-" and 12 letters and digits that cannot be mistaken for one
 * another (no 0/o, 1/l/i), about 60 bits. A topic on ntfy.sh is open to anyone who knows its name, so its name is the secret.
 */
export function newTopic(random: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789', bytes = random(12);
  let out = 'lmf-';
  for (const b of bytes) out += letters[b % letters.length];
  return out;
}

/** The settings this browser keeps (the defaults where it keeps none, or will not say). */
export function loadNotify(storage: Pick<Storage, 'getItem'> | null): NotifySettings {
  try { const raw = storage?.getItem(NOTIFY_KEY); return raw ? readNotify(JSON.parse(raw)) : notifyDefaults(); }
  catch { return notifyDefaults(); }
}

/** Keep the settings; false when the browser refused (full, or storage switched off). */
export function saveNotify(storage: Pick<Storage, 'setItem'> | null, s: NotifySettings): boolean {
  try { storage?.setItem(NOTIFY_KEY, JSON.stringify(readNotify(s))); return storage !== null; } catch { return false; }
}
