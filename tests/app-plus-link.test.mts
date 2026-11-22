// The data link (src/app/plus/link.ts): which reads go through it, how a tab holds it (one request at a time, its life by the server's clock,
// a quiet spell after a failure or a refusal), and how a refused or unreachable link falls back to the old path with the pass. Fake Plus
// servers and levels services on a virtual clock; two tests go through the page's own fetch, stubbed. Nothing reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLink, LINK_EARLY_MS, LINK_FAILED_MS, LINK_LONGEST_MS, LINK_REFUSED_MS, LINK_WAIT_MAX_MS, LINK_WAIT_MIN_MS, linkable, readLink, withLink, type LinkRequest } from '../src/app/plus/link.ts';
import { DAY_MS, PLUS_API, freeFrom } from '../src/app/plus/config.ts';
import { LiqHistory, MAX_DAYS, dayText, isRefusal, webFetch, type LiqAnswer, type LiqFetch } from '../src/app/liq-history.ts';
import { LiqLevelsSource } from '../src/app/liq-levels.ts';
import { FREE_VIEW, type LiqView } from '../src/app/liq-view.ts';
import { BTC } from '../src/shared/coins.ts';

const MIN = 60_000, HOUR = 3_600_000;
const LEVELS = 'https://levels.hiverust.dev';
const API = 'https://plus.example.test/v1';
/** A made-up token of 43 characters, and the link it makes on an origin. */
const token = (c: string): string => c.repeat(43);
const linkOf = (c: string, origin = LEVELS): string => `${origin}/v1/k/${token(c)}/`;
const A = linkOf('a'), B = linkOf('b');
const TRIGGERS = `${LEVELS}/v1/plus/btc/triggers.json`, GROUPS = `${LEVELS}/v1/plus/btc/liquidations-groups.json`;
const OK: LiqAnswer = { status: 200, body: { v: 1 } };
const REFUSED: LiqAnswer = { status: 403, body: { error: 'plus_required' } };
const PASS = 'v1.member.sig';
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** The page's clock, moved by the test. */
function clock(t = Date.UTC(2026, 10, 21, 9)): { t: number; now: () => number } {
  const c = { t, now: () => c.t };
  return c;
}
type LinkAnswer = Awaited<ReturnType<LinkRequest>>;
/** The Plus server's link: `base`, its slot ending `life` after the server's clock `serverNow`. */
const grant = (base: string, serverNow: number, life = 6 * HOUR): LinkAnswer => ({ status: 200, body: { base, until: serverNow + life, now: serverNow } });
/** A Plus server answering the n-th request for a link (from 1) as `answer` says (`lost`: no answer), every request noted; `hold` keeps the answers back until `release`. */
function server(answer: (n: number, pass: string) => LinkAnswer | 'lost') {
  const asks: { url: string; pass: string }[] = [];
  let gate: Promise<void> | null = null, open = (): void => {};
  const request: LinkRequest = async (url, pass) => {
    asks.push({ url, pass });
    const n = asks.length;
    if (gate) await gate;
    const a = answer(n, pass);
    if (a === 'lost') throw new DOMException('no answer', 'TimeoutError');
    return a;
  };
  return { request, asks, hold: (): void => { gate = new Promise(r => { open = r; }); }, release: (): void => { open(); gate = null; } };
}
/** A levels service as `read` sees it: an answer by address (`lost`: no answer, the read rejects), every read noted with its pass. */
function levels(answer: (url: string) => LiqAnswer | 'lost' | Promise<LiqAnswer | 'lost'>) {
  const reads: { url: string; pass: string | null | undefined }[] = [];
  const read: LiqFetch = async (url, pass) => {
    reads.push({ url, pass });
    const a = await answer(url);
    if (a === 'lost') throw new TypeError('no answer');
    return a;
  };
  return { read, reads };
}
/** The page's read through a link of its own (never the tab's shared one) on the clock `c`. */
function linked(c: { now: () => number }, s: ReturnType<typeof server>, svc: ReturnType<typeof levels>) {
  const link = new DataLink(() => API, s.request, c.now);
  return { link, read: withLink(svc.read, link, { refusal: isRefusal, now: c.now }) };
}

test('a link is taken only in the shape the levels service serves: https (http on this machine), no user, query or fragment, /v1/k/<43 characters>/', () => {
  const at = Date.UTC(2026, 10, 21, 9);
  const read = (base: unknown, until: unknown = at + HOUR, now: unknown = at): ReturnType<typeof readLink> => readLink({ base, until, now });
  assert.deepEqual(read(A), { base: A, until: at + HOUR, now: at });
  assert.equal(read(linkOf('c', 'http://127.0.0.1:8790'))?.base, linkOf('c', 'http://127.0.0.1:8790'), 'local work');
  assert.equal(read(linkOf('c', 'http://localhost:8790'))?.base, linkOf('c', 'http://localhost:8790'));
  assert.equal(read(`https://LEVELS.hiverust.dev:443/v1/k/${token('c')}/`)?.base, linkOf('c'), 'kept as the URL parser writes it');
  for (const bad of [
    linkOf('a', 'http://levels.hiverust.dev'), linkOf('a', 'http://192.168.1.2:8790'), linkOf('a', 'ftp://levels.hiverust.dev'),
    `${A}?`, `${A}#`, `${A}?k=1`, `${A}#k`,
    linkOf('a', 'https://user:secret@levels.hiverust.dev'), linkOf('a', 'https://user@levels.hiverust.dev'),
    `${LEVELS}/v1/k/${'a'.repeat(42)}/`, `${LEVELS}/v1/k/${'a'.repeat(44)}/`, `${LEVELS}/v1/k/${'a'.repeat(42)}+/`, `${LEVELS}/v1/k/${'a'.repeat(40)}%2B/`,
    `${LEVELS}/v1/k/${token('a')}`, `${LEVELS}/x/v1/k/${token('a')}/`, `${A}plus/`, `${LEVELS}/v2/k/${token('a')}/`, 'not a link', '',
  ]) assert.equal(read(bad), null, bad);
  assert.equal(read(A, at, at), null, 'a slot that has ended');
  assert.equal(read(A, at - 1, at), null);
  for (const until of [Infinity, NaN, String(at + HOUR), null]) assert.equal(read(A, until, at), null, String(until));
  assert.equal(readLink({ base: A, until: at + HOUR }), null, 'no server clock');
  assert.equal(read(A, at + HOUR, String(at)), null);
  for (const raw of [null, undefined, 'x', 42, [A], {}]) assert.equal(readLink(raw), null, JSON.stringify(raw));
});

test('what goes through the link: the Plus files and a history day before the free week; never a free day, the free files, a query or a fragment', () => {
  const now = Date.UTC(2026, 10, 21, 9), free = freeFrom(now);
  assert.equal(dayText(free), '2026-11-14');
  assert.deepEqual(linkable(TRIGGERS, now), { origin: LEVELS, rest: 'plus/btc/triggers.json' });
  for (const name of ['liquidations-groups.json', 'triggers-groups.json', 'liquidation-history-4h.json', 'trigger-history-groups-4h.json', 'liquidation-history-groups/2026-11-20.json', 'trigger-history/2026-10-01.json'])
    assert.deepEqual(linkable(`${LEVELS}/v1/plus/btc/${name}`, now), { origin: LEVELS, rest: `plus/btc/${name}` }, name);
  assert.deepEqual(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-11-13.json`, now), { origin: LEVELS, rest: 'btc/liquidation-history/2026-11-13.json' }, 'the newest paid day');
  assert.deepEqual(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-10-01.json`, now)?.rest, 'btc/liquidation-history/2026-10-01.json');
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-11-14.json`, now), null, 'the oldest free day');
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidation-history/${dayText(now)}.json`, now), null, 'today');
  // The free week moves at midnight UTC: the oldest free day turns paid a moment later.
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-11-14.json`, Date.UTC(2026, 10, 21, 23, 59)), null);
  assert.ok(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-11-14.json`, Date.UTC(2026, 10, 22)));
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidations.json`, now), null, 'the free levels file');
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidation-history.json`, now), null, 'the history index');
  for (const odd of [`${TRIGGERS}?k=1`, `${TRIGGERS}?`, `${TRIGGERS}#k`, `${TRIGGERS}#`, `${LEVELS}/v1/btc/liquidation-history/2026-10-01.json?v=2`])
    assert.equal(linkable(odd, now), null, `${odd}: a query or a fragment`);
  assert.equal(linkable(`${LEVELS}/v1/btc/liquidation-history/2026-02-30.json`, now), null, 'not on the calendar');
  assert.equal(linkable(`${LEVELS}/v1/plus/BTC/triggers.json`, now), null, 'the service names coins in lower case');
  assert.equal(linkable(`${LEVELS}/v1/plus/btc/triggers.json.gz`, now), null);
  assert.equal(linkable(`${LEVELS}/v1/plus/btc/x/y/triggers.json`, now), null);
  assert.equal(linkable(`${LEVELS}/v2/plus/btc/triggers.json`, now), null);
  assert.equal(linkable(`${LEVELS}/v1/plus/../k/${token('z')}/plus/btc/triggers.json`, now), null, 'read as the parser writes the path: climbing out of it lands nowhere linked');
  assert.equal(linkable(`https://user:secret@levels.hiverust.dev/v1/plus/btc/triggers.json`, now), null);
  assert.equal(linkable('not a url', now), null);
  assert.deepEqual(linkable('http://127.0.0.1:8790/v1/plus/btc/triggers.json', now), { origin: 'http://127.0.0.1:8790', rest: 'plus/btc/triggers.json' }, 'a local stand-in: its own origin');
});

test('a read without a pass, or of a file no link serves, is the read itself, at once and with the same arguments: no link asked for', () => {
  const c = clock(), s = server(() => grant(A, c.t)), svc = levels(() => OK), { read } = linked(c, s, svc);
  void read(TRIGGERS, null); void read(TRIGGERS, undefined); void read(TRIGGERS, ''); void read(TRIGGERS);
  void read(`${LEVELS}/v1/btc/liquidations.json`, PASS); void read(`${LEVELS}/v1/btc/liquidation-history/${dayText(c.t)}.json`, PASS);
  assert.deepEqual(svc.reads, [{ url: TRIGGERS, pass: null }, { url: TRIGGERS, pass: undefined }, { url: TRIGGERS, pass: '' }, { url: TRIGGERS, pass: undefined },
    { url: `${LEVELS}/v1/btc/liquidations.json`, pass: PASS }, { url: `${LEVELS}/v1/btc/liquidation-history/${dayText(c.t)}.json`, pass: PASS }], 'read before anything is awaited');
  assert.equal(s.asks.length, 0);
});

test('a member\'s Plus file is read from the link without the pass, and whatever the link answers but the gate\'s refusal is the read\'s answer', async () => {
  const c = clock(), s = server(() => grant(A, c.t + 3 * DAY_MS));
  const answers: Record<string, LiqAnswer> = {
    [`${A}plus/btc/triggers.json`]: OK, [`${A}plus/btc/triggers-groups.json`]: { status: 404, body: null },
    [`${A}plus/btc/liquidations-groups.json`]: { status: 503, body: null, retryAfter: 120 }, [`${A}btc/liquidation-history/2026-10-01.json`]: { status: 200, body: { rows: [] } },
    [`${A}plus/btc/trigger-history/2026-11-20.json`]: { status: 403, body: { error: 'forbidden' } },
  };
  const svc = levels(url => answers[url] ?? { status: 500, body: null }), { read } = linked(c, s, svc);
  assert.deepEqual(await read(TRIGGERS, PASS), OK);
  assert.deepEqual(await read(`${LEVELS}/v1/plus/btc/triggers-groups.json`, PASS), { status: 404, body: null }, 'a 404 is the file\'s answer');
  assert.deepEqual(await read(GROUPS, PASS), { status: 503, body: null, retryAfter: 120 }, 'a 503 and its wait');
  assert.deepEqual(await read(`${LEVELS}/v1/btc/liquidation-history/2026-10-01.json`, PASS), { status: 200, body: { rows: [] } }, 'a paid history day');
  assert.deepEqual(await read(`${LEVELS}/v1/plus/btc/trigger-history/2026-11-20.json`, PASS), { status: 403, body: { error: 'forbidden' } }, 'another 403 (a firewall\'s) is no refusal');
  assert.deepEqual(s.asks, [{ url: `${API}/link`, pass: PASS }], 'one link for all of them');
  assert.ok(svc.reads.every(r => r.pass === null && r.url.startsWith(A)), 'no pass sent, nothing read the old way');
  // A file on another origin than the link's (a local stand-in, `?levels=`): the old way with the pass.
  assert.deepEqual(await read('http://127.0.0.1:8790/v1/plus/btc/triggers.json', PASS), { status: 500, body: null });
  assert.deepEqual(svc.reads.at(-1), { url: 'http://127.0.0.1:8790/v1/plus/btc/triggers.json', pass: PASS });
});

test('one request for a link at a time: every read that needs one meanwhile waits for the same answer', async () => {
  const c = clock(), s = server(() => grant(A, c.t)), svc = levels(() => OK), { read, link } = linked(c, s, svc);
  s.hold();
  const files = ['triggers.json', 'triggers-groups.json', 'liquidations-groups.json', 'trigger-history/2026-11-20.json', 'liquidation-history-groups-4h.json'].map(n => `${LEVELS}/v1/plus/btc/${n}`)
    .concat([`${LEVELS}/v1/btc/liquidation-history/2026-10-01.json`, `${LEVELS}/v1/btc/liquidation-history/2026-10-02.json`]);
  const all = Promise.all([...files.map(u => read(u, PASS)), ...Array.from({ length: 240 }, (_, i) => link.get(i % 2 ? PASS : 'another.pass'))]);
  await tick();
  assert.equal(s.asks.length, 1, 'one request, whatever the pass'); assert.equal(svc.reads.length, 0, 'nothing read before the link came');
  s.release();
  const got = await all;
  assert.ok(got.slice(files.length).every(b => b === A));
  assert.equal(s.asks.length, 1);
  assert.deepEqual(svc.reads.map(r => r.url).sort(), files.map(u => u.replace(`${LEVELS}/v1/`, A)).sort());
});

test('a link is kept for the life the server gave it, counted by the server\'s clock, however far off the page\'s clock is', async () => {
  for (const off of [0, -3 * DAY_MS, 2 * DAY_MS, 40 * MIN, -7 * MIN]) {
    // The page's clock is `off` ahead of the server's.
    const c = clock(), s = server(() => grant(A, c.t - off)), link = new DataLink(() => API, s.request, c.now), asked = c.t;
    assert.equal(await link.get(PASS), A);
    c.t = asked + 6 * HOUR - LINK_EARLY_MS - 1;
    assert.equal(await link.get(PASS), A); assert.equal(s.asks.length, 1, `${off}: held until two minutes before its slot ends`);
    c.t = asked + 6 * HOUR - LINK_EARLY_MS;
    assert.equal(await link.get(PASS), A); assert.equal(s.asks.length, 2, `${off}: then asked for again`);
  }
});

test('a link with less than two minutes left is kept to its slot\'s end, none longer than a slot, and a clock set back asks again', async () => {
  const c = clock();
  let life = 90_000;
  const s = server(() => grant(A, c.t, life)), link = new DataLink(() => API, s.request, c.now), t0 = c.t;
  await link.get(PASS);
  c.t = t0 + 89_999; await link.get(PASS);
  assert.equal(s.asks.length, 1, 'not asked for again by every read of its last two minutes');
  life = 12 * HOUR; c.t = t0 + 90_000; await link.get(PASS);
  assert.equal(s.asks.length, 2, 'asked for once its slot is over');
  // A server that says more than a slot: kept for a slot.
  life = 3 * DAY_MS; c.t += 12 * HOUR; await link.get(PASS);
  assert.equal(s.asks.length, 3);
  const t1 = c.t;
  c.t = t1 + LINK_LONGEST_MS - 1; await link.get(PASS); assert.equal(s.asks.length, 3);
  c.t = t1 + LINK_LONGEST_MS; await link.get(PASS); assert.equal(s.asks.length, 4);
  // The page's clock set back before the link was asked for: asked for again, not kept for the hours the clock went back.
  c.t -= HOUR; await link.get(PASS);
  assert.equal(s.asks.length, 5);
});

test('a refused link is dropped and a new one asked for once; a different one is tried, and its answer is the read\'s', async () => {
  const c = clock(), s = server(n => grant(n === 1 ? A : B, c.t)), svc = levels(url => url.startsWith(A) ? REFUSED : OK), { read } = linked(c, s, svc);
  assert.deepEqual(await read(TRIGGERS, PASS), OK);
  assert.deepEqual(svc.reads, [{ url: `${A}plus/btc/triggers.json`, pass: null }, { url: `${B}plus/btc/triggers.json`, pass: null }]);
  assert.equal(s.asks.length, 2);
  // The new link is held: the next read goes straight to it.
  assert.deepEqual(await read(GROUPS, PASS), OK);
  assert.equal(s.asks.length, 2); assert.deepEqual(svc.reads.at(-1), { url: `${B}plus/btc/liquidations-groups.json`, pass: null });
});

test('a second refusal, or the same link handed out again, reads the old way with the pass and keeps the link quiet for five minutes', async () => {
  for (const again of ['another link', 'the same link']) {
    const c = clock(), s = server(n => grant(n === 1 || again === 'the same link' ? A : B, c.t));
    let refusing = true;
    const svc = levels(url => refusing && (url.startsWith(A) || url.startsWith(B)) ? REFUSED : OK), { read } = linked(c, s, svc);
    assert.deepEqual(await read(TRIGGERS, PASS), OK, again);
    assert.deepEqual(svc.reads.at(-1), { url: TRIGGERS, pass: PASS }, `${again}: the old way, with the pass`);
    assert.equal(svc.reads.length, again === 'another link' ? 3 : 2, `${again}: each link tried once`);
    assert.equal(s.asks.length, 2);
    // The next reads cost neither the Plus server nor the link: each would be a refusal and a request more.
    const reads = svc.reads.length;
    c.t += LINK_FAILED_MS - 1;
    await read(TRIGGERS, PASS); await read(GROUPS, PASS); await read(GROUPS, 'another.pass');
    assert.equal(s.asks.length, 2, `${again}: no link asked for`);
    assert.deepEqual(svc.reads.slice(reads), [{ url: TRIGGERS, pass: PASS }, { url: GROUPS, pass: PASS }, { url: GROUPS, pass: 'another.pass' }], `${again}: nothing read from a link`);
    // The levels service takes links again (it and the Plus server agree once more): after the five minutes, one is asked for and used.
    refusing = false; c.t += 1;
    assert.deepEqual(await read(TRIGGERS, PASS), OK);
    assert.equal(s.asks.length, 3, `${again}: asked for again after five minutes`);
    assert.equal(svc.reads.at(-1)!.pass, null, `${again}: and read from`);
  }
});

test('a read refused on a link already replaced goes to the new one, without asking the Plus server again', async () => {
  const c = clock(), s = server(n => grant(n === 1 ? A : B, c.t));
  let late = (): void => {};
  const lateRefusal = new Promise<LiqAnswer>(r => { late = () => r(REFUSED); });
  // Both reads go out on A; the first is refused at once, the second only once the first has moved to B.
  const svc = levels(url => url === `${A}plus/btc/triggers.json` ? REFUSED : url === `${A}plus/btc/liquidations-groups.json` ? lateRefusal : OK), { read } = linked(c, s, svc);
  const first = read(TRIGGERS, PASS), second = read(GROUPS, PASS);
  assert.deepEqual(await first, OK);
  assert.equal(s.asks.length, 2);
  late();
  assert.deepEqual(await second, OK);
  assert.equal(s.asks.length, 2, 'no third request: the refused link had been replaced');
  assert.deepEqual(svc.reads.filter(r => r.url.startsWith(B)).map(r => r.url), [`${B}plus/btc/triggers.json`, `${B}plus/btc/liquidations-groups.json`]);
});

test('a request for a link that fails reads the old way, and none is asked for five minutes (or the wait the server names, within bounds)', async () => {
  const failures: [string, LinkAnswer | 'lost', number][] = [
    ['no answer', 'lost', LINK_FAILED_MS],
    ['a 500', { status: 500, body: null }, LINK_FAILED_MS],
    ['a 502 that names two minutes', { status: 502, body: null, retryAfter: 120 }, 2 * MIN],
    ['a 429 that names an hour', { status: 429, body: { error: 'rate_limited' }, retryAfter: 3_600 }, LINK_WAIT_MAX_MS],
    ['a 429 that names a second', { status: 429, body: null, retryAfter: 1 }, LINK_WAIT_MIN_MS],
    ['a 404 (no such route yet)', { status: 404, body: { error: 'not_found' } }, LINK_FAILED_MS],
    ['a link of the wrong shape', { status: 200, body: { base: `${LEVELS}/v1/k/short/`, until: Date.UTC(2026, 10, 22), now: Date.UTC(2026, 10, 21) } }, LINK_FAILED_MS],
    ['no JSON', { status: 200, body: null }, LINK_FAILED_MS],
    ['a slot already over', { status: 200, body: { base: A, until: Date.UTC(2026, 10, 21), now: Date.UTC(2026, 10, 21) } }, LINK_FAILED_MS],
  ];
  for (const [what, failure, wait] of failures) {
    const c = clock(), s = server(n => n === 1 ? failure : grant(A, c.t)), svc = levels(() => OK), { read } = linked(c, s, svc);
    assert.deepEqual(await read(TRIGGERS, PASS), OK, what);
    assert.deepEqual(svc.reads, [{ url: TRIGGERS, pass: PASS }], `${what}: the old way, with the pass`);
    c.t += wait - 1;
    await read(TRIGGERS, PASS); await read(GROUPS, 'another.pass');
    assert.equal(s.asks.length, 1, `${what}: no pass asks again within the wait`);
    assert.deepEqual(svc.reads.slice(1).map(r => r.url), [TRIGGERS, GROUPS]);
    c.t += 1; await read(TRIGGERS, PASS);
    assert.equal(s.asks.length, 2, `${what}: asked for again after it`);
    assert.deepEqual(svc.reads.at(-1), { url: `${A}plus/btc/triggers.json`, pass: null });
  }
  // A request that throws before it is sent (a broken address) fails the same way: `get` never rejects.
  const c = clock(), broken = new DataLink(() => { throw new TypeError('no address'); }, server(() => grant(A, c.t)).request, c.now);
  assert.equal(await broken.get(PASS), null);
});

test('a pass the Plus server refuses a link to reads the old way (the gate\'s own refusal renews it), and asks for no link for a minute; another pass asks at once', async () => {
  const c = clock(), s = server((_n, pass) => pass === PASS ? { status: 403, body: { error: 'plus_required' } } : grant(A, c.t));
  const svc = levels(url => url.startsWith(LEVELS + '/v1/plus/') ? REFUSED : OK), { read } = linked(c, s, svc);
  const burst = await Promise.all(Array.from({ length: 240 }, () => read(TRIGGERS, PASS)));
  assert.equal(s.asks.length, 1, 'a burst of reads asks once');
  assert.ok(burst.every(a => isRefusal(a)), 'each read gets the gate\'s own refusal, which the page already handles');
  assert.ok(svc.reads.length === 240 && svc.reads.every(r => r.url === TRIGGERS && r.pass === PASS), 'all the old way, with the pass');
  c.t += LINK_REFUSED_MS - 1; await read(TRIGGERS, PASS);
  assert.equal(s.asks.length, 1, 'not asked for with that pass within the minute');
  c.t += 1; await read(TRIGGERS, PASS);
  assert.equal(s.asks.length, 2, 'asked for with it again after the minute');
  // The renewed pass asks at once and reads from the link.
  assert.deepEqual(await read(TRIGGERS, 'v1.renewed.sig'), OK);
  assert.equal(s.asks.length, 3); assert.deepEqual(svc.reads.at(-1), { url: `${A}plus/btc/triggers.json`, pass: null });
});

test('a link that cannot be reached reads the old way once, with the pass; when that fails too, the read fails as before', async () => {
  const c = clock(), s = server(() => grant(A, c.t)), svc = levels(url => url.startsWith(A) ? 'lost' : OK), { read } = linked(c, s, svc);
  assert.deepEqual(await read(TRIGGERS, PASS), OK);
  assert.deepEqual(svc.reads, [{ url: `${A}plus/btc/triggers.json`, pass: null }, { url: TRIGGERS, pass: PASS }]);
  assert.equal(s.asks.length, 1, 'the link is kept: no answer says nothing of it');
  const down = levels(() => 'lost'), r2 = linked(c, server(() => grant(A, c.t)), down);
  await assert.rejects(r2.read(TRIGGERS, PASS));
  assert.deepEqual(down.reads.map(r => r.pass), [null, PASS], 'the link once, then the old way once');
});

/** The page's `fetch` answering as `answer` says, every request noted with its Authorization header and cache mode, until `restore`. */
function stubFetch(answer: (url: string) => { status: number; body: unknown }) {
  const real = globalThis.fetch, seen: { url: string; auth: string | null; cache: RequestCache | undefined }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), cache: init?.cache });
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { seen, restore: (): void => { globalThis.fetch = real; } };
}

test('through the page\'s own fetch: the link is asked for with the pass as a bearer token and never cached; the file read from it with no pass and revalidated', async () => {
  const stub = stubFetch(url => url === `${API}/link` ? { status: 200, body: { base: A, until: Date.now() + 6 * HOUR, now: Date.now() } } : { status: 200, body: { v: 1 } });
  try {
    const read = withLink(webFetch, new DataLink(() => API), { refusal: isRefusal });
    assert.deepEqual(await read(TRIGGERS, PASS), { status: 200, body: { v: 1 } });
    assert.deepEqual(stub.seen, [{ url: `${API}/link`, auth: `Bearer ${PASS}`, cache: 'no-store' }, { url: `${A}plus/btc/triggers.json`, auth: null, cache: 'no-cache' }]);
    // The old way, for comparison: the pass in the header.
    await read(`${LEVELS}/v1/plus/btc/triggers.json?old=1`, PASS);
    assert.deepEqual(stub.seen.at(-1), { url: `${LEVELS}/v1/plus/btc/triggers.json?old=1`, auth: `Bearer ${PASS}`, cache: 'no-cache' });
  } finally { stub.restore(); }
});

const AS_OF = Date.UTC(2026, 10, 21, 8, 25);
/** The free levels file (format 2) and the orders file (format 1), as the levels service writes them. */
const freeFile = (): Record<string, unknown> => ({ v: 2, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { id: 'x', asOf: AS_OF, createdAt: AS_OF + 35 * MIN, fetchedAt: AS_OF + 41 * MIN, completedAt: AS_OF + 40 * MIN }, mark: 100, positions: 10, withLiquidation: 8, longSize: 1, shortSize: 1,
  step: 10, bins: [[8, 0, 100, 0, 0, 1, 0, 100, 0]], beyond: { longUsd: 0, shortUsd: 0 } });
const triggersFile = (): Record<string, unknown> => ({ v: 1, coin: 'BTC', venue: 'hyperliquid', attribution: 'Powered by HyperTracker',
  snapshot: { asOf: AS_OF, createdAt: AS_OF + 35 * MIN, fetchedAt: AS_OF + 41 * MIN, ordersAt: AS_OF }, mark: 100, markFrom: 'positions', step: 10, orders: 9, triggers: 8, entries: 0, unsized: { orders: 0, wallets: 0 },
  stops: { orders: 4, wallets: 4, bins: [[8, 300, 100, 0, 0, 2, 0, 300, 0], [12, 0, 0, 50, 150, 0, 3, 0, 100]], beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } },
  takes: { orders: 4, wallets: 4, bins: [[6, 0, 0, 0, 70, 0, 1, 0, 70], [14, 40, 20, 0, 0, 2, 0, 40, 0]], beyond: { longUsd: 0, shortUsd: 0 }, cut: { longUsd: 0, shortUsd: 0 } } });

// The one test of the tab's shared link: it is the first and only use of it in this file, so it starts with none held.
test('the page\'s own readers share the tab\'s one link: the live Plus files and the history\'s rollups come from it, the pass never sent', async () => {
  const stub = stubFetch(url => url === `${PLUS_API}/link` ? { status: 200, body: { base: A, until: Date.now() + 6 * HOUR, now: Date.now() } }
    : url === `${A}plus/btc/triggers.json` ? { status: 200, body: triggersFile() }
    : url === `${A}plus/btc/liquidation-history-4h.json` ? { status: 200, body: { hours: 4, edges: [1, 2, 5], rows: [] } } : { status: 404, body: null });
  try {
    const member = { pass: (): string => PASS, refused: (): void => {} };
    const src = new LiqLevelsSource(async url => url.includes('hyperliquid') ? [] : freeFile(), () => AS_OF + 45 * MIN, () => `${LEVELS}/v1/btc/liquidations.json`, undefined, member);
    const stops: LiqView = { ...FREE_VIEW, liq: false, stops: true };
    for (let i = 0; i < 3; i++) { src.ensure(BTC, () => {}, stops); await tick(); await tick(); }
    assert.equal(src.levels?.kind, 'stops', 'the orders file read from the link and drawn');
    const now = Date.now(), history = new LiqHistory(undefined, { freeFrom, ...member });
    for (let i = 0; i < 3; i++) { history.ensure(now - (MAX_DAYS + 10) * DAY_MS, now, now, () => {}); await tick(); await tick(); }
    assert.ok(history.shape().wide && history.shape().edges, 'the rollup read from the link');
    assert.deepEqual(stub.seen.filter(r => r.url.startsWith(PLUS_API)), [{ url: `${PLUS_API}/link`, auth: `Bearer ${PASS}`, cache: 'no-store' }], 'one link for both');
    assert.deepEqual(stub.seen.filter(r => r.url.startsWith(A)), [{ url: `${A}plus/btc/triggers.json`, auth: null, cache: 'no-cache' }, { url: `${A}plus/btc/liquidation-history-4h.json`, auth: null, cache: 'no-cache' }]);
    assert.ok(!stub.seen.some(r => r.url.startsWith(`${LEVELS}/v1/plus/`)), 'nothing paid read the old way');
  } finally { stub.restore(); }
});
