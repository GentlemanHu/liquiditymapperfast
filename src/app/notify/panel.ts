import { el } from '../dom.ts';
import { button, heading, note, switchRow } from '../ui.ts';
import { t } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { currentCoin } from '../coin.ts';
import type { Store } from '../store.ts';
import type { DrawController } from '../draw/controller.ts';
import type { Drawing } from '../draw/model.ts';
import { alertEnded } from '../draw/alerts.ts';
import { desktopPermission } from './desktop.ts';
import { DISCORD_WEBHOOK, TELEGRAM_TOKEN, newTopic, ntfyServer, NTFY_SERVER } from './settings.ts';
import type { ChannelId, DeliveryEntry } from './delivery.ts';
import { offered, problemText, type Notify } from './notify.ts';
import type { Outcome } from './channels.ts';

/**
 * The Notify panel (the Alerts deck's Notify key): the switch, where alerts go (a pop-up here, the person's Telegram bot, an ntfy topic, a
 * Discord webhook), which alerts go, the bells on drawings, and what was sent lately. Every channel is set up here, in this browser, and sent
 * to by it; nothing of it reaches the page's servers.
 */

const CHANNEL_NAME = (): Record<ChannelId, string> => ({ desktop: t('This computer'), telegram: t('Telegram'), ntfy: 'ntfy', discord: t('Discord') });

/** A line saying how the last test or step went, in place under its row. */
function said(text: string, warn: boolean): HTMLElement { return el('p', { class: warn ? 'panel-note notify-warn' : 'panel-note notify-ok', textContent: text }); }
const outcomeLine = (o: Outcome): HTMLElement => o.ok ? said(t('Sent: check that it arrived.'), false) : said(problemText(o.problem), true);

/** A row of a text box and a button (a token, a webhook, a price): the button takes what is typed. */
function entryRow(placeholder: string, label: string, value: string, take: (text: string) => void, type: 'text' | 'password' | 'number' = 'text'): HTMLElement {
  const input = el('input', { type, placeholder, value, ariaLabel: placeholder, class: 'notify-input', spellcheck: false, autocomplete: 'off' });
  // A token is no password of the person's: the common password managers are asked to leave the field alone.
  if (type === 'password') { input.setAttribute('data-1p-ignore', ''); input.setAttribute('data-lpignore', 'true'); input.setAttribute('data-bwignore', ''); }
  if (type === 'number') { input.step = 'any'; input.min = '0'; }
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); take(input.value); } e.stopPropagation(); };
  return el('div', { class: 'notify-entry' }, input, button(label, () => take(input.value)));
}

export function buildNotifyPanel(notify: Notify, draw: DrawController, store: Store, rerender: () => void, tools: HTMLElement, body: HTMLElement): void {
  const s = notify.settings, coin = currentCoin().coin;
  const where = notify.channels();
  // The state in the strip at the top: what the switch does now, in one line.
  const state = !s.on ? t('Notify is off') : !where.length ? t('Nowhere to send yet: switch on a pop-up or a phone channel below') : notify.sender.holder ? t('Sending from this tab') : t('Another tab of this coin sends; this one takes over when it closes');
  const stateEl = el('span', { class: 'sound-state', textContent: state });
  stateEl.dataset.state = !s.on || !where.length ? 'off' : notify.sender.holder ? 'on' : 'locked';
  tools.append(stateEl);

  body.append(
    switchRow(t('Send alerts'), t('A pop-up and messages to your phone for the alerts chosen below. They come from this tab: they stop when it closes or the computer sleeps. Sounds go their own way.'), s.on, on => { notify.set({ on }); rerender(); }),
    note(t('Alerts run in this tab: keep it open (a pinned tab is not put to sleep) and the computer awake. A phone gets messages; it does not watch the price itself.')),
  );

  // ---- Where they go --------------------------------------------------------------------------------------------------------------
  body.append(heading(t('Send to')));
  const results = new Map<ChannelId, HTMLElement>();
  const resultSlot = (id: ChannelId): HTMLElement => { const slot = el('div', { class: 'notify-result' }); results.set(id, slot); return slot; };
  const test = (id: ChannelId): HTMLButtonElement => {
    const b = button(t('Send test'), () => {
      // One test at a time a channel: the button rests three seconds after a press.
      b.disabled = true; window.setTimeout(() => { b.disabled = false; }, 3_000);
      const slot = results.get(id); slot?.replaceChildren(said(t('Sending…'), false));
      void notify.test(id).then(o => slot?.replaceChildren(outcomeLine(o)));
    }, t('Send a test message here now'));
    return b;
  };

  // This computer: where the browser can never show one (a phone's), the switch would do nothing, so only that is said.
  const permission = desktopPermission();
  if (permission === 'unsupported') body.append(note(t('This browser shows no pop-ups for a web page here (on a phone, use a phone channel below).')));
  else {
    body.append(switchRow(t('Pop-up on this computer'), t('A notification the system shows, also while the page is behind other windows. The browser asks you once to allow it.'), s.desktop && permission === 'granted', on => {
      if (!on) { notify.set({ desktop: false }); rerender(); return; }
      void notify.enableDesktop().then(rerender);
    }));
    if (permission === 'denied') body.append(said(t('The browser blocks pop-ups for this site: allow notifications in its site settings (the icon left of the address), then switch this on again.'), true));
    else if (s.desktop && permission === 'granted') body.append(el('div', { class: 'tier-test' }, test('desktop')), resultSlot('desktop'));
  }

  if (offered('telegram')) {
    // Telegram: the person's own bot (a shared one's token would be in this open page for anyone to use).
    const tg = s.telegram;
    body.append(el('h5', { class: 'notify-channel', textContent: t('Telegram') }));
    if (tg.token && tg.chat) {
      body.append(
        switchRow(t('Send messages here'), tg.name ? t('Messages from your bot @{bot} to {name}.', { bot: tg.bot || '?', name: tg.name }) : t('Messages from your bot @{bot} to you.', { bot: tg.bot || '?' }), tg.on, on => { notify.set({ telegram: { ...tg, on } }); rerender(); }),
        el('div', { class: 'tier-test' }, test('telegram'), button(t('Disconnect'), () => { notify.set({ telegram: { on: false, token: '', chat: '', bot: '', name: '' } }); rerender(); }, t('Forget the bot and its chat in this browser'))),
        resultSlot('telegram'));
    } else if (tg.token) {
      const slot = el('div', { class: 'notify-result' });
      const find = (): void => {
        slot.replaceChildren(said(t('Looking…'), false));
        void notify.telegramChat(tg.token).then(r => {
          if (r.ok) { notify.set({ telegram: { ...tg, chat: r.id, name: r.name, on: true } }); rerender(); void notify.test('telegram'); return; }
          slot.replaceChildren(said(r.problem === 'none' ? t('No Start found yet: open the bot, press Start (or send it any message), then try again.') : problemText(r.problem), true));
        });
      };
      body.append(
        note(t('Now open your bot @{bot} in Telegram and press Start, then press Find my chat.', { bot: tg.bot || '?' })),
        el('div', { class: 'tier-test' },
          ...(tg.bot ? [el('a', { class: 'notify-link', href: `https://t.me/${tg.bot}`, target: '_blank', rel: 'noopener noreferrer', textContent: t('Open @{bot}', { bot: tg.bot }) })] : []),
          button(t('Find my chat'), find), button(t('Start over'), () => { notify.set({ telegram: { on: false, token: '', chat: '', bot: '', name: '' } }); rerender(); })),
        slot);
    } else {
      const slot = el('div', { class: 'notify-result' });
      const connect = (raw: string): void => {
        const token = raw.trim();
        if (!TELEGRAM_TOKEN.test(token)) { slot.replaceChildren(said(t('That is not a bot token: BotFather gives one like 123456789:AA… (numbers, a colon, then letters).'), true)); return; }
        slot.replaceChildren(said(t('Asking Telegram…'), false));
        void notify.telegramBot(token).then(r => {
          if (!r.ok) { slot.replaceChildren(said(problemText(r.problem), true)); return; }
          notify.set({ telegram: { on: false, token, chat: '', bot: r.username, name: '' } }); rerender();
        });
      };
      body.append(
        note(t('Your own bot, about a minute: in Telegram, open @BotFather, send /newbot and follow its two questions. Paste the token it gives here.')),
        entryRow(t('Bot token'), t('Connect'), '', connect, 'password'), slot);
    }
  }

  // ntfy: a free app, no account; the topic's name is the key, so it is long and made here.
  const nt = s.ntfy;
  body.append(el('h5', { class: 'notify-channel', textContent: 'ntfy' }));
  if (nt.topic) {
    const copy = button(t('Copy'), () => { void navigator.clipboard?.writeText(nt.topic).then(() => { copy.textContent = t('Copied'); }, () => {}); }, t('Copy the topic, to paste into the ntfy app'));
    body.append(
      switchRow(t('Send messages here'), t('Messages to the topic below on {server}. In the ntfy app (Android or iPhone): add a subscription and type this topic.', { server: nt.server.replace(/^https?:\/\//, '') }), nt.on, on => { notify.set({ ntfy: { ...nt, on } }); rerender(); }),
      el('div', { class: 'notify-topic' }, el('code', { textContent: nt.topic }), copy),
      el('div', { class: 'tier-test' }, test('ntfy'), button(t('New topic'), () => { notify.set({ ntfy: { ...nt, topic: newTopic() } }); rerender(); }, t('Make another topic: the phone must subscribe to it again')),
        button(t('Remove'), () => { notify.set({ ntfy: { ...nt, on: false, topic: '' } }); rerender(); })),
      resultSlot('ntfy'));
    if (nt.server !== NTFY_SERVER) body.append(note(t('Your own server: {server}', { server: nt.server })));
  } else {
    const slot = el('div', { class: 'notify-result' });
    body.append(
      note(t('Free and without an account: install the ntfy app on your phone, then make a topic here and subscribe to it in the app.')),
      el('div', { class: 'tier-test' }, button(t('Make a topic'), () => { notify.set({ ntfy: { ...nt, topic: newTopic(), on: true } }); rerender(); })),
      entryRow(t('Your own ntfy server (optional)'), t('Use'), nt.server === NTFY_SERVER ? '' : nt.server, raw => {
        const server = raw.trim() ? ntfyServer(raw) : NTFY_SERVER;
        if (!server) { slot.replaceChildren(said(t('An address like https://ntfy.example.com (plain http only on this computer).'), true)); return; }
        notify.set({ ntfy: { ...nt, server } }); rerender();
      }), slot);
  }

  if (offered('discord')) {
    // Discord: a webhook of a channel the person can manage.
    const dc = s.discord;
    body.append(el('h5', { class: 'notify-channel', textContent: t('Discord') }));
    if (dc.url) {
      body.append(
        switchRow(t('Send messages here'), t('Messages to your webhook (its channel gets them, and its members a phone notification as Discord sets).'), dc.on, on => { notify.set({ discord: { ...dc, on } }); rerender(); }),
        el('div', { class: 'tier-test' }, test('discord'), button(t('Remove'), () => { notify.set({ discord: { on: false, url: '' } }); rerender(); }, t('Forget the webhook in this browser'))),
        resultSlot('discord'));
    } else {
      const slot = el('div', { class: 'notify-result' });
      body.append(
        note(t('In Discord: a channel\'s settings, Integrations, Webhooks, New Webhook, Copy Webhook URL. Paste it here.')),
        entryRow(t('Webhook address'), t('Save'), '', raw => {
          const url = raw.trim();
          if (!DISCORD_WEBHOOK.test(url)) { slot.replaceChildren(said(t('That is not a Discord webhook address (https://discord.com/api/webhooks/…).'), true)); return; }
          notify.set({ discord: { on: true, url } }); rerender();
        }, 'password'), slot);
    }
  }

  // ---- What goes ------------------------------------------------------------------------------------------------------------------
  body.append(heading(t('What is sent')),
    switchRow(t('Bells on drawings'), t('A level, a zone or a trend line with its bell on, when the price reaches it.'), s.send.bells, bells => { notify.set({ send: { ...s.send, bells } }); rerender(); }),
    switchRow(t('Script alerts'), t('What your scripts\' alert(...) calls say, while Scripts is on.'), s.send.scripts, scripts => { notify.set({ send: { ...s.send, scripts } }); rerender(); }),
    switchRow(t('Panel alerts'), t('The alerts switched on in Sounds: bursts of flow, big candle deltas, walls, the balance, extreme depth. The open interest alert is not sent.'), s.send.panels, panels => { notify.set({ send: { ...s.send, panels } }); rerender(); }));

  // ---- The bells ------------------------------------------------------------------------------------------------------------------
  body.append(heading(t('Your bells')));
  const bells = draw.bells(), now = Date.now();
  if (!bells.length) body.append(note(t('No bells yet: select a level, a zone or a trend line on the map and press its bell, right-click the map at a price, or add one here.')));
  for (const { coin: of, drawing } of bells) body.append(bellRow(draw, of, drawing, now, rerender));
  if (bells.some(b => b.coin !== coin)) body.append(note(t('A bell of another coin goes off only while a tab is open on that coin.')));
  // Left empty: a bell at the price as it is now would go off at the next tick, which is no alert anyone asked for.
  const addSlot = el('div', { class: 'notify-result' });
  body.append(entryRow(t('Price for a new bell'), t('Add bell'), '', raw => {
    const p = Number(raw.replace(/,/g, '').trim());
    if (!(p > 0)) { addSlot.replaceChildren(said(t('A price above zero.'), true)); return; }
    if (draw.addAlertLevel(p)) rerender(); else addSlot.replaceChildren(said(draw.message?.text ?? t('No bell could be added now (drawings locked, a replay, or the coin\'s 100 drawings).'), true));
  }, 'number'), addSlot);

  // ---- Lately ---------------------------------------------------------------------------------------------------------------------
  const recent = notify.delivery.log.slice(-6).reverse();
  body.append(heading(t('Sent lately')));
  body.append(recent.length ? el('div', { class: 'alert-log' }, ...recent.map(e => el('p', { class: e.outcome === 'sent' ? 'panel-note' : 'panel-note notify-warn', textContent: `${clock(e.at)}  ${CHANNEL_NAME()[e.channel]}: ${outcomeWord(e)}  ${e.title}` }))) : note(t('Nothing yet.')));
}

function outcomeWord(e: DeliveryEntry): string {
  if (e.outcome === 'sent') return t('sent');
  if (e.outcome === 'late') return t('not sent (too late)');
  if (e.outcome === 'limited') return t('not sent (too many at once)');
  return e.problem ? `${t('failed')} (${problemText(e.problem)})` : t('failed');
}

/** One bell in the list: its coin, what it watches, how often it goes off, and a key to switch it off. */
function bellRow(draw: DrawController, coin: string, d: Drawing, now: number, rerender: () => void): HTMLElement {
  const what = d.kind === 'zone'
    ? t('zone {low} to {high}', { low: fmtPrice(Math.min(d.points[0]!.p, d.points[1]!.p)), high: fmtPrice(Math.max(d.points[0]!.p, d.points[1]!.p)) })
    : d.kind === 'trend' ? t('trend line') : t('level {price}', { price: fmtPrice(d.points[0]!.p) });
  // A drawing that ended, or one hidden, never goes off: said, and greyed.
  const ended = alertEnded(d, now), quiet = ended || d.hidden;
  const name = el('span', { class: 'notify-bell-name', textContent: `${coin} · ${what}${d.text.trim() ? ` · ${d.text.trim()}` : ''}${ended ? ` · ${t('ended')}` : ''}${d.hidden ? ` · ${t('hidden')}` : ''}` });
  if (quiet) name.classList.add('muted');
  const how = el('select', { ariaLabel: t('How often it goes off') });
  how.append(new Option(t('Once'), 'once'), new Option(t('Every time'), 'every'));
  how.value = d.alertOnce ? 'once' : 'every';
  how.disabled = d.locked;
  how.onchange = () => { draw.setBell(coin, d.id, { alertOnce: how.value === 'once' }); rerender(); };
  const off = button('×', () => { draw.setBell(coin, d.id, { alert: false }); rerender(); }, t('Switch this bell off'), 'notify-bell-off');
  off.disabled = d.locked;
  return el('div', { class: 'notify-bell' }, name, how, off);
}

