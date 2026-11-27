import { el } from '../dom.ts';
import type { Store } from '../store.ts';
import { button, heading, note, numberRow, rangeRow, selectRow, switchRow } from '../ui.ts';
import { DEPTH_MAX_HOURS, DEPTH_RANGES, MIN_LIQ_TIER_USD, MIN_TIER_USD, readSounds, type LiquidationSoundSettings, type SoundSettings } from './rules.ts';
import { DEPTH_MIN_BASELINE } from './depth-watch.ts';
import type { SoundLogEntry, Sounds } from './sounds.ts';
import type { Alerts } from './alerts.ts';
import type { PanelSounds } from './rules.ts';
import { clock } from '../format.ts';
import { usd as formatUsd } from '../format.ts';
import { amount, inCoins } from '../units.ts';
import { t, tn } from '../i18n.ts';
import { scaledUsd, unscaledUsd } from '../coin.ts';

/** Reusable liquidation sound controls (Sounds panel and Tape settings share the same store state). */
export function liqSoundRows(store: Store, sounds: Sounds | null, rerender: () => void): HTMLElement[] {
  const s = store.state.sounds, l = s.liquidations;
  const setLiq = (change: Partial<LiquidationSoundSettings>): void => {
    const cur = store.state.sounds;
    store.set({ sounds: readSounds({ ...cur, liquidations: { ...cur.liquidations, ...change } }) });
    rerender();
  };
  const setLiqTier = (id: string, change: Partial<LiquidationSoundSettings['tiers'][number]>): void =>
    setLiq({ tiers: store.state.sounds.liquidations.tiers.map(tier => tier.id === id ? { ...tier, ...change } : tier) });
  const rows: HTMLElement[] = [
    switchRow(t('Play liquidation sounds'), t('Percussive strike when forced closes arrive across Binance, Bybit, OKX and Deribit. Obeys the master Sounds switch and volume; cascades within 300 ms coalesce into one sound.'), l.on, on => {
      setLiq({ on });
      if (on && store.state.sounds.on && sounds) void sounds.engine.unlock().then(() => { store.set({ soundState: sounds.engine.state }); rerender(); });
    }),
    selectRow(t('Liquidation side'), t('Both sides, or only longs liquidated (forced sells) or only shorts liquidated (forced buys).'), [['both', t('Both')], ['long', t('Longs liquidated')], ['short', t('Shorts liquidated')]], l.side, side => setLiq({ side: side === 'long' || side === 'short' ? side : 'both' })),
  ];
  l.tiers.forEach((tier, index) => {
    const min = scaledUsd(MIN_LIQ_TIER_USD);
    const amount = el('input', { type: 'number', min: String(min), step: String(Math.max(100, scaledUsd(1_000))), value: String(scaledUsd(tier.usd)), tip: t('Smallest liquidation in this tier, USD notional (at least {min})', { min: formatUsd(min) }) });
    amount.onchange = () => { const v = Number(amount.value); if (Number.isFinite(v)) setLiqTier(tier.id, { usd: unscaledUsd(v) }); };
    const on = el('input', { type: 'checkbox', checked: tier.on, tip: tier.on ? t('Mute the {tier} tier', { tier: tier.name }) : t('Sound the {tier} tier', { tier: tier.name }) });
    on.onchange = () => setLiqTier(tier.id, { on: on.checked });
    rows.push(el('div', { class: 'tier-row' },
      el('label', { class: 'tier-name' }, on, el('span', { class: 'name', textContent: tier.name }), el('span', { class: 'desc', textContent: tn(index + 1, '{n} note', '{n} notes') })),
      el('label', { class: 'tier-usd' }, el('span', { class: 'muted', textContent: '≥ $' }), amount),
      el('span', { class: 'tier-test' },
        button(t('Short'), () => sounds?.testLiquidation(tier.id, 'short'), t('Hear a {tier} short liquidation', { tier: tier.name }), 'tier-buy'),
        button(t('Long'), () => sounds?.testLiquidation(tier.id, 'long'), t('Hear a {tier} long liquidation', { tier: tier.name }), 'tier-sell'),
      ),
    ));
  });
  return rows;
}

/** A sound's line in the Recent list, written when the list shows: its size in the page's units (units.ts; '–' in coins where none was kept). */
function soundLogText(e: SoundLogEntry): string {
  const amt = !e.usd ? '' : !inCoins() ? `$${formatUsd(e.usd)}` : e.coins !== undefined && Number.isFinite(e.coins) ? amount(e.coins) : '–';
  const multi = e.venues && e.venues > 1 ? ` · ${tn(e.venues, '{n} venue', '{n} venues')}` : '';
  if (e.kind === 'liquidation') return `${e.liqSide === 'short' ? t('Shorts liquidated') : t('Longs liquidated')} ${amt}${multi}`;
  if (e.kind === 'trade') return `${e.side === 'buy' ? t('BUY') : t('SELL')} ${amt}${multi}`;
  return t('Unusual candle volume');
}

/** Contents of the Sounds panel: a master switch, volume, which trades count, the size tiers (each with a Test), liquidation tiers and the candle chime. */
export function buildSoundPanel(store: Store, sounds: Sounds, rerender: () => void, tools: HTMLElement, body: HTMLElement, alerts: Alerts | null = null): void {
  const s = store.state.sounds;
  const set = (change: Partial<SoundSettings>): void => { store.set({ sounds: readSounds({ ...store.state.sounds, ...change }) }); rerender(); };
  const setTier = (id: string, change: Partial<SoundSettings['tiers'][number]>): void => set({ tiers: store.state.sounds.tiers.map(t => t.id === id ? { ...t, ...change } : t) });

  const locked = s.on && store.state.soundState !== 'running';
  const state = el('span', { class: 'sound-state', textContent: !s.on ? t('Sounds are off') : locked ? t('Waiting for a click: browsers keep sound locked until you click or press a key on the page') : t('Sounds are on') });
  state.dataset.state = !s.on ? 'off' : locked ? 'locked' : 'on';
  tools.append(state);

  body.append(
    switchRow(t('Play sounds'), t('Master switch. Nothing plays while this is off; the Test buttons below still do, so you can hear what you would get.'), s.on, on => { set({ on }); if (on) void sounds.engine.unlock().then(() => { store.set({ soundState: sounds.engine.state }); rerender(); }); }),
    rangeRow(t('Volume'), t('Master volume. Sounds are also compressed, so several at once never clip.'), { min: 0, max: 1, step: 0.05, value: s.volume, format: v => `${Math.round(v * 100)}%` }, volume => { store.set({ sounds: readSounds({ ...store.state.sounds, volume }) }); }),
    selectRow(t('Trades from'), t('Which markets can make a sound. Spot and perpetual follow the market type of each venue.'), [['all', t('Every enabled venue')], ['spot', t('Spot venues only')], ['perp', t('Perpetual venues only')]], s.scope, scope => set({ scope: scope as SoundSettings['scope'] })),
    selectRow(t('Trade side'), t('Both sides, or only large market buys or only large market sells.'), [['both', t('Both')], ['buy', t('Buys only')], ['sell', t('Sells only')]], s.tradeSide, tradeSide => set({ tradeSide: tradeSide === 'buy' || tradeSide === 'sell' ? tradeSide : 'both' })),
  );

  body.append(heading(t('Large trades')));
  body.append(note(t('A sweep that fills on several venues within a quarter of a second counts as one trade. Buys rise in pitch and sells fall; a bigger tier adds notes and loudness. A trade belongs to the highest tier it reaches, and sounds only if that tier is on.')));
  s.tiers.forEach((tier, index) => {
    const amount = el('input', { type: 'number', min: String(scaledUsd(MIN_TIER_USD)), step: String(scaledUsd(10_000)), value: String(scaledUsd(tier.usd)), tip: t('Smallest trade in this tier, USD notional (at least {min})', { min: formatUsd(scaledUsd(MIN_TIER_USD)) }) });
    amount.onchange = () => { const v = Number(amount.value); if (Number.isFinite(v)) setTier(tier.id, { usd: unscaledUsd(v) }); };
    const on = el('input', { type: 'checkbox', checked: tier.on, tip: tier.on ? t('Mute the {tier} tier', { tier: tier.name }) : t('Sound the {tier} tier', { tier: tier.name }) }); on.onchange = () => setTier(tier.id, { on: on.checked });
    body.append(el('div', { class: 'tier-row' },
      el('label', { class: 'tier-name' }, on, el('span', { class: 'name', textContent: tier.name }), el('span', { class: 'desc', textContent: tn(index + 1, '{n} note', '{n} notes') })),
      el('label', { class: 'tier-usd' }, el('span', { class: 'muted', textContent: '≥ $' }), amount),
      el('span', { class: 'tier-test' }, button(t('Buy'), () => sounds.test(tier.id, 'buy'), t('Hear a {tier} buy', { tier: tier.name }), 'tier-buy'), button(t('Sell'), () => sounds.test(tier.id, 'sell'), t('Hear a {tier} sell', { tier: tier.name }), 'tier-sell')),
    ));
  });

  body.append(heading(t('Liquidations')));
  body.append(...liqSoundRows(store, sounds, rerender));

  body.append(heading(t('Candles')));
  body.append(switchRow(t('Chime on unusual volume'), t('One soft chime when a candle closes with unusually large volume (the sensitivity is set in Highlights).'), s.barChime, barChime => set({ barChime })));
  if (alerts) panelSounds(store, s.panels, alerts, sounds, set, body, rerender);
}

/** The panel sounds that can also be switched on in the pane they are about. */
export type PanelSwitch = 'flow' | 'bars' | 'depth' | 'depthPane';
const SWITCH_TEXT: Record<PanelSwitch, { name: string; tip: string }> = {
  depthPane: { name: t('Extreme depth balance'), tip: t('Over a recorded minute, the bids against the asks within the range below went further one way than in all but the rarest minutes of the hours before (at 99, one minute in a hundred). It sounds once, and again only after the balance has come back to its usual. A slow, low swell, rising when the bids are heavier.') },
  flow: { name: t('Burst of taker flow'), tip: t("An exchange bought or sold far more at market in ten seconds than it usually does. High, two-note sweep. Bursts are also marked on the flow column's lines, sound or not; its settings switch the marks.") },
  bars: { name: t('Candle closes with a big delta'), tip: t('When a candle closes, the net taker flow of every enabled venue over it was at least this much. Mid, two-note triangle.') },
  depth: { name: t('The balance tips'), tip: t('Within 1% of the price, the bids outweigh the asks (or the other way round) by more than this share. It sounds once and again only after the book has come back. Three steps.') },
};
export const panelSwitchOn = (store: Store, which: PanelSwitch): boolean => {
  const p = store.state.sounds.panels;
  return which === 'flow' ? p.flow.burst : which === 'bars' ? p.bars.delta : which === 'depth' ? p.depth.imbalance : p.depthPane.extreme;
};
export function setPanelSwitch(store: Store, which: PanelSwitch, on: boolean): void {
  const p = store.state.sounds.panels;
  const panels = which === 'flow' ? { ...p, flow: { ...p.flow, burst: on } } : which === 'bars' ? { ...p, bars: { ...p.bars, delta: on } }
    : which === 'depth' ? { ...p, depth: { ...p.depth, imbalance: on } } : { ...p, depthPane: { ...p.depthPane, extreme: on } };
  store.set({ sounds: readSounds({ ...store.state.sounds, panels }) });
}
/** What a pane's own Sound box says it does (the switch's description). */
export const panelSwitchTip = (which: PanelSwitch): string => SWITCH_TEXT[which].tip;
/** The same switch as in the Sounds panel, for the pane's own settings: both read and write `sounds.panels`, so they never disagree. */
export const panelSwitchRow = (store: Store, which: PanelSwitch, onChange: () => void = () => {}): HTMLElement =>
  switchRow(SWITCH_TEXT[which].name, SWITCH_TEXT[which].tip, panelSwitchOn(store, which), on => { setPanelSwitch(store, which, on); onChange(); });
/** How big and how unusual a burst of flow must be, here and in the flow column's settings (they decide its marks too): both write `sounds.panels.flow`. */
export function burstSizeRows(store: Store, onChange: () => void = () => {}): HTMLElement[] {
  const flow = store.state.sounds.panels.flow;
  const change = (patch: Partial<PanelSounds['flow']>): void => {
    const p = store.state.sounds.panels;
    store.set({ sounds: readSounds({ ...store.state.sounds, panels: { ...p, flow: { ...p.flow, ...patch } } }) }); onChange();
  };
  return [
    numberRow(t('Smallest burst (USD)'), t('Ignore bursts smaller than this, however unusual they are for a quiet exchange.'), { min: scaledUsd(100_000), step: scaledUsd(100_000), value: scaledUsd(flow.usd) }, usd => change({ usd: unscaledUsd(usd) })),
    numberRow(t('Sensitivity (deviations)'), t('How far outside its own normal an exchange must go: 2 is touchy, 4 is the default, 8 is only the extreme.'), { min: 2, max: 10, step: 0.5, value: flow.sensitivity }, sensitivity => change({ sensitivity })),
  ];
}

/**
 * The sounds a panel may make about what is happening in it. A sound is for something rare and discrete that is worth looking up from
 * another screen for; a level or a trend that is on screen all the time is not. Each is off until chosen, has its own cool-down, and the
 * four loudest moments in ten seconds are all that can sound.
 */
function panelSounds(store: Store, p: PanelSounds, alerts: Alerts, sounds: Sounds, set: (change: Partial<SoundSettings>) => void, body: HTMLElement, rerender: () => void): void {
  const change = <K extends keyof PanelSounds>(panel: K, patch: Partial<PanelSounds[K]>): void => set({ panels: { ...store.state.sounds.panels, [panel]: { ...store.state.sounds.panels[panel], ...patch } } });
  const tests = (kind: Parameters<Alerts['test']>[0], both = true): HTMLElement => el('div', { class: 'tier-test' },
    ...(both ? [button(t('Buy'), () => alerts.test(kind, 'buy'), t('Hear this sound for buying'), 'tier-buy'), button(t('Sell'), () => alerts.test(kind, 'sell'), t('Hear this sound for selling'), 'tier-sell')] : [button(t('Test'), () => alerts.test(kind, null), t('Hear this sound'))]));

  body.append(heading(t('Per panel')));
  body.append(note(t('Each panel can make its own sound about something rare that happens in it. Everything here is off until you choose it, obeys the switch and volume above, and no more than four sounds can play in ten seconds. Rising notes mean buying, falling notes mean selling.')));

  body.append(heading(t('Flow column')),
    panelSwitchRow(store, 'flow', () => rerender()),
    ...burstSizeRows(store, rerender),
    tests('flow-burst'));

  body.append(heading(t('Bar stats and footprint')),
    panelSwitchRow(store, 'bars', () => rerender()),
    numberRow(t('Smallest delta (USD)'), t('Net buys minus sells over the candle that just closed.'), { min: scaledUsd(100_000), step: scaledUsd(500_000), value: scaledUsd(p.bars.usd) }, usd => change('bars', { usd: unscaledUsd(usd) })),
    tests('bar-delta'));

  body.append(heading(t('Order book and heatmap')),
    switchRow(t('A wall appears or is pulled'), t('Within 1% of the price, a level of at least this size appears, or one that has stood for a few seconds is pulled without the price having come to it. Low, soft thud; pulled falls.'), p.book.wall, wall => change('book', { wall })),
    numberRow(t('Smallest wall (USD)'), t('Added up across the enabled venues at one price.'), { min: scaledUsd(500_000), step: scaledUsd(1_000_000), value: scaledUsd(p.book.usd) }, usd => change('book', { usd: unscaledUsd(usd) })),
    tests('wall-appeared'));

  const depth = p.depthPane, state = alerts.depthState;
  // Both order-book sounds count the books the two panes add up (book-markets.ts): said where that is not the venues switched on.
  const venues = (): HTMLElement[] => store.state.bookMarkets === 'all' ? [] : [note(t('It counts the books chosen under Venues in the Depth and Liquidity Tracker panes, whatever the venue chips say.'))];
  body.append(heading(t('Depth pane')),
    panelSwitchRow(store, 'depthPane', () => rerender()),
    selectRow(t('Range'), t("Bids and asks within this distance of the price are added up, as the Depth pane's Range does."), DEPTH_RANGES.map(r => [String(r), `${Math.round(r * 1_000) / 10}%`] as [string, string]), String(depth.range), v => change('depthPane', { range: Number(v) })),
    numberRow(t('Percentile'), t('How rare the balance must be: at 99, only one recorded minute in a hundred of the hours before went further.'), { min: 90, max: 99.9, step: 0.5, value: depth.pct }, pct => change('depthPane', { pct })),
    numberRow(t('Compared with (hours)'), t('The hours the percentile is taken over. They are loaded when the sound starts, about 3 MB an hour from a server.'), { min: 2, max: DEPTH_MAX_HOURS, step: 1, value: depth.hours }, hours => change('depthPane', { hours })),
    ...venues(),
    ...(state ? [note(state.loading || state.minutes < DEPTH_MIN_BASELINE ? t('Loading the recording: {n} min so far', { n: String(state.minutes) }) : t('Judging each minute against {n} min of recording', { n: String(state.minutes) }))] : []),
    tests('depth-extreme'));

  body.append(heading(t('Liquidity Tracker')),
    panelSwitchRow(store, 'depth', () => rerender()),
    ...venues(),
    numberRow(t('Tips at (%)'), t('(bids - asks) / (bids + asks), in percent.'), { min: 30, max: 95, step: 5, value: p.depth.pct }, pct => change('depth', { pct })),
    tests('imbalance'));

  body.append(heading(t('Open interest')),
    switchRow(t('Unusual open interest change'), t('A candle closed with an open-interest change that Highlights calls unusual. Two quick ticks.'), p.oi.jump, jump => change('oi', { jump })),
    tests('oi-jump', false));

  const recent = [
    // Written now, in the page's units (an alert keeps the numbers its words name: `Alerts.text`).
    ...alerts.log.slice(-6).map(e => ({ at: e.at, side: e.side, text: alerts.text(e), audible: e.audible })),
    ...sounds.log.filter(e => e.kind !== 'test').slice(-6).map(e => ({ at: e.at, side: e.side ?? null, text: soundLogText(e), audible: e.audible })),
  ].sort((a, b) => b.at - a.at).slice(0, 6);
  body.append(heading(t('Recent')));
  body.append(recent.length ? el('div', { class: 'alert-log' }, ...recent.map(e => el('p', { class: e.side ? `panel-note alert-${e.side}` : 'panel-note', textContent: `${clock(e.at)}  ${e.text}${e.audible ? '' : ' ' + t('(not heard: sound was locked)')}` }))) : note(t('Nothing yet.')));
}
