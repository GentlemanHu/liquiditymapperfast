import type { Store } from '../store.ts';
import { el } from '../dom.ts';
import { heading, note, numberRow, selectRow, switchRow } from '../ui.ts';
import { helpButton } from '../help.ts';
import { compactBar } from '../device.ts';
import { usd } from '../format.ts';
import { t } from '../i18n.ts';
import { LINE_KINDS, MAX_SESSIONS, ROW_MULTIPLES, SESSION_PRESETS, SHARES, ZONES, chartKinds, linesSource, mostCount, newSessionId, recordedCount, type KindSettings, type LineKind, type TradedSettings } from './settings.ts';
import type { SessionDef } from './sessions.ts';
import { candleBarMs } from './levels.ts';
import { profileTarget, type KeyLevelHistory } from '../keylevels/history.ts';
import { currentCoin } from '../coin.ts';
import { venueLabel } from '../venues.ts';
import { BROWSER_RETENTION_MS, RETENTION_MS } from '../../shared/recorder.ts';
import { PROFILE_METRICS, type ProfileMetric } from './metrics.ts';
import { emphasisApplies, splitStyles } from './emphasis.ts';
import { PALETTES, resolveThemeId } from '../theme.ts';

/** Each measure's switch: its name, and what its column shows in a few words (the long notes follow the switches for those on). */
const METRIC_NAMES: Readonly<Record<ProfileMetric, string>> = { volume: t('Traded volume'), oi: t('Open interest change'), absorption: t('Absorption'), liquidations: t('Liquidations') };
const METRIC_TIPS: Readonly<Record<ProfileMetric, string>> = {
  volume: t('What was bought and sold at market at each price.'), oi: t('Where open interest grew or shrank, an estimate.'),
  absorption: t('Market orders that resting orders took, at each price.'), liquidations: t('Reported liquidations at each price.'),
};

/** What each measure is along the top of the chart, by time: what its bars add up, from where, and what they cannot say. */
const TOP_NOTES: Readonly<Record<ProfileMetric, string>> = {
  volume: t('Bought and sold at market in each stretch, on the columns\' markets: to the second for the last day the page holds, to the minute before it, where a bar is a minute at least. Ten minutes or more with no trade on any of them counts as not recorded.'),
  oi: t('Where open interest grew (bid colour) and where it shrank (ask colour) in each stretch, each perpetual on its own, from its readings by the minute whatever the chart\'s timeframe: each change spread over the minutes it came about in by their volume and valued at the prices that traded, as the column does by price. A change across more than an hour, or with nothing traded under it, is not placed, and the header says how much. It never says who bought or sold.'),
  absorption: t('The absorption marks at the threshold the Absorption settings judge them at, on the column\'s markets: market sells resting buyers took (bid colour) and market buys resting sellers took (ask colour). They are loaded for the time on the chart while this shows, marks on or off.'),
  liquidations: t('Liquidations as the column adds them up, every size the record keeps: shorts liquidated (bid colour) and longs liquidated (ask colour). Where the time on the chart holds more than 5,000, only the largest are counted, and the header says so.'),
};

/** What the panel says about where days, weeks and sessions come from: whether the page reads the exchanges itself, and the candles. */
export interface TradedSources { browser: boolean; candles: ((barMs: number) => KeyLevelHistory) | null }

/**
 * The Volume profile panel: its first row switches everything below on and off, keeping every choice; then what the profile looks like,
 * its bars and its value area, the same for both of its forms; the columns by price, which always add up what is on the chart, with the
 * price rows their levels are read from; the same profile by time along the top; the lines on the chart; and the periods drawn on the
 * chart, each day, week, month or session over its own time, with the profiles of one kind of them and the sessions edited where they are
 * asked for. `gridStep` is the map's grid step now, for the row sizes in dollars.
 */
export function buildTradedPanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void, gridStep: () => number, sources: TradedSources = { browser: false, candles: null }): void {
  const s = store.state.traded, kinds = chartKinds(s);
  // The zone days, weeks and months start in is one for all of them: offered when any of them is drawn, named after the shortest (a day's
  // words say the week's too).
  const zoned = (['day', 'week', 'month'] as const).find(k => kinds.includes(k));
  const set = (change: Partial<TradedSettings>, again = false): void => { store.set({ traded: { ...store.state.traded, ...change } }); if (again) rebuild(); };
  // A measure's column on or off, the columns kept in their order; the last one cannot go (the switch above turns the columns off).
  const toggle = (metric: ProfileMetric, on: boolean): void => {
    const now = store.state.traded.metrics, next = PROFILE_METRICS.filter(m => m === metric ? on : now.includes(m));
    if (next.length) set({ metrics: next }, true); else rebuild();
  };
  tools.append(helpButton('traded'));
  const grid = gridStep(), money = (v: number): string => `$${v >= 1 ? usd(v) : v.toPrecision(2)}`;
  const off = !store.state.show.traded;
  // The time profile's heading is where a click on the band's header opens the panel (Toolbar.openTradedPanel).
  const topHead = heading(t('Time profile (along the top)')); topHead.dataset.section = 'top';
  body.append(
    switchRow(t('Show the volume profile'), t('The columns beside the book profile, the same profile along the top of the chart, and the point-of-control lines on the chart.'), store.state.show.traded, on => { store.set({ show: { ...store.state.show, traded: on } }); rebuild(); }),
    // Every choice below is kept while the switch is off, and none of it shows: said rather than leave the rows looking live.
    ...(off ? [note(t('The volume profile is off: nothing set below shows until it is switched on.'))] : []),
    ...(compactBar() ? [note(t('A phone has no room for the column: the lines on the chart still show.'))] : []),
    // What the profile itself looks like, first: the bars, the value area and its share are the same for the columns and the time profile.
    selectRow(t('Bars'), t('Each row and each stretch as its two sides, or only their difference: which side was the bigger, and by how much.'), [['split', t('Buys and sells')], ['delta', t('Delta')]], s.bars, v => set({ bars: v === 'delta' ? 'delta' : 'split' }, true)),
    ...(s.bars === 'delta' ? [note(t('With Delta, each row and each stretch is drawn faintly at its whole size and the difference of its two sides over it, on the same scale: a busy row whose sides were close still shows. The point of control and the value area are read from the whole.'))] : []),
    ...emphasisRows(store, set),
    switchRow(t('Mark the value area'), t('Shade the value area on the columns and along the top, and draw its point of control and its edges across them.'), s.valueArea, valueArea => set({ valueArea })),
    selectRow(t('Value area'), t('The share of the volume the value area holds around the point of control. 70% is the usual one.'), SHARES.map(v => [String(v), `${v}%`] as [string, string]), String(s.share), v => set({ share: Number(v) })),
    heading(t('Columns (by price)')),
    note(t('One column for each measure switched on, side by side on the same price rows, over what is on the chart. The map keeps at least half the width: a narrow one draws only the first columns that fit.')),
    ...PROFILE_METRICS.map(m => switchRow(METRIC_NAMES[m], METRIC_TIPS[m], s.metrics.includes(m), on => toggle(m, on))),
    ...(s.metrics.includes('oi') ? [note(t('Each perpetual\'s change in open interest between its readings (about one a minute) spread over the prices that traded on it in between, by their share of the volume: where exposure grew (bid colour) and where it shrank (ask colour). An estimate of where, never of who: a change does not say which side opened or closed. Each venue counts on its own, and a change with no trades recorded under it, or between readings an hour apart, is not placed: the header says how much.')),
      ...(sources.browser ? [note(t('This page keeps a day of the open-interest readings it takes while it is open: Binance, Bybit and OKX also read back their five-minute history, Hyperliquid, Bitget and Deribit have only what the page took.'))] : [])] : []),
    ...(s.metrics.includes('absorption') ? [note(t('The absorption marks at the threshold the Absorption settings judge them at, each counted once: market sells resting buyers took (bid colour) and market buys resting sellers took (ask colour). Where a minute kept only its largest groups, the header says so.'))] : []),
    ...(s.metrics.includes('liquidations') ? [note(t('Liquidations as the venues report them: shorts liquidated, forced buys (bid colour), and longs liquidated, forced sells (ask colour). Only Binance, Bybit, OKX and Deribit report them, Binance at most one a market a second, so this is what was reported, not all there was.'))] : []),
    // The level rows are dollars of price: they belong to the columns; time has its own interval, set by the zoom.
    selectRow(t('Row size'), t('The price rows the point of control is read from, at every price that traded: larger rows give a steadier level. Auto is the map\'s grid step.'),
      ROW_MULTIPLES.map(m => [String(m), m === 1 ? t('Auto ({value})', { value: money(grid) }) : money(grid * m)] as [string, string]), String(s.rows), v => set({ rows: Number(v) })),
    // A drag adds up traded volume at those prices, whatever the column shows: said only where traded volume has a column of its own.
    ...(s.metrics.includes('volume') ? [note(t('Drag on the column (or click a row) to add up those prices in the Range panel.'))] : []),
    // The same profile by time, set here with the columns it clones (Karl, 2026-10-20). Choosing its measure changes only the measure.
    topHead,
    switchRow(t('Profile by time'), t('The same profile laid on the time axis: one bar for each stretch of the chart, growing down from the top, with the bars and the value area set above.'), s.top.on, on => set({ top: { ...store.state.traded.top, on } }, true)),
    selectRow(t('Measure'), t('What the bars along the top add up: any of the columns\' measures, with a column of its own or not. Its header names it.'), PROFILE_METRICS.map(m => [m, METRIC_NAMES[m]] as [string, string]), s.top.metric,
      v => set({ top: { ...store.state.traded.top, metric: PROFILE_METRICS.find(m => m === v) ?? 'volume' } }, true)),
    note(TOP_NOTES[s.top.metric]),
    note(t('Each bar adds up a stretch of a round length, from a second to a day, about as thin as the column\'s rows at the zoom: zoom in for finer ones. Where the data is no finer (the flow before the last day, open interest), the caption says so. Point at a bar for its figures; click its header for these settings.')),
    heading(t('Lines on the chart')),
    ...(!s.metrics.includes('volume') ? [note(t('With no traded volume column, the lines across the chart are the first column\'s; days, weeks, months and sessions are worked out from traded volume only.'))] : []),
    switchRow(t('Point of control'), t('The price that traded the most, as a line.'), s.poc, poc => set({ poc })),
    switchRow(t('Value area high and low'), t('The top and the bottom of the value area (VAH and VAL), as dashed lines.'), s.va, va => set({ va })),
    switchRow(t('Labels'), t('Each line\'s name and price at its right end, where there is room.'), s.labels, labels => set({ labels })),
    switchRow(t('Tags on the price axis'), t('The name of each line that reaches the right edge, beside its price.'), s.tags, tags => set({ tags })),
    // The periods are drawn on the chart over their own time, never in the columns, which stay with what is on the chart (Karl, 2026-10-19).
    heading(t('Periods on the chart')),
    ...LINE_KINDS.flatMap(k => [
      switchRow(kindName(k), t('Its point of control and value area lines on the chart, over each one\'s own time, with its past ones.'), s.lines.includes(k),
        on => set({ lines: LINE_KINDS.filter(x => x === k ? on : store.state.traded.lines.includes(x)) }, true)),
      // The sessions are edited right under the switch that asks for them, not at the panel's foot where they read as something else.
      ...(k === 'sessions' && kinds.includes('sessions') ? [sessionEditor(store, set)] : []),
    ]),
    selectRow(t('Profiles on the chart'), t('The traded-volume profile of each day, week, month or session, drawn on the chart from its start: one kind, so they never lie over each other.'),
      [['', t('None')], ...LINE_KINDS.map(k => [k, kindName(k)] as [string, string])], s.profiles ?? '', v => set({ profiles: LINE_KINDS.find(k => k === v) ?? null }, true)),
    ...(zoned
      ? [selectRow(zoned === 'day' ? t('Days start in') : zoned === 'week' ? t('Weeks start in') : t('Months start in'), zoned === 'month' ? t('The time zone whose midnight on the 1st starts a month.') : t('The time zone whose midnight starts a day, and whose Monday a week.'), ZONES.map(z => [z.zone, z.label] as [string, string]), s.zone, zone => set({ zone }))] : []),
  );
  if (kinds.length) {
    // The rows below speak for every kind drawn; where they differ, for the first that is not a month (a month is always from candles).
    const first: LineKind = kinds.find(k => k !== 'month') ?? 'month', k: KindSettings = { ...s, period: first };
    const target = profileTarget(currentCoin()), market = target ? `${venueLabel(target.id)} ${target.listing.symbol}` : '', source = linesSource(k);
    // A month is longer than the recording keeps: it is worked out from candles only, and the panel says so rather than offer the choice.
    if (kinds.includes('month')) body.append(note(t('A month is longer than the recording keeps: its lines come from candles, an estimate marked ≈.')));
    if (first !== 'month') body.append(selectRow(t('Worked out from'), t('The recording: the trades of every venue the flow column counts, for as long as it keeps them. Candles: one market\'s, reaching back months, an estimate.'),
      [['recorded', t('The recording')], ['candles', target ? t('{market} candles', { market }) : t('Candles')]], s.source, v => set({ source: v === 'candles' ? 'candles' : 'recorded' }, true)));
    // From the recording, only as many as it still holds: a count it cannot work out is not offered.
    const most = source === 'candles' ? mostCount(k) : recordedCount(first, sources.browser ? BROWSER_RETENTION_MS : RETENTION_MS);
    if (most >= 1) body.append(numberRow(t('How many'), t('How many past ones are drawn, the one under way among them (of each session).'), { min: 1, max: most, step: 1, value: Math.min(s.count, most) }, count => set({ count: Math.max(1, Math.min(most, Math.round(count))) })));
    if (s.lines.length) body.append(switchRow(t('Extend untouched points of control'), t('A past point of control that price has not traded through since (a naked one) runs on, dotted, to where it was reached, or to the right edge.'), s.naked, naked => set({ naked })));
    if (source === 'recorded') {
      body.append(note(sources.browser
        ? t('This page keeps a day of trades, and only while it is open: it works out today and the last session at most, and no week. For older ones, work them out from candles.')
        : t('The recording keeps a week of trades: it works out the last seven days or sessions at most and the week under way. For older ones, work them out from candles.')));
    } else if (!target) {
      body.append(note(t('No market of this coin has candles the page can read.')));
    } else {
      // The candle size the lines use (five minutes, or one for a session off the five).
      const fine = candleBarMs(k) === 60_000;
      body.append(note(t('From the {minutes}-minute candles of {market}, each one\'s volume spread evenly over its range: one market, and an estimate, marked ≈. On six recorded days the value area high and low mostly came within a row or two of the recording\'s (the low once 4 and once 10 rows off); where two prices traded almost the same, the point of control can sit on the other.', { minutes: fine ? 1 : 5, market })));
      if (sources.candles?.(fine ? 60_000 : 300_000).state === 'unavailable') body.append(note(t('Its history could not be read just now; trying again in a minute.')));
    }
    body.append(note(t('A day, week or session is drawn only when nine in ten of it is held: of the candles\' bars, or of the recording\'s trades, estimated from each venue\'s volume while it was recorded. Whether a point of control was traded through is read from the candles of the market on the chart.')));
  }
}

/**
 * The switch that strengthens the bigger side of each split bar, and its key: three rows of one length, one even, one three to one, one
 * nearly all one side, drawn with the theme's own colours as the bars are (traded/emphasis.ts). With Delta bars it does nothing (they show
 * only the difference already), so it is greyed out with the reason, not hidden.
 */
function emphasisRows(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement[] {
  const s = store.state.traded, applies = emphasisApplies(s.bars), on = s.emphasis && applies;
  const row = switchRow(t('Emphasise the bigger side'), applies
    ? t('In each row and each stretch the bigger side is drawn stronger and the smaller one fainter, the more one-sided the more; thin rows stay even. It shows what happened, not what comes next.')
    : t('Delta bars draw only the difference of the two sides, which already says which was the bigger: this applies to split bars.'), s.emphasis, emphasis => set({ emphasis }, true));
  if (!applies) { row.querySelector('input')!.disabled = true; row.classList.add('off'); }
  const palette = PALETTES[resolveThemeId(store.state.theme)]!;
  const example = (b: number, label: string): HTMLElement => {
    const [first, second] = splitStyles(b, 100 - b, 100, 0, palette, on);
    const part = (share: number, style: { color: string; alpha: number }): HTMLElement => { const x = el('span'); x.style.width = `${share}%`; x.style.background = style.color; x.style.opacity = String(style.alpha); return x; };
    return el('div', { class: 'emphasis-row' }, el('span', { textContent: label }), el('span', { class: 'emphasis-bar' }, part(b, first), part(100 - b, second)));
  };
  return [row, el('div', { class: 'emphasis-key' }, example(50, '50 / 50'), example(75, '75 / 25'), example(95, '95 / 5'),
    el('p', { class: 'panel-note', textContent: t('Length: how much. Strength of colour: how one-sided.') }))];
}

/** What each kind of window is called where it is switched on or chosen. */
const kindName = (k: LineKind): string => k === 'day' ? t('Each day') : k === 'week' ? t('Each week') : k === 'month' ? t('Each month') : t('Sessions');

/** The session list: each one on or off, its name, start, end, zone and whether it skips weekends; add one from the usual ones, or remove it. */
function sessionEditor(store: Store, set: (change: Partial<TradedSettings>, again?: boolean) => void): HTMLElement {
  const sessions = store.state.traded.sessions;
  const update = (id: string, change: Partial<SessionDef>, again = false): void => set({ sessions: store.state.traded.sessions.map(x => x.id === id ? { ...x, ...change } : x) }, again);
  const rows = sessions.map(x => {
    const on = el('input', { type: 'checkbox', checked: x.on, ariaLabel: t('On') }); on.onchange = () => update(x.id, { on: on.checked }, true);
    const name = el('input', { type: 'text', value: x.name, maxLength: 40, ariaLabel: t('Name'), class: 'session-name' }); name.onchange = () => update(x.id, { name: name.value.trim().slice(0, 40) });
    const start = el('input', { type: 'time', value: x.start, ariaLabel: t('Starts'), class: 'session-time' }); start.onchange = () => { if (/^\d{2}:\d{2}$/.test(start.value)) update(x.id, { start: start.value }, true); };
    const end = el('input', { type: 'time', value: x.end, ariaLabel: t('Ends'), class: 'session-time' }); end.onchange = () => { if (/^\d{2}:\d{2}$/.test(end.value)) update(x.id, { end: end.value }, true); };
    const zone = el('select', { ariaLabel: t('Time zone'), class: 'session-zone' });
    for (const z of ZONES) if (z.zone !== 'page') zone.append(new Option(z.label, z.zone));
    if (![...zone.options].some(o => o.value === x.zone)) zone.append(new Option(x.zone, x.zone));
    zone.value = x.zone; zone.onchange = () => update(x.id, { zone: zone.value });
    const weekdays = el('input', { type: 'checkbox', checked: x.weekdays }); weekdays.onchange = () => update(x.id, { weekdays: weekdays.checked });
    const remove = el('button', { type: 'button', class: 'session-remove', ariaLabel: t('Remove'), tip: t('Remove this session'), onclick: () => set({ sessions: store.state.traded.sessions.filter(y => y.id !== x.id) }, true) });
    return el('div', { class: 'session-row' }, on, name, start, el('span', { class: 'session-dash', textContent: '–' }), end, zone,
      el('label', { class: 'session-weekdays', tip: t('Only Monday to Friday, in the session\'s zone.') }, weekdays, el('span', { textContent: t('Mon–Fri') })), remove);
  });
  const full = sessions.length >= MAX_SESSIONS;
  const add = (preset: Omit<SessionDef, 'id' | 'on'>): void => { const list = store.state.traded.sessions; if (list.length >= MAX_SESSIONS) return; set({ sessions: [...list, { ...preset, id: newSessionId(list), on: true }] }, true); };
  const adders = el('div', { class: 'session-add' }, el('span', { class: 'desc', textContent: t('Add:') }),
    ...SESSION_PRESETS.map(p => el('button', { type: 'button', textContent: p.name, disabled: full, tip: `${p.start}–${p.end}`, onclick: () => add(p) })),
    el('button', { type: 'button', textContent: t('Custom'), disabled: full, onclick: () => add({ name: t('Session'), zone: 'UTC', start: '00:00', end: '08:00', weekdays: false }) }));
  return el('div', { class: 'session-editor' },
    heading(t('Sessions')),
    ...(rows.length ? rows : [el('p', { class: 'panel-note', textContent: t('No sessions yet: add one below.') })]),
    adders,
    note(t('Times are the clock in the session\'s zone, so a session follows that zone\'s daylight saving. One that ends at or before its start runs past midnight; the same start and end is a whole day. Crypto trades every day, so every day has its sessions unless Mon–Fri is ticked.')));
}
