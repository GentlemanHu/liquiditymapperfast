import type { Answer, Request } from './channels.ts';

/**
 * The phone channels' requests, sent from a worker of their own. A Telegram bot's token is part of the address it is asked at, and a page's
 * own list of requests (what anything running in the page can read, an analytics script included) would hold it; a worker's requests are
 * listed in the worker alone, which runs nothing else. Every request is sent without cookies, without the page's address, and without
 * following a redirect, and is given up after `TIMEOUT_MS`.
 */

const TIMEOUT_MS = 12_000;
const scope = self as unknown as { postMessage(message: { id: number; answer: Answer } | { ready: true }): void; onmessage: ((event: MessageEvent<{ id: number; req: Request }>) => void) | null };

/** https anywhere, plain http only to this computer (an ntfy server of the person's own). */
function allowed(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')); }
  catch { return false; }
}

async function send(id: number, req: Request): Promise<void> {
  if (!req || typeof req.url !== 'string' || !allowed(req.url) || (req.method !== 'GET' && req.method !== 'POST')) { scope.postMessage({ id, answer: { status: 0, text: '', error: 'refused' } }); return; }
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? req.body : undefined, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error', signal: stop.signal });
    const text = (await res.text()).slice(0, 16_000);
    scope.postMessage({ id, answer: { status: res.status, text } });
  } catch (error) {
    scope.postMessage({ id, answer: { status: 0, text: '', error: (error as { name?: string } | null)?.name === 'AbortError' ? 'timeout' : 'network' } });
  } finally { clearTimeout(timer); }
}

scope.onmessage = event => { const { id, req } = event.data ?? {}; if (typeof id === 'number') void send(id, req); };
// Said once the script runs: the page counts a request's time from here, not from when it asked for this worker (transport.ts).
scope.postMessage({ ready: true });
