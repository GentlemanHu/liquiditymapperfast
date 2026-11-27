/**
 * The requests each phone channel takes and what its answers mean (pure, tests/notify-channels.test.mts). Every one of these services answers
 * a web page directly (checked 2026-11-26: each sends Access-Control-Allow-Origin), so the browser sends them itself; the requests go out
 * from a worker of their own (send.worker.ts), so an address that holds a token is never in the page's own list of requests.
 *
 * Telegram refuses the question a browser asks before a request it does not count as simple (its answer is 501), so it is only ever sent a
 * GET or a form: never JSON or a header of the page's own.
 */

export interface Request { url: string; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }
/** What came back: the HTTP status (0 when nothing did) and the start of the body. */
export interface Answer { status: number; text: string; error?: 'timeout' | 'network' | 'refused' }
/** How a send or a question went: done, or why not in a word a person can be shown (`problemText`), and how long to wait when told to. */
export type Outcome = { ok: true } | { ok: false; problem: Problem; retryAfterMs?: number };
export type Problem = 'timeout' | 'network' | 'token' | 'chat' | 'webhook' | 'topic' | 'busy' | 'conflict' | 'refused' | 'answer';

export const TELEGRAM_API = 'https://api.telegram.org';
const FORM = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };

/** A message as every channel sends it: a title, the text, and the chart's address to open from it. */
export interface Message { title: string; body: string; url: string }

// ---- Telegram ------------------------------------------------------------------------------------------------------------------

/** Who the bot is: answers its username and name, or 401 for a token Telegram does not know. */
export const telegramMe = (token: string): Request => ({ url: `${TELEGRAM_API}/bot${token}/getMe`, method: 'GET' });
/** The messages people sent the bot lately (Telegram keeps them a day), from which the person's chat is found. */
export const telegramUpdates = (token: string): Request => ({ url: `${TELEGRAM_API}/bot${token}/getUpdates?limit=100&allowed_updates=%5B%22message%22%5D`, method: 'GET' });

/**
 * A message to the chat, with one button that opens the chart. The button's address is the public page's: Telegram may refuse a link to a
 * computer's own address (a page served from 127.0.0.1), and the message would then not be sent at all.
 */
export function telegramSend(token: string, chat: string, m: Message, button: string): Request {
  const fields: Record<string, string> = { chat_id: chat, text: `${m.title}\n${m.body}`, disable_web_page_preview: 'true' };
  if (/^https:\/\//.test(m.url)) fields.reply_markup = JSON.stringify({ inline_keyboard: [[{ text: button, url: m.url }]] });
  return { url: `${TELEGRAM_API}/bot${token}/sendMessage`, method: 'POST', headers: FORM, body: new URLSearchParams(fields).toString() };
}

interface TelegramReply { ok?: unknown; result?: unknown; description?: unknown; error_code?: unknown; parameters?: { retry_after?: unknown } }
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };

/** What Telegram's answer means. 401 is a token it does not know, 400 and 403 a chat it cannot write to, 409 a bot whose messages go to a webhook. */
export function telegramOutcome(a: Answer): Outcome & { result?: unknown } {
  if (a.error) return { ok: false, problem: a.error === 'timeout' ? 'timeout' : a.error === 'refused' ? 'refused' : 'network' };
  const r = parse(a.text) as TelegramReply | null;
  if (a.status >= 200 && a.status < 300 && r && r.ok === true) return { ok: true, result: r.result };
  if (a.status === 401 || a.status === 404) return { ok: false, problem: 'token' };
  if (a.status === 400 || a.status === 403) return { ok: false, problem: 'chat' };
  if (a.status === 409) return { ok: false, problem: 'conflict' };
  if (a.status === 429) {
    const after = Number(r?.parameters?.retry_after);
    return { ok: false, problem: 'busy', retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after, 3_600) * 1_000 : 30_000 };
  }
  return { ok: false, problem: a.status === 0 ? 'network' : 'answer' };
}

/** The bot's username and name from `getMe`'s result, or null. */
export function botOf(result: unknown): { username: string; name: string } | null {
  const r = result as { username?: unknown; first_name?: unknown; is_bot?: unknown } | null;
  if (!r || typeof r.username !== 'string' || r.is_bot !== true) return null;
  return { username: r.username, name: typeof r.first_name === 'string' ? r.first_name : r.username };
}

/**
 * The person's chat from `getUpdates`' result: the newest message sent to the bot in a private chat within the last `withinMs` (pressing Start
 * sends one), never an old one or a group's, so a bot shared with others is not taken to be one person's.
 */
export function chatOf(result: unknown, now: number, withinMs = 15 * 60_000): { id: string; name: string } | null {
  if (!Array.isArray(result)) return null;
  let best: { id: string; name: string; at: number } | null = null;
  for (const u of result) {
    const m = (u as { message?: { date?: unknown; chat?: { id?: unknown; type?: unknown; first_name?: unknown; username?: unknown } } } | null)?.message;
    const chat = m?.chat, at = typeof m?.date === 'number' ? m.date * 1_000 : Number.NaN;
    if (!chat || chat.type !== 'private' || typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id) || !(now - at <= withinMs) || at > now + 60_000) continue;
    const name = typeof chat.first_name === 'string' ? chat.first_name : typeof chat.username === 'string' ? chat.username : '';
    if (!best || at >= best.at) best = { id: String(chat.id), name: name.slice(0, 64), at };
  }
  return best ? { id: best.id, name: best.name } : null;
}

// ---- ntfy ----------------------------------------------------------------------------------------------------------------------

/** A message to an ntfy topic, published as JSON to the server's root (the way that carries any language's words in its title). */
export function ntfySend(server: string, topic: string, m: Message): Request {
  const body: Record<string, unknown> = { topic, title: m.title, message: m.body, priority: 4, tags: ['bell'] };
  if (/^https?:\/\//.test(m.url)) body.click = m.url;
  return { url: `${server}/`, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function ntfyOutcome(a: Answer): Outcome {
  if (a.error) return { ok: false, problem: a.error === 'timeout' ? 'timeout' : a.error === 'refused' ? 'refused' : 'network' };
  if (a.status >= 200 && a.status < 300) return { ok: true };
  if (a.status === 429) return { ok: false, problem: 'busy', retryAfterMs: 60_000 };
  if (a.status === 400 || a.status === 403 || a.status === 404) return { ok: false, problem: 'topic' };
  return { ok: false, problem: a.status === 0 ? 'network' : 'answer' };
}

// ---- Discord -------------------------------------------------------------------------------------------------------------------

/**
 * A message to a Discord webhook. Mentions are switched off (a label typed on a drawing must not ping a whole server), and the chart's address
 * is in angle brackets, which keeps Discord from adding a preview of the page to every alert.
 */
export function discordSend(url: string, m: Message): Request {
  const content = [m.title, m.body, m.url ? `<${m.url}>` : ''].filter(Boolean).join('\n').slice(0, 1_900);
  return { url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) };
}

export function discordOutcome(a: Answer): Outcome {
  if (a.error) return { ok: false, problem: a.error === 'timeout' ? 'timeout' : a.error === 'refused' ? 'refused' : 'network' };
  if (a.status >= 200 && a.status < 300) return { ok: true };
  if (a.status === 401 || a.status === 403 || a.status === 404) return { ok: false, problem: 'webhook' };
  if (a.status === 429) {
    const after = Number((parse(a.text) as { retry_after?: unknown } | null)?.retry_after);
    return { ok: false, problem: 'busy', retryAfterMs: Number.isFinite(after) && after > 0 ? Math.min(after, 3_600) * 1_000 : 30_000 };
  }
  return { ok: false, problem: a.status === 0 ? 'network' : 'answer' };
}
