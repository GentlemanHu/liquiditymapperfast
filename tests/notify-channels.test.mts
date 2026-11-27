import test from 'node:test';
import assert from 'node:assert/strict';
import { TELEGRAM_API, botOf, chatOf, discordOutcome, discordSend, ntfyOutcome, ntfySend, telegramMe, telegramOutcome, telegramSend, telegramUpdates } from '../src/app/notify/channels.ts';

const TOKEN = '123456789:AAEhBP0av28aNmXvX5Ds1lYp9uN7Fxq7qX0', NOW = Date.UTC(2026, 10, 26, 12);
const m = { title: 'BTC alert', body: 'Price reached your level at 96,250\nNow 96,262', url: 'https://liquiditymapper.com/?coin=BTC' };

test('Telegram is only ever asked with a GET or a form: never JSON or a header of the page\'s own (its preflight answers 501)', () => {
  for (const req of [telegramMe(TOKEN), telegramUpdates(TOKEN)]) {
    assert.equal(req.method, 'GET'); assert.equal(req.headers, undefined); assert.equal(req.body, undefined);
    assert.ok(req.url.startsWith(`${TELEGRAM_API}/bot${TOKEN}/`));
  }
  const send = telegramSend(TOKEN, '42', m, 'Open chart');
  assert.equal(send.method, 'POST');
  assert.deepEqual(Object.keys(send.headers!), ['content-type']);
  assert.match(send.headers!['content-type']!, /^application\/x-www-form-urlencoded/, 'a content type a browser sends without asking first');
  const form = new URLSearchParams(send.body);
  assert.equal(form.get('chat_id'), '42'); assert.equal(form.get('text'), `${m.title}\n${m.body}`);
  assert.deepEqual(JSON.parse(form.get('reply_markup')!), { inline_keyboard: [[{ text: 'Open chart', url: m.url }]] });
  assert.equal(new URLSearchParams(telegramSend(TOKEN, '42', { ...m, url: 'http://127.0.0.1:8787/' }, 'x').body).get('reply_markup'), null, 'no button to an address only this computer has');
});

test('Telegram\'s answers: done, a token it does not know, a chat it cannot write to, a webhook in the way, a wait', () => {
  assert.deepEqual(telegramOutcome({ status: 200, text: '{"ok":true,"result":{"message_id":1}}' }), { ok: true, result: { message_id: 1 } });
  assert.deepEqual(telegramOutcome({ status: 401, text: '{"ok":false,"error_code":401,"description":"Unauthorized"}' }), { ok: false, problem: 'token' });
  assert.deepEqual(telegramOutcome({ status: 400, text: '{"ok":false,"description":"Bad Request: chat not found"}' }), { ok: false, problem: 'chat' });
  assert.deepEqual(telegramOutcome({ status: 403, text: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' }), { ok: false, problem: 'chat' });
  assert.deepEqual(telegramOutcome({ status: 409, text: '{"ok":false}' }), { ok: false, problem: 'conflict' });
  assert.deepEqual(telegramOutcome({ status: 429, text: '{"ok":false,"parameters":{"retry_after":7}}' }), { ok: false, problem: 'busy', retryAfterMs: 7_000 });
  assert.deepEqual(telegramOutcome({ status: 0, text: '', error: 'timeout' }), { ok: false, problem: 'timeout' });
  assert.deepEqual(telegramOutcome({ status: 200, text: 'not json' }), { ok: false, problem: 'answer' });
});

test('the bot from getMe, and the person\'s chat from a recent private message only', () => {
  assert.deepEqual(botOf({ id: 1, is_bot: true, first_name: 'LMF alerts', username: 'lmf_alerts_bot' }), { username: 'lmf_alerts_bot', name: 'LMF alerts' });
  assert.equal(botOf({ is_bot: false, username: 'a_person' }), null);
  const msg = (id: number, type: string, secondsAgo: number, name = 'Karl') => ({ update_id: id, message: { date: Math.floor((NOW - secondsAgo * 1_000) / 1_000), chat: { id, type, first_name: name } } });
  assert.deepEqual(chatOf([msg(7, 'private', 120), msg(9, 'private', 30, 'Ana')], NOW), { id: '9', name: 'Ana' }, 'the newest');
  assert.equal(chatOf([msg(-100, 'group', 10)], NOW), null, 'never a group\'s');
  assert.equal(chatOf([msg(7, 'private', 60 * 60)], NOW), null, 'never an old one');
  assert.equal(chatOf('nope', NOW), null);
});

test('ntfy is published as JSON to the server\'s root, so any language\'s words fit its title; Discord never pings anyone', () => {
  const n = ntfySend('https://ntfy.sh', 'lmf-abc', { ...m, title: 'BTC アラート' });
  assert.equal(n.url, 'https://ntfy.sh/'); assert.equal(n.method, 'POST');
  assert.deepEqual(JSON.parse(n.body!), { topic: 'lmf-abc', title: 'BTC アラート', message: m.body, priority: 4, tags: ['bell'], click: m.url });
  assert.deepEqual(ntfyOutcome({ status: 200, text: '{}' }), { ok: true });
  assert.deepEqual(ntfyOutcome({ status: 429, text: '' }), { ok: false, problem: 'busy', retryAfterMs: 60_000 });
  const d = discordSend('https://discord.com/api/webhooks/1/x', { ...m, body: '@everyone look' });
  const body = JSON.parse(d.body!) as { content: string; allowed_mentions: { parse: string[] } };
  assert.deepEqual(body.allowed_mentions, { parse: [] }); assert.match(body.content, /BTC alert\n@everyone look\n<https:/);
  assert.deepEqual(discordOutcome({ status: 204, text: '' }), { ok: true });
  assert.deepEqual(discordOutcome({ status: 404, text: '{"code":10015}' }), { ok: false, problem: 'webhook' });
  assert.deepEqual(discordOutcome({ status: 429, text: '{"retry_after":1.5}' }), { ok: false, problem: 'busy', retryAfterMs: 1_500 });
});

test('a bot whose messages go to a webhook is told apart from a busy service; Discord gets the address without a preview', () => {
  assert.deepEqual(telegramOutcome({ status: 409, text: '{"ok":false}' }), { ok: false, problem: 'conflict' });
  const body = JSON.parse(discordSend('https://discord.com/api/webhooks/1/x', m).body!) as { content: string };
  assert.ok(body.content.endsWith(`<${m.url}>`), 'angle brackets: no preview of the page under every alert');
});
