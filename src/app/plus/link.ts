/**
 * The data link (2026-11-21): a member's Plus files read through a secret address that changes every 12 hours instead of with the pass, so
 * the edge keeps one copy of each file for every member and answers an unchanged one with a 304. The Plus server hands the link to a pass
 * (`GET <plusApi>/link`): `https://<levels host>/v1/k/<token>/`, under which the levels service serves, without a pass, what it serves under
 * `/v1/` for the Plus files (`plus/<coin>/…`) and the history days (`<coin>/liquidation-history/<day>.json`). The address is the secret: it
 * is held in this tab's memory alone, never stored, logged or written into an error.
 *
 * A read with a pass of such a file goes through the link, with no `Authorization` header (so no CORS preflight) and the browser's
 * revalidation (`webFetch` asks with `no-cache`). Every other read, and every way the link can fail, goes the old way with the pass: no link
 * to be had, a link refused twice, a file on another origin than the link's (a local stand-in), a link that cannot be reached.
 */
import type { LiqAnswer, LiqFetch } from '../liq-history.ts';
import { freeFrom, plusApi } from './config.ts';
import { withTimeout } from './request-timeout.ts';

/**
 * A link is given up this long before the server said its slot ends, and the next one asked for, so the tabs move to it together. One that
 * came with less than this left is kept until its slot ends: asked again sooner, the server would hand out the same link for every read.
 */
export const LINK_EARLY_MS = 2 * 60_000;
/** Nor is a link kept longer than its slot (12 hours), whatever the server said. */
export const LINK_LONGEST_MS = 12 * 3_600_000;
/** After a request for a link failed (no answer, a busy or broken server, an answer of the wrong shape), none is asked for this long. */
export const LINK_FAILED_MS = 5 * 60_000;
/** A wait the server names (`Retry-After`) replaces that one, kept within these bounds. */
export const LINK_WAIT_MIN_MS = 30_000, LINK_WAIT_MAX_MS = 15 * 60_000;
/** After the server refused a link to a pass (a 403), none is asked for with that pass for this long: a burst of reads asks once. */
export const LINK_REFUSED_MS = 60_000;
/** A request for a link is given up after this long: the paid read that asked waits for it. */
export const LINK_TIMEOUT_MS = 10_000;

/** What the server hands out: the link, the end of its slot, and the server's clock when it answered (ms). */
export interface LinkGrant { base: string; until: number; now: number }

/** A link's path: `/v1/k/` and 43 characters of base64url (the token), ending in a slash. */
const LINK_PATH = /^\/v1\/k\/[A-Za-z0-9_-]{43}\/$/;

/**
 * The server's answer, checked: a link on https (on http only at localhost or 127.0.0.1, for local work) with no user, query or fragment and
 * the path `/v1/k/<token>/`, and a slot that ends after the server's clock. Null for anything else. The link is kept as the URL parser writes it.
 */
export function readLink(raw: unknown): LinkGrant | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { base?: unknown; until?: unknown; now?: unknown };
  if (typeof o.base !== 'string' || typeof o.until !== 'number' || typeof o.now !== 'number' || !Number.isFinite(o.until) || !Number.isFinite(o.now) || !(o.until > o.now)) return null;
  // A bare `?` or `#` leaves the parsed query and fragment empty: the text itself must hold neither.
  if (o.base.length > 512 || /[?#]/.test(o.base)) return null;
  let url: URL;
  try { url = new URL(o.base); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return LINK_PATH.test(url.pathname) ? { base: url.href, until: o.until, now: o.now } : null;
}

/** A request for a link with a pass: its status, its body (JSON, or null), and the wait the server named (`Retry-After`, s). No answer rejects. */
export type LinkRequest = (url: string, pass: string) => Promise<{ status: number; body: unknown; retryAfter?: number }>;

/** The page's request for a link: the pass as a bearer token, never cached, given up after `LINK_TIMEOUT_MS`. The Plus server names its waits in seconds. */
export const webLinkRequest: LinkRequest = (url, pass) => withTimeout(async signal => {
  const answer = await fetch(url, { headers: { authorization: `Bearer ${pass}` }, cache: 'no-store', signal });
  let body: unknown = null;
  try { body = await answer.json(); } catch (error) {
    // Given up while the body was read: no answer at all, as when the request never came back.
    if (signal.aborted) throw signal.reason ?? error;
    /* an answer without a JSON body says enough with its status */
  }
  const wait = answer.headers.get('retry-after')?.trim() ?? '';
  return { status: answer.status, body, ...(/^\d{1,9}$/.test(wait) ? { retryAfter: Number(wait) } : {}) };
}, undefined, LINK_TIMEOUT_MS);

/** Where links come from: the tab's `DataLink`, or a test's stand-in. */
export interface LinkSource {
  /** The link to read through, or null when there is none to be had now (the old way, then). Never rejects. */
  get(pass: string): Promise<string | null>;
  /**
   * The levels service refused `base`: it is forgotten if it is the link held. `quiet`: refused again, so no link is asked for a while, and
   * `base` is not taken back meanwhile from a request already on its way.
   */
  drop(base: string, quiet?: boolean): void;
}

/** A stretch of this tab's clock, `from` included and `until` not: a clock set back before `from` ends it too. */
interface Span { from: number; until: number }
const inside = (span: Span | null, now: number): boolean => span !== null && now >= span.from && now < span.until;
/** The wait after a failed request: the server's (`Retry-After`, s) within the bounds, else `LINK_FAILED_MS`. */
const failedWait = (seconds: number | undefined): number =>
  seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? Math.min(LINK_WAIT_MAX_MS, Math.max(LINK_WAIT_MIN_MS, seconds * 1_000)) : LINK_FAILED_MS;

/**
 * The tab's link, asked for when a paid read needs one, one request at a time (every caller meanwhile waits for the same answer). It is kept
 * for the life the server gave it, measured from the server's own clock (`until - now`) and counted on this tab's clock from when it was asked,
 * so a page clock that is off by hours or days keeps it just as long. A request that failed, or a link that ran out on its way, makes every
 * caller go the old way for a while without asking again; so does a refused pass, for that pass.
 */
export class DataLink implements LinkSource {
  /** The link held, and the stretch of this tab's clock it is used in. */
  #held: (Span & { base: string }) | null = null;
  /** The request on its way. */
  #asking: Promise<string | null> | null = null;
  /** No link is asked for in this stretch (a request that failed, a link that ran out on its way, or a link refused again). */
  #quiet: Span | null = null;
  /** The link refused again, and the stretch in which it is not taken from an answer (one asked for before it was dropped can bring it back). */
  #dropped: (Span & { base: string }) | null = null;
  /** The pass the server last refused a link to, and the stretch in which no link is asked for with it. */
  #refused: (Span & { pass: string }) | null = null;

  constructor(private api: () => string = () => plusApi(), private request: LinkRequest = webLinkRequest, private now: () => number = Date.now) {}

  get(pass: string): Promise<string | null> {
    const now = this.now(), held = this.#held;
    if (held && inside(held, now)) return Promise.resolve(held.base);
    this.#held = null;
    if (this.#asking) return this.#asking;
    if (inside(this.#quiet, now) || (this.#refused?.pass === pass && inside(this.#refused, now))) return Promise.resolve(null);
    // Cleared before its answer reaches the callers, so a caller that asks again at once (after a refusal) starts a new request.
    const asking: Promise<string | null> = this.#ask(pass, now).finally(() => { if (this.#asking === asking) this.#asking = null; });
    this.#asking = asking;
    return asking;
  }

  drop(base: string, quiet = false): void {
    // A newer link is held: the refusal was of one already replaced.
    if (this.#held && this.#held.base !== base) return;
    this.#held = null;
    if (quiet) this.#dropped = { base, ...this.#quietFor(LINK_FAILED_MS) };
  }

  /**
   * No link is asked for during the next `ms` at least: the stretch. One under way is only ever lengthened, so an answer to a request asked
   * for before it began (a failure, a link that ran out on its way) does not cut short a link refused again.
   */
  #quietFor(ms: number): Span {
    const at = this.now(), quiet = this.#quiet;
    return this.#quiet = quiet && inside(quiet, at) ? { from: quiet.from, until: Math.max(quiet.until, at + ms) } : { from: at, until: at + ms };
  }

  async #ask(pass: string, asked: number): Promise<string | null> {
    let answer: Awaited<ReturnType<LinkRequest>>;
    try { answer = await this.request(`${this.api()}/link`, pass); } catch { this.#quietFor(LINK_FAILED_MS); return null; }
    const at = this.now();
    if (answer.status === 403) { this.#refused = { pass, from: at, until: at + LINK_REFUSED_MS }; return null; }
    const grant = answer.status === 200 ? readLink(answer.body) : null;
    if (!grant) { this.#quietFor(failedWait(answer.retryAfter)); return null; }
    // The link refused again, brought back by a request asked for before it was dropped: not taken while its quiet stretch lasts.
    if (this.#dropped?.base === grant.base && inside(this.#dropped, at)) return null;
    // Counted from when it was asked: the server's clock read `now` after that, so the link never outlives what the server said.
    const life = grant.until - grant.now, until = asked + Math.min(LINK_LONGEST_MS, life > LINK_EARLY_MS ? life - LINK_EARLY_MS : life);
    // One that ran out on its way (a slow answer, or a server whose times are off) is not held: this read goes the old way, and none is asked
    // for a moment, so the reads that follow do not each ask again.
    if (until <= at) { this.#quietFor(LINK_WAIT_MIN_MS); return null; }
    this.#held = { base: grant.base, from: asked, until };
    return grant.base;
  }
}

let shared: DataLink | null = null;
/** The tab's one link, shared by every read of the levels service (made at its first use). */
export function dataLink(): DataLink { return shared ??= new DataLink(); }

/** The part after `/v1/` of a Plus file's path: `plus/<coin>/<name>.json`, or a dated one under `<name>/`, as the levels service names them. */
const PLUS_FILE = /^\/v1\/(plus\/[a-z0-9]{1,12}\/[a-z0-9-]+(?:\/\d{4}-\d{2}-\d{2})?\.json)$/;
/** The same of a history day's: `<coin>/liquidation-history/<YYYY-MM-DD>.json`. */
const HISTORY_DAY = /^\/v1\/([a-z0-9]{1,12}\/liquidation-history\/(\d{4})-(\d{2})-(\d{2})\.json)$/;

/**
 * Where a file read with a pass is found under a link: its origin, and the part of its path after `/v1/`; or null when it is not read through
 * one. A Plus file is; so is a history day that starts before `freeFrom(now)` (the free days are everyone's, read without a pass). An address
 * with a query, a fragment or a user never is: the service names none.
 */
export function linkable(url: string, now: number): { origin: string; rest: string } | null {
  if (/[?#]/.test(url)) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
  // Read from the parsed path, so nothing but the service's own names reaches the link.
  const plusFile = PLUS_FILE.exec(u.pathname);
  if (plusFile) return { origin: u.origin, rest: plusFile[1]! };
  const day = HISTORY_DAY.exec(u.pathname);
  if (!day) return null;
  const start = Date.UTC(Number(day[2]), Number(day[3]) - 1, Number(day[4]));
  // A day that is not on the calendar (2026-02-30) is not one the service names.
  if (new Date(start).toISOString().slice(0, 10) !== `${day[2]}-${day[3]}-${day[4]}`) return null;
  return start < freeFrom(now) ? { origin: u.origin, rest: day[1]! } : null;
}

const originOf = (base: string): string => { try { return new URL(base).origin; } catch { return ''; } };

/** How `withLink` tells the gate's refusal (`isRefusal` of `liq-history.ts`), and the page's clock for which days are free. */
export interface LinkOptions { refusal(answer: LiqAnswer): boolean; now?: () => number }

/**
 * `read` with a member's Plus files read through the link (`linkable`): fetched from the link with no pass, and the answer given as it is
 * (a file, a 404, a 503, …) unless it is the gate's refusal, or a 403 with no JSON. A refused link (it ran out, or the key behind it changed)
 * is dropped and a new one asked for once; a different one is tried once, and the same one again, or a second refusal, quiets the link for a
 * while. That, no link, a link on another origin than the file's, or one that cannot be reached, reads the file the old way with the pass,
 * whose refusal then says the pass is no good. A read without a pass is `read` itself, untouched.
 */
export function withLink(read: LiqFetch, link: LinkSource, opts: LinkOptions): LiqFetch {
  const now = opts.now ?? Date.now;
  const get = async (pass: string): Promise<string | null> => { try { return await link.get(pass); } catch { return null; } };
  /**
   * A read of `rest` through `base`: its answer, `refused` (the gate's refusal, or a 403 whose body is not JSON: a refusal cut short, or a
   * firewall's page, is no file either, and the link may be a stale one; Sol, review round 3), or `lost` (no answer).
   */
  const through = async (base: string, rest: string): Promise<LiqAnswer | 'refused' | 'lost'> => {
    try {
      const answer = await read(base + rest, null);
      return opts.refusal(answer) || (answer.status === 403 && answer.body === null) ? 'refused' : answer;
    } catch { return 'lost'; }
  };
  const viaLink = async (url: string, pass: string, at: { origin: string; rest: string }): Promise<LiqAnswer> => {
    const base = await get(pass);
    if (base === null || originOf(base) !== at.origin) return read(url, pass);
    const first = await through(base, at.rest);
    if (first === 'lost') return read(url, pass);
    if (first !== 'refused') return first;
    link.drop(base);
    const fresh = await get(pass);
    if (fresh === base) link.drop(base, true);
    if (fresh === null || fresh === base || originOf(fresh) !== at.origin) return read(url, pass);
    const second = await through(fresh, at.rest);
    if (second === 'refused') link.drop(fresh, true);
    return second === 'refused' || second === 'lost' ? read(url, pass) : second;
  };
  return (url, pass) => {
    if (!pass) return read(url, pass);
    const at = linkable(url, now());
    return at ? viaLink(url, pass, at) : read(url, pass);
  };
}
