import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import type { Store } from '../store.ts';
import type { View } from '../view.ts';
import { helpButton } from '../help.ts';
import { setTip } from '../tip.ts';
import { t, tn } from '../i18n.ts';
import { clock, price as fmtPrice } from '../format.ts';
import { HoverCard } from '../hovercard.ts';
import type { InfoLine } from '../infobox.ts';
import { togglePanel, type Panel } from '../ui.ts';
import { TimePane, setText } from './lower-panes.ts';
import { leftGutter, type ScriptLegendLine } from './heat-pane.ts';
import { el } from '../dom.ts';
import { ScriptHost, type WorkerLike } from '../script/host.ts';
import { ScriptData } from '../script/data.ts';
import { UNREAD_VENUE, analyze, sourcesWith, type Analysis } from '../script/lang/analysis.ts';
import { ScriptSyntaxError, type ScriptError } from '../script/lang/lexer.ts';
import { SCRIPT_API, loadScripts, storeScripts, type ScriptRecord } from '../script/records.ts';
import { starterScripts } from '../script/starter.ts';
import { PLOT_FIELDS, type PlotOut, type ScriptResult, type Warning } from '../script/protocol.ts';
import { paintPlot, plotColorAt, scaleIdOf, scalesOf, shortNumber, visibleRange, yOf, type Frame } from '../script/paint.ts';
import { errorText } from '../script/messages.ts';
import { safeColor } from '../script/lang/colors.ts';
import type { SourceFilter } from '../script/inputs.ts';
import { unsaved, type ScriptsPanelState } from '../script/panel-state.ts';
import { lazy } from '../lazy.ts';

/**
 * A script's last answer, the candles it was worked out over (their starts, timeframe and market) and the moment it was worked out at: the
 * replay's moment then, Infinity live, -Infinity for an answer made on the page (a script that does not read).
 */
interface Held { result: ScriptResult; time: Float64Array; tf: number; inst: string; at: number }

/** The replay candle the page is at (a run's inputs stop at the candles closed by then), or -1 live. */
const replayKey = (tf: number): number => replaying() ? Math.floor(pageNow() / tf) : -1;

/**
 * How many of an answer's candles may be shown: all of them live; in a replay only those closed by its moment, whatever moment the answer
 * was worked out at (a script's value at a candle depends only on that candle and the ones before it, so those are what a replay run gives).
 */
function shownCount(time: Float64Array, tf: number): number {
  if (!replaying()) return time.length;
  const now = pageNow();
  let lo = 0, hi = time.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (time[m]! + tf <= now) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * The candle a pointer at `at` reads, of the first `shown` of an answer's candles: the one it is over, or right of the newest shown (or over
 * the price axis) the newest, as the built-in panes' popups do (`readAt`): landing on the last candle is a hunt. Never past what may be shown
 * (a replay's moment); a time in a gap between candles reads nothing (-1).
 */
function indexAt(time: Float64Array, tf: number, at: number, shown: number): number {
  let lo = 0, hi = time.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (time[m]! <= at) { i = m; lo = m + 1; } else hi = m - 1; }
  const newest = shown - 1;
  if (i > newest) i = newest;
  return i < 0 || (i < newest && at >= time[i]! + tf) ? -1 : i;
}

/** How many of a script's plots its popup lists (the others are counted). */
const CARD_PLOTS = 6;

/** How often a script runs at most (ms), and how often it runs again anyway while nothing it reads changes (the candle under way fills in). */
const MIN_INTERVAL = 1_000, REFRESH = 15_000;

/**
 * The Scripts pane: a row for each of the person's scripts that is switched on, each with its own scales, drawn over the map's time axis.
 * The scripts run in a worker of their own (script/script.worker.ts), never on this thread; this pane gathers what they read
 * (script/data.ts), asks for a run at most once a second, and less often when a run takes longer (four times its length apart), so a heavy
 * script cannot keep a core busy. The Scripts… button opens the panel that lists, writes, imports and exports them (script/panel.ts).
 */
export class ScriptPane extends TimePane {
  #records: ScriptRecord[] = loadScripts(undefined, starterScripts);
  #version = 0;
  #host = new ScriptHost({ spawn: () => new Worker(new URL('../script/script.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike });
  #data: ScriptData;
  #analysis = new Map<string, Analysis | ScriptError>();
  /** Each script's last answer; a new map at every run, so what is worked out from it can tell when to work it out again. */
  #held = new Map<string, Held>();
  #warnings = new Map<string, Warning[]>();
  #lastRun = 0; #runMs = 0; #timer = 0; #running = false; #runToken = 0; #starting = false;
  #seen: { candles: unknown; loads: number; data: number; version: number; tf: string; markets: unknown; venues: unknown; scope: string } | null = null;
  #card = new HoverCard();
  #lines: InfoLine[] | null = null;
  #panel: Panel | null = null;
  readonly #ui: ScriptsPanelState = { editing: null, draft: null, message: null, armed: null };
  #button: HTMLButtonElement;

  constructor(host: HTMLElement, store: Store, view: View, private hub: Hub) {
    super(host, store, view, 'script');
    this.#data = new ScriptData(hub, () => this.refresh());
    // Scripts that will run: their worker loads now, while the page's own requests have not yet taken the connections to its server.
    if (store.state.show.script && this.#records.some(r => r.on)) this.#host.warm();
    this.head.innerHTML = `<strong>${t('Scripts')}</strong><span class="readout"></span>`;
    this.head.querySelector('strong')!.after(helpButton('scriptPane'));
    setTip(this.head.querySelector('strong')!, t('Your own indicators, written as scripts over the candles and the taker flow.'));
    const group = document.createElement('span'); group.className = 'ctl ctl-group'; this.head.append(group);
    this.#button = document.createElement('button'); this.#button.type = 'button'; this.#button.textContent = t('Scripts…');
    setTip(this.#button, t('Write, switch on and off, import and export your scripts.'));
    this.#button.onclick = () => this.openPanel();
    group.append(this.#button);
    this.root.append(this.#rowTools);
  }

  /** The scripts, in their order. */
  get records(): readonly ScriptRecord[] { return this.#records; }
  /** A script's last answer, its warnings, and what reading it found (or why it could not be read). */
  resultOf(id: string): ScriptResult | null { const held = this.#held.get(id); return held && this.#fresh(held) ? held.result : null; }
  warningsOf(id: string): readonly Warning[] { return this.#warnings.get(id) ?? []; }
  analysisOf(r: ScriptRecord): Analysis | ScriptError { return this.#analyze(r.source); }
  /** Whether Scripts is on: the scripts run and draw. */
  get running(): boolean { return this.store.state.show.script; }
  /** Switch Scripts on: a script was added or switched on, and should be seen. */
  showScripts(): void { const show = this.store.state.show; if (!show.script) this.store.set({ show: { ...show, script: true } }); }

  /** Keep an answer made here, as a new map (what is worked out from the answers, the candle colours, is worked out again). */
  #setHeld(id: string, held: Held): void { this.#held = new Map(this.#held).set(id, held); this.#heldGen++; this.onMapChanged(); }

  /** Whether a script that is on draws in a row of this pane: the pane is shown only then (and only while Scripts is on). */
  get hasRows(): boolean { return this.#records.some(r => r.on && r.place === 'pane'); }
  /** The buttons beside each row's name (open the script, switch it off), a layer over the canvas; placed again only when a row moves. */
  #rowTools = el('div', { class: 'script-row-tools' });
  #rowToolsKey = '';

  /** Open a script in the Scripts panel, from `anchor` (a row's or the map legend's button); one being written with changes not saved stays. */
  openScript(id: string, anchor: HTMLElement): void {
    const r = this.#records.find(x => x.id === id); if (!r) return;
    if (!(this.#ui.editing && this.#ui.editing !== id && unsaved(this, this.#ui)) && this.#ui.editing !== id) {
      this.#ui.editing = id; this.#ui.draft = { name: r.name, source: r.source, options: { ...r.options }, place: r.place }; this.#ui.message = null;
    }
    if (this.#panel) this.#panel.render(this.#build); else this.openPanel(anchor);
  }

  /** Switch a script off from where it is drawn (it stays in the list, to be switched on again there). */
  switchOff(id: string): void {
    this.setRecords(this.#records.map(r => r.id === id ? { ...r, on: false } : r));
    if (this.#panel && !this.#ui.editing) this.#panel.render(this.#build);
  }

  /** Put each row's buttons beside its name (`places` in the plot's coordinates); nothing changes while no row moved. */
  #placeRowTools(places: readonly { id: string; x: number; y: number }[]): void {
    const dx = this.canvas.offsetLeft + leftGutter(this.store.state), dy = this.canvas.offsetTop;
    const key = `${dx},${dy}|${places.map(p => `${p.id}:${Math.round(p.x)},${Math.round(p.y)}`).join('|')}`;
    if (key === this.#rowToolsKey) return;
    this.#rowToolsKey = key;
    this.#syncTools(this.#rowTools, this.#rowButtons, places, dx, dy);
  }
  #rowButtons = new Map<string, HTMLElement>();

  /** The buttons of the map legend's script lines, a layer the page puts over the map (`places` in the map pane's own pixels). */
  readonly legendTools = el('div', { class: 'script-row-tools script-legend-tools' });
  #legendToolsKey = '';
  placeLegendTools(places: readonly { id: string; x: number; y: number }[]): void {
    const key = places.map(p => `${p.id}:${Math.round(p.x)},${Math.round(p.y)}`).join('|');
    if (key === this.#legendToolsKey) return;
    this.#legendToolsKey = key;
    this.#syncTools(this.legendTools, this.#legendButtons, places, 0, 0);
  }
  #legendButtons = new Map<string, HTMLElement>();

  /**
   * Each script's two buttons, open and switch off, at its place (offset by `dx`, `dy`) in `layer`: a script's buttons are made once and moved
   * after, so a panel opened from one keeps its anchor and a focused one keeps the focus; a script no longer listed loses its buttons.
   */
  #syncTools(layer: HTMLElement, made: Map<string, HTMLElement>, places: readonly { id: string; x: number; y: number }[], dx: number, dy: number): void {
    const wanted = new Set(places.map(p => p.id));
    for (const [id, box] of made) if (!wanted.has(id)) { box.remove(); made.delete(id); }
    for (const place of places) {
      let box = made.get(place.id);
      if (!box) {
        const open = el('button', { type: 'button', class: 'script-row-open', ariaLabel: t('Open this script to change it'), tip: t('Open this script to change it') });
        open.onclick = () => this.openScript(place.id, open);
        const off = el('button', { type: 'button', class: 'script-row-off', textContent: '×', ariaLabel: t('Switch this script off (it stays in Scripts…)'), tip: t('Switch this script off (it stays in Scripts…)') });
        off.onclick = () => this.switchOff(place.id);
        box = el('span', { class: 'script-row-tool' }, open, off);
        made.set(place.id, box); layer.append(box);
      }
      box.style.left = `${Math.round(dx + place.x)}px`; box.style.top = `${Math.round(dy + place.y)}px`;
    }
  }

  /**
   * The map legend's lines for the scripts drawn on the map: each one's name, the colour of its first plot, and its values at the candle
   * starting at `at` (null, or right of the newest: the newest shown), or what it is doing (running..., its error).
   */
  mapLegend(at: number | null, valued = Infinity): ScriptLegendLine[] {
    const state = this.store.state, out: ScriptLegendLine[] = [];
    if (!state.show.script) return out;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, p = this.palette, fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    for (const r of this.#records) {
      if (!r.on || r.place !== 'map') continue;
      // Only the first `valued` lines show values (the legend lists a few, and none on a phone): the others are named, not worked out.
      const withValues = out.length < valued;
      const kept = this.#held.get(r.id), held = kept && this.#fresh(kept) ? kept : undefined;
      if (!held) { out.push({ id: r.id, name: r.name, color: '', text: t('running…'), tone: 'muted' }); continue; }
      if (!held.result.ok) { out.push({ id: r.id, name: r.name, color: '', text: errorText(held.result.error), tone: 'error' }); continue; }
      const res = held.result, time = held.time, shown = shownCount(time, tf);
      const i = at === null ? shown - 1 : indexAt(time, tf, at, shown);
      const band = (plot: PlotOut): boolean => (plot.kind === 'brokenarea' || plot.kind === 'cloudarea') && plot.colors !== null;
      const finiteAt = (plot: PlotOut): boolean => i >= 0 && PLOT_FIELDS[plot.kind].some(f => Number.isFinite(plot.fields[f]![i]!));
      // Lines first (they are what a legend reads), then the other plots; bands coloured point by point only when there is nothing else.
      const plots = res.plots.map((plot, j) => ({ plot, j })).filter(({ plot }) => plot.style.visible !== false).sort((a, b) => Number(b.plot.kind === 'line') - Number(a.plot.kind === 'line'));
      const read = plots.filter(({ plot }) => !band(plot) && finiteAt(plot)), from = read.length ? read : plots.filter(({ plot }) => finiteAt(plot));
      // Its colour as it is drawn at this candle (the painter's own choice: a point's colour, the plot's for its kind, the page's for its place).
      const first = from[0] ?? plots[0];
      const color = first ? plotColorAt(first.plot, Math.max(0, i), fallbacks[first.j % fallbacks.length]!, p.candleUp, p.candleDown) : '';
      let text = '';
      if (withValues && i >= 0) {
        const texts = from.slice(0, 3).map(({ plot }) => {
          const fmt = scaleIdOf(plot, r.options) === 'right' ? (v: number) => fmtPrice(v) : shortNumber;
          return PLOT_FIELDS[plot.kind].map(f => plot.fields[f]![i]!).filter(Number.isFinite).map(fmt).join(' – ');
        });
        text = texts.join(' · ') + (from.length > 3 ? ' …' : '');
      }
      out.push({ id: r.id, name: r.name, color, text, tone: 'text' });
    }
    return out;
  }

  /** Called when `hasRows` changed: the page lays its panes out again. */
  onRowsChanged: () => void = () => {};
  /** Called with what the scripts are doing, for the Scripts lamp: `running` (one that is on waits for its first answer), `error` and the name of one that stopped, or ''. */
  onStatus: (note: 'running' | 'error' | '', name: string) => void = () => {};
  #statusKey = ''; #rowsKey = '';

  /** Keep `list` as the scripts; false when this browser refused to store it (the list still applies until the page closes). */
  setRecords(list: ScriptRecord[]): boolean {
    const hadRows = this.hasRows;
    // A script whose text, options or version changed has no answer until it runs again: the old one is not drawn meanwhile.
    const was = new Map(this.#records.map(r => [r.id, r]));
    const stale = list.filter(r => { const o = was.get(r.id); return !o || o.source !== r.source || o.api !== r.api || JSON.stringify(o.options) !== JSON.stringify(r.options) || !r.on; });
    if (stale.some(r => this.#held.has(r.id))) { this.#held = new Map(this.#held); for (const r of stale) this.#held.delete(r.id); this.#heldGen++; this.onMapChanged(); }
    this.#records = list;
    this.#version++;
    // A run still waiting for its worker to load holds the old scripts: dropped now, not at the next frame (the worker may load before it).
    this.#host.dropUnsent();
    for (const id of [...this.#held.keys()]) if (!list.some(r => r.id === id)) this.#held.delete(id);
    const kept = storeScripts(list);
    this.#lastRun = 0;
    this.refresh();
    this.#reportStatus();
    if (this.hasRows !== hadRows) this.onRowsChanged();
    return kept;
  }

  /**
   * What the scripts read changed, or a run may be due: draw again and look whether to run, now. A run is not left to a drawing: while only
   * scripts on the map are on the pane is not laid out and draws nothing.
   */
  refresh(): void { this.invalidate(); this.#maybeRun(); }

  /** Scripts was switched on or off: off, a run still waiting for its worker to load is dropped; the list's statuses and the lamp follow at once. */
  showChanged(): void {
    if (!this.store.state.show.script) this.#host.dropUnsent();
    this.#refreshPanel(); this.#reportStatus(); this.#maybeRun();
  }

  /** The panel's code, loaded the first time the panel opens (a page that never opens it does not carry it). */
  #panelCode: typeof import('../script/panel.ts') | null = null;
  readonly #build = (_tools: HTMLElement, body: HTMLElement): void => { this.#panelCode?.buildScriptsPanel(this, body, () => this.#panel?.render(this.#build), this.#ui); };
  openPanel(anchor: HTMLElement = this.#button): void {
    if (!this.#panelCode) { void lazy(() => import('../script/panel.ts')).then(m => { if (m) { this.#panelCode = m; this.openPanel(anchor); } }); return; }
    this.#panel = togglePanel(anchor, { title: t('Scripts'), width: 520, align: 'right', onClose: () => { this.#panel = null; this.#panelCode?.panelClosed(this, this.#ui); }, stays: true }, this.#build);
  }
  /** Write the list's statuses again with the latest results, in place (a menu or a switch under the pointer stays); not while a script is being written. */
  #refreshPanel(): void { if (this.#panel && !this.#ui.editing) this.#panelCode?.refreshStatuses(this, this.#panel.body); }

  #analyze(source: string): Analysis | ScriptError {
    let a = this.#analysis.get(source);
    if (!a) {
      try { a = analyze(source); } catch (e) { if (e instanceof ScriptSyntaxError) a = e.info; else throw e; }
      if (this.#analysis.size > 64) this.#analysis.clear();
      this.#analysis.set(source, a);
    }
    return a;
  }

  /** Whether the inputs changed since the last run, and if a run is due, start one. */
  #maybeRun(): void {
    const state = this.store.state;
    const on = this.#records.filter(r => r.on);
    // Nothing to run: a run still waiting for its worker to load is dropped, so the worker never runs scripts switched off meanwhile.
    if (!state.show.script || !on.length) { this.#host.dropUnsent(); return; }
    // A run under way is waited for; one still waiting for its worker to load is replaced by a newer request; one being asked for is not asked twice.
    if (this.#starting || (this.#running && !this.#host.loading)) return;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const seen = { candles: state.candles, loads: this.hub.flow.loads, data: this.#data.version, version: this.#version, tf: state.timeframe, markets: state.markets, venues: state.disabledVenues, scope: state.scope, inst: state.seriesInstrument, replay: replayKey(tf) };
    const was = this.#seen, now = Date.now();
    const changed = !was || Object.keys(seen).some(k => (seen as Record<string, unknown>)[k] !== (was as Record<string, unknown>)[k]);
    // Nothing changed: run again at the refresh anyway (the candle under way fills in from the flow), on a timer, so a quiet page still refreshes.
    if (!changed && now - this.#lastRun < REFRESH) { this.#wake(this.#lastRun + REFRESH - now); return; }
    const interval = Math.max(MIN_INTERVAL, this.#runMs * 4), wait = this.#lastRun + interval - now;
    if (wait > 0) { this.#wake(wait); return; }
    this.#seen = seen;
    this.#starting = true;
    try { this.#run(on); } finally { this.#starting = false; }
  }

  /** Draw again (and so look whether a run is due) in `ms`. */
  #wakeAt = 0;
  #wake(ms: number): void {
    const at = Date.now() + Math.max(50, ms);
    if (this.#timer && this.#wakeAt <= at) return;
    if (this.#timer) window.clearTimeout(this.#timer);
    this.#wakeAt = at;
    this.#timer = window.setTimeout(() => { this.#timer = 0; this.#wakeAt = 0; this.refresh(); }, at - Date.now());
  }

  #run(on: readonly ScriptRecord[]): void {
    const state = this.store.state;
    const filters = new Map<string, SourceFilter>([['', {}]]);
    const runnable: ScriptRecord[] = [];
    for (const r of on) {
      if (r.api > SCRIPT_API) { this.#pageError(r.id, { code: 'newer-api', line: 0, col: 0 }); continue; }
      const a = this.#analyze(r.source);
      if (!('program' in a)) { this.#pageError(r.id, a); continue; }
      // Its markets as its options name them (`exchange=options.venue`): the worker works them out from the same values.
      for (const [k, f] of sourcesWith(a, r.options)) filters.set(k, f);
      runnable.push(r);
    }
    // A look that runs nothing is paced like a run, or a map drawn again for its errors would look again at once, frame after frame.
    if (!runnable.length) { this.#host.dropUnsent(); this.#lastRun = Date.now(); return; }
    const inputs = this.#data.inputs(state, filters);
    if (!inputs) { this.#host.dropUnsent(); return; }
    // What each script reads that the page cannot give it: an option it reads but does not declare that is not set, a set of markets with none.
    const markets = this.#data.markets(state, filters);
    for (const r of runnable) {
      const a = this.#analyze(r.source) as Analysis, w: Warning[] = [];
      for (const name of a.read) if (!(name in r.options)) w.push({ code: 'unset-option', detail: name });
      for (const [k, f] of sourcesWith(a, r.options)) {
        if (f.venues?.includes(UNREAD_VENUE)) w.push({ code: 'unread-source' });
        else if (k && !markets.get(k)?.length) w.push({ code: 'no-markets', detail: k.replace(/;/g, ', ') });
      }
      if (this.#data.liquidationsCut && (a.inputs.has('lbuy') || a.inputs.has('lsell'))) w.push({ code: 'liquidations-cut' });
      this.#warnings.set(r.id, w);
    }
    const time = inputs.time.slice(), tf = inputs.tf, inst = state.seriesInstrument, at = replaying() ? pageNow() : Infinity, started = Date.now();
    const token = ++this.#runToken;
    this.#running = true; this.#lastRun = started;
    const version = this.#version;
    void this.#host.run(runnable.map(r => ({ id: r.id, source: r.source, options: r.options, api: r.api })), inputs).then(({ results, ms }) => {
      // A newer request replaced this one before its worker took it: the newer one's answer is the one that counts.
      if (token !== this.#runToken) return;
      this.#running = false;
      // Dropped before its worker took it (the scripts changed, or were switched off): look again now, or nothing may ask while the map is covered.
      if (!results.length) { this.refresh(); return; }
      // Scripts changed while it ran (edited, switched off, deleted): its answer is stale, and the next run is due at once.
      if (version !== this.#version) { this.refresh(); return; }
      // The run's own time (a worker that waited to load, or never did, is not a slow script): a slow script runs less often, spaced
      // from when it started in its worker.
      this.#runMs = ms; this.#lastRun = Date.now() - ms;
      for (const res of results) this.#held.set(res.id, { result: res, time, tf, inst, at });
      this.#held = new Map(this.#held); this.#heldGen++;
      this.invalidate();
      this.onMapChanged();
      this.#refreshPanel();
      this.#reportStatus();
      // The next look is set now (the refresh timer), not left to a drawing: a map covered by another tab draws nothing.
      this.#maybeRun();
    });
  }

  /** Keep an error met on the page (a script that does not read, one for a newer page); the same one again changes nothing, so nothing is drawn again for it. */
  #pageError(id: string, error: ScriptError): void {
    const was = this.#held.get(id);
    if (was && was.tf === 0 && !was.result.ok && JSON.stringify(was.result.error) === JSON.stringify(error)) return;
    this.#setHeld(id, { result: { id, ok: false, error }, time: new Float64Array(0), tf: 0, inst: '', at: -Infinity });
  }

  /** Whether an answer may be read now: one for the chart as it is (`#current`), or an error met on the page, which holds everywhere. */
  #fresh(held: Held): boolean { return held.tf === 0 || this.#current(held, TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000); }

  /**
   * Whether an answer is for the chart as it is now: its timeframe, its market, and in a replay one worked out at or before the replay's
   * moment (never a live one, never one from before a rewind: what was read later may differ for the same candles), of which only the
   * candles closed by then are shown (`shownCount`).
   */
  #current(held: Held, tf: number): boolean { return held.tf === tf && held.inst === this.store.state.seriesInstrument && held.at <= (replaying() ? pageNow() : Infinity); }

  /** Tell the lamp what the scripts are doing, when that changed. */
  #reportStatus(): void {
    const state = this.store.state, tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    let note: 'running' | 'error' | '' = '', name = '';
    if (state.show.script) for (const r of this.#records) {
      if (!r.on) continue;
      const held = this.#held.get(r.id), fresh = !!held && this.#current(held, tf);
      // An error met on the page (the script does not read, or is for a newer page: tf 0) holds everywhere; one met in a run, only there.
      if (held && !held.result.ok && (held.tf === 0 || fresh)) { note = 'error'; name = r.name; break; }
      if (!fresh) note = 'running';
    }
    const key = `${note}|${name}`;
    if (key !== this.#statusKey) { this.#statusKey = key; this.onStatus(note, name); }
    // The list's statuses follow, in place, whenever one script's changes (entering a replay, say, leaves its answers waiting for the
    // replay's first run), whether or not the lamp's does.
    let rows = state.show.script ? 'on' : 'off';
    for (const r of this.#records) { const h = this.#held.get(r.id); rows += `|${r.id}:${!h ? '-' : !this.#fresh(h) ? 's' : h.result.ok ? 'o' : 'e'}`; }
    if (rows !== this.#rowsKey) { this.#rowsKey = rows; this.#refreshPanel(); }
  }

  protected draw(): void {
    this.#maybeRun();
    this.#lines = null;
    this.#paint();
    const at = this.pointer;
    if (this.#lines && at) this.#card.show(this.#lines, at.x, at.y); else this.#card.hide();
  }
  protected override undrawn(): void { this.#lines = null; this.#card.hide(); }

  #paint(): void {
    const { ctx, palette: p } = this, state = this.store.state, pw = this.plotW, ph = this.h, v = this.view;
    const running = this.#records.filter(r => r.on), on = running.filter(r => r.place === 'pane');
    setText(this.head.querySelector('.readout'), this.#records.length ? tn(running.length, '{n} script on', '{n} scripts on') : '');
    ctx.textBaseline = 'middle';
    this.#reportStatus();
    // The pane is laid out only while a script that is on draws in it (`hasRows`): for a moment after one is switched off it has none.
    if (!on.length) { this.#placeRowTools([]); return; }
    const places: { id: string; x: number; y: number }[] = [];
    const total = on.reduce((s, r) => s + r.height, 0), least = Math.max(1, Math.min(24, Math.floor(ph / on.length)));
    let top = 0;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    const hv = state.hover;
    const card: InfoLine[] = [];
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    on.forEach((r, k) => {
      const left = on.length - 1 - k, rowH = left === 0 ? Math.max(least, ph - top) : Math.max(least, Math.min(ph - top - left * least, Math.round(ph * r.height / total)));
      const kept = this.#held.get(r.id), held = kept && this.#fresh(kept) ? kept : undefined;
      if (k > 0) { ctx.strokeStyle = p.line; ctx.beginPath(); ctx.moveTo(0, top + 0.5); ctx.lineTo(this.w, top + 0.5); ctx.stroke(); }
      // A row's name stands on a faint plate of the page's colour, so a plot under it does not make it hard to read.
      const label = (text: string, color: string, y: number): number => {
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'left';
        const w = Math.min(pw - 8, ctx.measureText(text).width + 8);
        ctx.globalAlpha = 0.78; ctx.fillStyle = p.bg; ctx.fillRect(2, y - 7, w, 14); ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.fillText(text, 6, y);
        return w;
      };
      // The row's buttons stand after its name's plate (the name is drawn last, over the plots, so it is measured where it is drawn).
      const tools = (w: number): void => { places.push({ id: r.id, x: Math.min(pw - 44, 2 + w + 4), y: top + 1 }); };
      if (!held) tools(label(`${r.name} · ${t('running…')}`, p.muted, top + 9));
      else if (!held.result.ok) { tools(label(r.name, p.text, top + 9)); ctx.save(); ctx.beginPath(); ctx.rect(0, top, pw, rowH); ctx.clip(); label(errorText(held.result.error), p.ask, top + 24); ctx.restore(); }
      else {
        const res = held.result, time = held.time;
        // A run for another timeframe is not drawn over this one: the next run replaces it.
        const shown = shownCount(time, tf), [from, last] = visibleRange(time, v.t0, v.t1, tf), to = Math.min(last, shown - 1);
        if (this.#current(held, tf) && to >= from) {
          const scales = scalesOf(res.plots, r.options, from, to);
          const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top, height: rowH, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
          res.plots.forEach((plot, j) => {
            const s = scales.get(scaleIdOf(plot, r.options));
            if (s) paintPlot({ ...frame, color: fallbacks[j % fallbacks.length]! }, plot, s);
          });
          // The tags of the row's first scale at its right edge: the highest and the lowest in view.
          const first = scales.values().next().value;
          if (first) {
            ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.fillStyle = p.muted;
            ctx.fillText(shortNumber(first.max), this.w - 4, Math.max(top + 8, yOf(first.max, first, top, rowH)));
            ctx.fillText(shortNumber(first.min), this.w - 4, Math.min(top + rowH - 8, yOf(first.min, first, top, rowH)));
          }
          if (hv) this.#cardLines(card, r, res, time, tf, hv.t, shown);
        }
        const notes = this.warningsOf(r.id).length + res.warnings.length;
        tools(label(notes ? `${r.name} · ${tn(notes, '{n} warning', '{n} warnings')}` : r.name, notes ? p.muted : p.text, top + 9));
      }
      top += rowH;
    });
    this.#placeRowTools(places);
    if (card.length) this.#lines = card;
  }

  /** Called when what the scripts draw on the map changed (the map draws again). */
  onMapChanged: () => void = () => {};
  #candleColors = new Map<number, string>();
  #colorsKey = '';
  #heldGen = 0;

  /** A script's colour for the map's candle starting at `t` (`$price.color = ...`), or '' for the candle's own. */
  candleColorAt(t: number): string {
    if (!this.store.state.show.script) return '';
    const state = this.store.state, key = `${this.#heldGen}|${this.#version}|${state.timeframe}|${state.seriesInstrument}|${replayKey(TIMEFRAMES[state.timeframe] ?? 3_600_000)}`;
    if (this.#colorsKey !== key) { this.#colorsKey = key; this.#rebuildColors(); }
    return this.#candleColors.get(t) ?? '';
  }
  #rebuildColors(): void {
    const out = new Map<number, string>(), tf = TIMEFRAMES[this.store.state.timeframe] ?? 3_600_000;
    for (const r of this.#records) {
      const held = r.on ? this.#held.get(r.id) : undefined;
      if (!held?.result.ok || !held.result.candleColors || !this.#current(held, tf)) continue;
      const shown = shownCount(held.time, tf);
      held.result.candleColors.forEach((c, i) => { if (c && i < shown) out.set(held.time[i]!, safeColor(c, '')); });
    }
    this.#candleColors = out;
  }

  /**
   * Draw the scripts placed on the map (called by the map, in its plot's coordinates): the plots on the price scale at their prices, the
   * others each on a scale of their own, fitted to what is in view inside their margins, as they would be over a chart's candles.
   */
  paintOnMap(ctx: CanvasRenderingContext2D, pw: number, ph: number): void {
    const state = this.store.state;
    this.#reportStatus();
    if (!state.show.script) { this.#host.dropUnsent(); return; }
    // The map asks for runs too: on a phone the pane is not laid out while another tab shows, and the scripts on the map must still run.
    this.#maybeRun();
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, v = this.view, p = this.palette;
    const fallbacks = [p.vwap, p.poc, p.level, p.accent, p.bid, p.ask];
    for (const r of this.#records) {
      if (!r.on || r.place !== 'map') continue;
      const held = this.#held.get(r.id);
      if (!held?.result.ok || !this.#current(held, tf) || !held.time.length) continue;
      const res = held.result, time = held.time, [from, last] = visibleRange(time, v.t0, v.t1, tf), to = Math.min(last, shownCount(time, tf) - 1);
      if (to < from) continue;
      const scales = scalesOf(res.plots.filter(pl => scaleIdOf(pl, r.options) !== 'right'), r.options, from, to);
      scales.set('right', { min: v.p0, max: v.p1, margins: { top: 0, bottom: 0 } });
      const frame: Frame = { ctx, x: tt => v.xOf(tt, pw), barW: Math.max(1, v.xOf(tf, pw) - v.xOf(0, pw)), tf, time, from, to, top: 0, height: ph, w: pw, color: p.text, up: p.candleUp, down: p.candleDown };
      res.plots.forEach((plot, j) => {
        const s = scales.get(scaleIdOf(plot, r.options));
        if (s) paintPlot({ ...frame, color: fallbacks[j % fallbacks.length]! }, plot, s);
      });
    }
  }

  /** The map's popup lines for the scripts drawn on it, at the candle starting at `at`: each one's name, then its plots' values there. */
  mapHoverLines(at: number): InfoLine[] {
    const state = this.store.state, out: InfoLine[] = [];
    if (!state.show.script) return out;
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000;
    for (const r of this.#records) {
      if (!r.on || r.place !== 'map') continue;
      const held = this.#held.get(r.id);
      if (held?.result.ok && this.#current(held, tf)) this.#cardLines(out, r, held.result, held.time, tf, at, shownCount(held.time, tf), false, true);
    }
    return out;
  }

  /** The popup lines of one script at the candle under the pointer: (the candle's time, first,) its name, then each plot's value there. */
  #cardLines(out: InfoLine[], r: ScriptRecord, res: Extract<ScriptResult, { ok: true }>, time: Float64Array, tf: number, at: number, shown: number, withTime = true, onMap = false): void {
    const i = indexAt(time, tf, at, shown);
    if (i < 0) return;
    if (withTime && !out.length) out.push({ text: clock(time[i]!, true), bold: true });
    out.push({ text: r.name, bold: true, rule: true });
    // A band coloured point by point (a heat map's row) is read by its colour: its bounds say nothing, so it is left out beside plots that
    // carry values. At most a few plots are listed; the others are counted.
    const band = (plot: PlotOut): boolean => (plot.kind === 'brokenarea' || plot.kind === 'cloudarea') && plot.colors !== null;
    // A plot carries values only where it has one here: a line an option left unrun does not hide the bands.
    const valued = res.plots.some(plot => plot.style.visible !== false && !band(plot) && PLOT_FIELDS[plot.kind].some(f => Number.isFinite(plot.fields[f]![i]!)));
    let listed = 0, more = 0;
    res.plots.forEach((plot, j) => {
      if (plot.style.visible === false || (valued && band(plot))) return;
      const values = PLOT_FIELDS[plot.kind].map(f => plot.fields[f]![i]!);
      if (!values.some(Number.isFinite)) return;
      // On the map a plot on the price scale is a price, written as the price axis writes one; the others are amounts.
      const fmt = onMap && scaleIdOf(plot, r.options) === 'right' ? (v: number) => fmtPrice(v) : shortNumber;
      const text = values.length === 1 ? fmt(values[0]!) : values.map(fmt).join(plot.kind === 'cloudarea' || plot.kind === 'brokenarea' ? ' – ' : ' / ');
      if (listed >= CARD_PLOTS) { more++; return; }
      listed++;
      out.push({ label: plot.title || `${plot.kind} ${j + 1}`, text, color: values.length === 1 && values[0]! < 0 ? 'sell' : 'text' });
    });
    if (more) out.push({ text: tn(more, '+{n} more plot', '+{n} more plots'), color: 'muted' });
  }
}
