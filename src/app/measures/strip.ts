import { TIMEFRAMES } from '../hub.ts';
import type { AppState } from '../store.ts';
import type { InfoLine } from '../infobox.ts';
import { FlowCache, candleStarts } from '../delta/candles.ts';
import { deltaFlows, deltaIds, ensureDeltaFlow, type FlowLoader } from '../delta/flows.ts';
import { flowLoadIds, mapVenues } from '../cvd/ids.ts';
import { oiChangeByTime, oiPartsUntil, oiSumOf } from '../oi-change.ts';
import { venueLabel } from '../venues.ts';
import { clock } from '../format.ts';
import { t } from '../i18n.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { deltaSeries, indexAt, oiScope, oiSeries, readingSpacing, scaleOf, scaleText, stripBand, stripCaption, stripLines, type StripSeries } from './model.ts';
import { paintStrip, type StripFrame } from './paint.ts';

/** What the map hands the strip each frame: what the painter needs, the legend's bottom as last drawn, and the corner buttons' bottom. */
export interface StripPlace extends StripFrame {
  /** The bottom of the legend plate (CSS px from the top of the map). */
  legendBottom: number;
  /** The bottom of the map's corner buttons (Go to, Select, Recenter); 0 where there are none (a phone). Read only while the strip shows. */
  toolsBottom: () => number;
}

/** One measure worked out for the candles of a view, and what it was worked out from. */
interface Worked { key: string; refs: readonly unknown[]; series: StripSeries; scope: (t: number) => string; caption: string; coin: string; spacingMs: number; empty: string | null }

/** Candles the flow cache may span before it starts again: the flow book's retention bounds it already, this bounds it whatever happens. */
const CACHE_CAP = 40_000;

/**
 * The measure strip along the top of the map: each candle's delta or its change of open interest (measures/model.ts), drawn under the legend
 * (measures/paint.ts). Nothing is worked out or asked for while it is off. A frame that only moves the pointer reuses what was worked out:
 * the values are kept until the markets, the timeframe, the flow or open interest held, or the whole candles in view change, and the candle
 * under way is worked out again at most once a second.
 */
export class MeasureStrip {
  #cache = new FlowCache();
  /** The candles the flow cache can hold, the first to the last asked since it started (it holds at most one flow per candle). */
  #span: { tf: number; from: number; to: number } | null = null;
  #worked: Worked | null = null;
  #ids: { key: readonly unknown[]; ids: string[] } | null = null;
  /** The band and series drawn last (for the pointer), and the legend bottom the band was placed under. */
  #drawn: { band: { top: number; height: number }; series: StripSeries; worked: Worked } | null = null;
  #placedFor: number | null = null;

  /** Draw the strip for this frame, or nothing while it is off (it then also works nothing out and asks for nothing). */
  paint(ctx: CanvasRenderingContext2D, state: AppState, hub: FlowLoader, f: StripPlace): void {
    this.#drawn = null;
    if (!state.measureStrip.on) { this.#placedFor = null; this.#worked = null; return; }
    this.#placedFor = f.legendBottom;
    const band = stripBand({ legendBottom: f.legendBottom, toolsBottom: f.toolsBottom(), ph: f.ph, volume: state.show.volume });
    if (!band || !(f.view.t1 > f.view.t0)) return;
    const worked = this.work(state, hub, f.view.t0, f.view.t1, pageNow());
    if (!worked) return;
    const max = scaleOf(worked.series, f.view.t0, f.view.t1);
    paintStrip(ctx, worked.series, band, f, max, state.highlight.on, { caption: worked.caption, scale: max > 0 ? scaleText(worked.series.kind, max, worked.coin) : '', empty: max > 0 ? null : worked.empty });
    this.#drawn = { band, series: worked.series, worked };
  }

  /**
   * Whether the band was placed under another legend than the one this frame drew: the legend is drawn last, over everything, so the band
   * is placed under the last frame's, and a legend that grew or shrank asks for one more frame.
   */
  misplaced(legendBottom: number): boolean { return this.#placedFor !== null && this.#placedFor !== legendBottom; }

  /** The popup for the candle under the pointer when it is over the band (`y` on the map, `t` its time); null elsewhere. */
  readout(y: number, t: number, timeframe: string): InfoLine[] | null {
    const d = this.#drawn;
    if (!d || y < d.band.top - 4 || y > d.band.top + d.band.height + 4) return null;
    const i = indexAt(d.series, t);
    if (i < 0) return null;
    return stripLines(d.series, i, { timeframe, scope: d.worked.scope, coin: d.worked.coin, spacingMs: d.worked.spacingMs, now: pageNow() });
  }

  /** The measure for the candles of [t0, t1], with what stands out judged over a baseline's worth of candles before them; kept while nothing it depends on changed. */
  work(state: AppState, hub: FlowLoader, t0: number, t1: number, now: number): Worked | null {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, hl = state.highlight, kind = state.measureStrip.kind;
    const lead = hl.on ? hl.length : 0;
    const starts = candleStarts(t0 - lead * tf, t1, now, tf, 'none', 'UTC');
    if (!starts.length) return null;
    const coin = state.markets.find(m => (m.instrumentId ?? m.id) === state.marketId)?.base ?? '';
    // Whole candles, the clock to the second and the highlight rule: a pan inside one candle or a pointer move changes none of them.
    const frame = `${tf}|${starts[0]}|${starts.length}|${Math.floor(now / 1000)}|${hl.on}|${hl.mult}|${hl.length}|${coin}`;
    if (kind === 'delta') {
      const flow = hub.flow, ids = this.#deltaIds(state, hub), key = `d|${frame}|${ids.join(',')}|${flow.loads}`;
      if (this.#worked?.key === key) return this.#worked;
      ensureDeltaFlow(hub, flowLoadIds(state, flow.ids), starts[0]!, Date.now());
      const s0 = starts[0]!, s1 = starts[starts.length - 1]!, span = this.#span?.tf === tf ? { tf, from: Math.min(this.#span.from, s0), to: Math.max(this.#span.to, s1) } : { tf, from: s0, to: s1 };
      if ((span.to - span.from) / tf > CACHE_CAP) { this.#cache = new FlowCache(); this.#span = { tf, from: s0, to: s1 }; } else this.#span = span;
      const { raw, flows, earliest } = deltaFlows(this.#cache, flow, ids, starts, tf, now);
      const scope = t('{n} markets', { n: ids.length });
      const empty = !ids.length ? t('No market is switched on.') : earliest === null ? t('No flow recorded for these candles yet.') : t('Flow is recorded from {time}: the candles before it have none.', { time: clock(earliest, true) });
      return this.#worked = { key, refs: [], series: deltaSeries(starts, raw, flows, tf, hl), scope: () => scope, caption: stripCaption('delta', scope, 0, tf), coin, spacingMs: 0, empty };
    }
    // Replay: only the bars that had ended by its moment, as the OI pane counts them.
    const cut = replaying() ? Math.floor(now / tf) * tf : Infinity, parts = oiPartsUntil(state.oiParts, tf, cut);
    const key = `o|${frame}|${cut}`, refs = [state.oi, parts];
    if (this.#worked?.key === key && this.#worked.refs.every((r, i) => r === refs[i])) return this.#worked;
    const bars = parts.length > 1 ? [] : Number.isFinite(cut) ? state.oi.filter(b => b[0] + tf <= cut) : state.oi;
    const change = oiChangeByTime(bars, parts, tf), counted = parts.length > 1 ? oiSumOf(parts, tf).counted : null;
    const id = state.oiInstrument, market = id ? `${venueLabel(id)} ${id.split(':').slice(1).join(':')}` : t('The chart market');
    const spacingMs = readingSpacing(parts.length > 1 ? parts.map(p => p.bars) : [bars]);
    const scope = (at: number): string => oiScope(parts.length, counted?.get(at), market);
    const empty = parts.length <= 1 && !bars.length ? t('No open interest for this market.') : t('No change of open interest is held for these candles yet.');
    return this.#worked = { key, refs, series: oiSeries(starts, change, tf, hl), scope, caption: stripCaption('oi', scope(NaN), spacingMs, tf), coin, spacingMs, empty };
  }

  /** The Delta pane's markets (delta/flows.ts), worked out again only when what they depend on changes (as the footprint's markets are). */
  #deltaIds(state: AppState, hub: FlowLoader): string[] {
    const onMap = mapVenues(state), key = [state.markets, state.disabledVenues, state.scope, onMap ? [...onMap].sort().join(',') : null, hub.flow.ids.length, hub.flow.loads];
    if (!this.#ids || this.#ids.key.some((k, i) => k !== key[i])) this.#ids = { key, ids: deltaIds(state, hub.flow) };
    return this.#ids.ids;
  }
}
