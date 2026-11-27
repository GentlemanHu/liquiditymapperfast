import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTIFY_KEY, NTFY_SERVER, loadNotify, newTopic, notifyDefaults, notifyKey, ntfyServer, readNotify, saveNotify } from '../src/app/notify/settings.ts';
import { collectItems, ownKey, readBackup, replaceAll, BACKUP_FORMAT, BACKUP_VERSION } from '../src/app/backup.ts';
import { SenderLock } from '../src/app/notify/sender.ts';

const TOKEN = '123456789:AAEhBP0av28aNmXvX5Ds1lYp9uN7Fxq7qX0', HOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-';

class MemoryStorage {
  readonly #m = new Map<string, string>();
  get length(): number { return this.#m.size; }
  key(i: number): string | null { return [...this.#m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.#m.get(k) ?? null; }
  setItem(k: string, v: string): void { this.#m.set(k, v); }
  removeItem(k: string): void { this.#m.delete(k); }
}

test('kept settings are read field by field, and a channel without what it needs is off', () => {
  assert.deepEqual(readNotify(null), notifyDefaults(), 'nothing kept: the defaults (off, bells sent, nothing else)');
  assert.deepEqual(notifyDefaults().send, { bells: true, scripts: false, panels: false });
  const s = readNotify({ on: true, desktop: 'yes', telegram: { on: true, token: TOKEN, chat: '42', bot: 'my_alerts_bot', name: 'Karl' }, ntfy: { on: true, topic: 'lmf-abc' }, discord: { on: true, url: HOOK } });
  assert.equal(s.on, true); assert.equal(s.desktop, false, 'a flag that is not one falls back');
  assert.deepEqual([s.telegram.on, s.ntfy.on, s.discord.on], [true, true, true]);
  assert.equal(s.ntfy.server, NTFY_SERVER, 'ntfy.sh unless another server was set');
  const bad = readNotify({ telegram: { on: true, token: 'nope', chat: '42' }, ntfy: { on: true, topic: 'has space' }, discord: { on: true, url: 'https://evil.example/api/webhooks/1/x' } });
  assert.deepEqual([bad.telegram.on, bad.telegram.token, bad.ntfy.on, bad.ntfy.topic, bad.discord.on, bad.discord.url], [false, '', false, '', false, '']);
  assert.equal(readNotify({ telegram: { on: true, token: TOKEN, chat: '' } }).telegram.on, false, 'a bot with no chat yet cannot be on');
  assert.equal(readNotify({ telegram: { chat: '-1001234' } }).telegram.chat, '-1001234', 'a group\'s chat is negative');
});

test('an ntfy server is https (plain http only on this computer), with no path, query or credentials', () => {
  assert.equal(ntfyServer('https://ntfy.example.com/'), 'https://ntfy.example.com');
  assert.equal(ntfyServer('http://localhost:8080'), 'http://localhost:8080');
  for (const bad of ['http://ntfy.example.com', 'https://ntfy.example.com/topic', 'https://a:b@ntfy.example.com', 'https://ntfy.example.com/?x=1', 'ftp://x', 'not a url']) assert.equal(ntfyServer(bad), null, bad);
  assert.equal(readNotify({ ntfy: { server: 'http://evil.example' } }).ntfy.server, NTFY_SERVER);
});

test('a new topic is long, of letters that cannot be mistaken, and different each time', () => {
  const a = newTopic(), b = newTopic();
  assert.match(a, /^lmf-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/);
  assert.notEqual(a, b);
  assert.equal(newTopic(n => new Uint8Array(n)), 'lmf-aaaaaaaaaaaa', 'built from the random bytes it is given');
});

test('settings are kept under their own key, and a backup never holds them nor a restore removes them', () => {
  const storage = new MemoryStorage();
  assert.equal(saveNotify(storage, readNotify({ on: true, telegram: { on: true, token: TOKEN, chat: '42' } })), true);
  assert.equal(loadNotify(storage).telegram.token, TOKEN);
  storage.setItem(NOTIFY_KEY, '{broken');
  assert.deepEqual(loadNotify(storage), notifyDefaults(), 'unreadable: the defaults');
  assert.equal(notifyKey(NOTIFY_KEY), true); assert.equal(notifyKey('lmf.notify.later'), true); assert.equal(notifyKey('lmf.notifyx'), false);
  assert.equal(ownKey(NOTIFY_KEY), false, 'not one of the keys a backup carries');
  storage.setItem(NOTIFY_KEY, JSON.stringify({ on: true })); storage.setItem('hlm-app-v2', '{}');
  assert.deepEqual(Object.keys(collectItems(storage)), ['hlm-app-v2'], 'a backup is made without it');
  const file = JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, savedAt: 1, items: { 'hlm-app-v2': '{"a":1}', [NOTIFY_KEY]: '{"on":false}' } });
  const read = readBackup(file);
  assert.ok(!('error' in read)); assert.deepEqual(Object.keys((read as { items: Record<string, string> }).items), ['hlm-app-v2'], 'a file holding it is read without it');
  assert.equal(replaceAll(storage, (read as { items: Record<string, string> }).items), true);
  assert.equal(storage.getItem(NOTIFY_KEY), JSON.stringify({ on: true }), 'a restore leaves this browser\'s own in place');
});

test('a paused tab gives the role up and asks for it again; without Web Locks every tab sends', () => {
  const held: (() => void)[] = [];
  let granted = 0;
  const locks = { request: (_name: string, cb: () => Promise<void>) => { granted++; const p = cb(); held.push(() => {}); return p; } };
  const lock = new SenderLock('BTC', () => {}, locks);
  assert.equal(lock.holder, true, 'the first tab takes it');
  lock.pause(true);
  assert.equal(lock.holder, false, 'a replay gives it up');
  lock.pause(false);
  assert.equal(lock.holder, true); assert.equal(granted, 2, 'and asks again');
  assert.equal(new SenderLock('BTC', () => {}, undefined).holder, true, 'no Web Locks: this tab sends');
});

test('a tab that pauses and resumes while it waits in line asks the browser only once', async () => {
  const requests: (() => Promise<void>)[] = [];
  const locks = { request: (_name: string, cb: () => Promise<void>) => { requests.push(cb); return new Promise<void>(() => {}); } };
  const lock = new SenderLock('BTC', () => {}, locks);
  for (let i = 0; i < 5; i++) { lock.pause(true); lock.pause(false); }
  assert.equal(requests.length, 1, 'one request waits, however often the tab paused');
  void requests[0]!();
  assert.equal(lock.holder, true, 'granted while wanted: it holds the role');
});
