import type { Palette } from '../theme.ts';
import type { InfoLine } from '../infobox.ts';
import type { CandleRow } from '../store.ts';
import { t } from '../i18n.ts';
import { usd } from '../format.ts';
import { VOLUME_WORDS } from '../traded.ts';
import { anomalies } from '../anomaly.ts';
import { valueArea } from '../../shared/profile.ts';
import { emphasisFloor, medianRow, splitStyles } from '../traded/emphasis.ts';
import { bucketAt, timeLines, timeText, type TimeGap, type TimeLevels, type TimeRows } from './model.ts';
import { timeWords } from './registry.ts';

/**
 * The volume strip along the bottom of the map as a profile by time (Karl, 2026-10-20: "I want the bottom to be a profile as well for
 * volume ... and only show the normal volume candles for data that is loaded from the exchange"). One bar a candle, on the candles' own
 * boundaries: where the recording reaches, what all the venues on the map traded, split by side with the profiles' emphasis; before it,
 * the chart market's own candle, its volume in dollars at its typical price, split by its taker buys where the exchange says them, an
 * estimate drawn as the candle-based profiles are (outlined in the profile colour, named ≈ with its market) and grey where it does not say
 * who bought. One scale for both, so a market's bar beside the venues' is honestly smaller; one source a bar, never added across the seam.
 */

/** One bar: its candle's start, where it is drawn, and what it holds (dollars; from a candle without taker buys, all of it in `buy`). */
export interface StripBar {
  t: number; x: number; w: number;
  /** `recorded`: the venues' trades; `partial`: the recording began inside it; `candle`: the market's own candle; `gap`: the recording missed it. */
  source: 'recorded' | 'partial' | 'candle' | 'gap';
  buy: number; sell: number;
  /** Whether its two sides are known. */
  split: boolean;
  /** Its bucket in the recorded rows (-1 for a candle). */
  i: number;
  gap: TimeGap | null;
}

/** A candle's dollars: its volume at its typical price, as the candle-based profiles value it (traded/levels.ts). */
export const candleUsd = (c: CandleRow): number => c[5] > 0 && c[3] > 0 ? c[5] * (c[2] + c[3] + c[4]) / 3 : 0;

/**
 * The bars of the candles in [t0, t1]: from the recorded rows (buckets of the timeframe) from where the recording reaches (`since`), a
 * candle it starts inside partial; before it, or with nothing recorded, the candle itself, split by `taker` (its share bought at market, or
 * undefined where the exchange does not say). In a replay a candle not closed by `now` is left out: its final volume says what came later.
 */
export function stripBars(candles: readonly CandleRow[], tf: number, rows: TimeRows | null, since: number | null, now: number, t0: number, t1: number,
  place: (start: number) => { x: number; w: number }, taker: (start: number) => number | undefined, replay: boolean): StripBar[] {
  const out: StripBar[] = [];
  for (const c of candles) {
    const s = c[0], e = s + tf;
    if (e < t0 || s > t1 || s > now) continue;
    const { x, w } = place(s), i = rows && e > rows.from ? bucketAt(rows, Math.max(s, rows.from)) : -1;
    // From the recording where it reaches and its rows hold the bar; a bar wholly before the rows asked for is the candle's, never another's
    // bucket; the bar the recording begins inside is the recording's where its rows hold it, else the candle's.
    const gap = i >= 0 ? rows!.gaps[i] ?? null : null, inside = since !== null && s < since;
    if (rows && since !== null && e > since && i >= 0 && !(inside && gap)) {
      out.push({ t: s, x, w, source: gap ? 'gap' : inside ? 'partial' : 'recorded', buy: gap ? 0 : rows.buy[i]!, sell: gap ? 0 : rows.sell[i]!, split: !gap, i, gap });
      continue;
    }
    if (replay && e > now) continue;
    const dollars = candleUsd(c), share = taker(s), split = share !== undefined && Number.isFinite(share);
    const bought = split ? dollars * Math.min(1, Math.max(0, share!)) : dollars;
    out.push({ t: s, x, w, source: 'candle', buy: bought, sell: split ? dollars - bought : 0, split, i: -1, gap: null });
  }
  return out;
}

/** Each bar's Highlights flag and threshold (dollars), worked out within each run of one source: never across the seam or a gap. */
export function stripHighlights(bars: readonly StripBar[], options: { length: number; mult: number }): { flag: Uint8Array; threshold: Float64Array } {
  const flag = new Uint8Array(bars.length), threshold = new Float64Array(bars.length).fill(NaN);
  const kind = (b: StripBar): string => b.source === 'candle' ? 'candle' : b.source === 'recorded' ? 'recorded' : '';
  for (let a = 0; a < bars.length;) {
    const k = kind(bars[a]!);
    let z = a; while (z < bars.length && kind(bars[z]!) === k) z++;
    if (k) {
      const values = Float64Array.from(bars.slice(a, z), b => b.buy + b.sell), found = anomalies(values, options);
      for (let i = a; i < z; i++) { flag[i] = found.flag[i - a]!; threshold[i] = found.threshold[i - a]!; }
    }
    a = z;
  }
  return { flag, threshold };
}

/** The value area by time of the recorded bars on screen (partial ones and gaps left out), as indices into `bars`; null with none. */
export function stripLevels(bars: readonly StripBar[], share: number): TimeLevels | null {
  const at: number[] = [];
  bars.forEach((b, i) => { if (b.source === 'recorded') at.push(i); });
  const found = at.length ? valueArea(Float64Array.from(at, i => bars[i]!.buy + bars[i]!.sell), share) : null;
  return found ? { poc: at[found.poc]!, lo: at[found.lo]!, hi: at[found.hi]! } : null;
}

/** What the strip draws besides its bars. */
export interface StripDraw {
  pw: number; ph: number; height: number; palette: Palette;
  bars: 'split' | 'delta'; emphasis: boolean;
  /** The Highlights (null while they are off) and the value area, as indices into the bars. */
  highlights: { flag: Uint8Array; threshold: Float64Array } | null;
  levels: TimeLevels | null;
  /** What the recorded part is called, and the candles' part ("≈ Binance 1h candles"). */
  recorded: string; candles: string;
  /** The bar under the pointer, or -1. */
  hovered: number;
}

/**
 * The strip: a soft backdrop, the value area shaded behind the recorded bars and its busiest bar outlined, each bar growing up from the
 * bottom (the first side, bid colour, at its foot) on one scale, a candle's outlined in the profile colour and grey where it does not say
 * who bought, a gap a dotted run along the bottom, the Highlights' bars full strength with their threshold dashed within each run, the
 * seam marked, and the two parts named at their left.
 */
export function paintVolumeStrip(ctx: CanvasRenderingContext2D, bars: readonly StripBar[], d: StripDraw): void {
  const { ph, height: H, palette: p } = d, floor = ph - 1, top = ph - H - 6;
  let max = 0; for (const b of bars) max = Math.max(max, b.buy + b.sell);
  ctx.save();
  // A soft backdrop keeps the bars readable over bright heat.
  const hex = p.bg.replace('#', ''), [br, bg, bb] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const backdrop = ctx.createLinearGradient(0, top, 0, ph);
  backdrop.addColorStop(0, `rgba(${br},${bg},${bb},0)`); backdrop.addColorStop(1, `rgba(${br},${bg},${bb},${p.dark ? 0.55 : 0.5})`);
  ctx.fillStyle = backdrop; ctx.fillRect(0, top, d.pw, H + 6);
  if (!(max > 0) && !bars.some(b => b.source === 'gap')) { ctx.restore(); return; }
  const median = medianRow(bars.filter(b => b.source !== 'candle').map(b => b.buy + b.sell)), floorUsd = emphasisFloor(), hl = d.highlights;
  // The value area behind the recorded bars, and its busiest bar outlined.
  if (d.levels) {
    const a = bars[d.levels.lo]!, z = bars[d.levels.hi]!;
    ctx.globalAlpha = 0.12; ctx.fillStyle = p.poc; ctx.fillRect(a.x - a.w / 2, top + 4, z.x + z.w / 2 - (a.x - a.w / 2), H + 2);
  }
  bars.forEach((b, i) => {
    const total = b.buy + b.sell, h = max > 0 ? Math.max(total > 0 ? 1 : 0, total / max * H) : 0, x0 = b.x - b.w / 2, hot = !!hl && hl.flag[i] === 1;
    if (b.source === 'gap') {
      ctx.globalAlpha = 0.7; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.moveTo(x0, floor - 0.5); ctx.lineTo(x0 + b.w, floor - 0.5); ctx.stroke(); ctx.setLineDash([]);
      return;
    }
    if (hot) { ctx.globalAlpha = 0.07; ctx.fillStyle = b.buy >= b.sell ? p.candleUp : p.candleDown; ctx.fillRect(x0, 0, b.w, top); }
    const base = hl ? (hot ? 1 : 0.45) : 0.75, fade = b.source === 'partial' ? 0.55 : 1;
    if (!b.split) { ctx.globalAlpha = base * fade; ctx.fillStyle = p.muted; ctx.fillRect(x0, floor - h, b.w, h); }
    else if (d.bars === 'delta') {
      const net = b.buy - b.sell, nh = max > 0 ? Math.abs(net) / max * H : 0;
      ctx.globalAlpha = 0.25 * fade; ctx.fillStyle = p.muted; ctx.fillRect(x0, floor - h, b.w, h);
      if (nh > 0) { ctx.globalAlpha = base * fade; ctx.fillStyle = net > 0 ? p.bid : p.ask; ctx.fillRect(x0, floor - nh, b.w, nh); }
    } else {
      const [first, second] = splitStyles(b.buy, b.sell, median, floorUsd, p, d.emphasis), buyH = total > 0 ? h * b.buy / total : 0;
      if (b.buy > 0) { ctx.globalAlpha = Math.min(1, first.alpha * base / 0.75) * fade; ctx.fillStyle = first.color; ctx.fillRect(x0, floor - buyH, b.w, buyH); }
      if (b.sell > 0) { ctx.globalAlpha = Math.min(1, second.alpha * base / 0.75) * fade; ctx.fillStyle = second.color; ctx.fillRect(x0, floor - h, b.w, h - buyH); }
    }
    // A candle is an estimate: outlined in the profile colour, as the candle-based profiles are.
    if (b.source === 'candle') { ctx.globalAlpha = 0.85; if (h >= 2) { ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, floor - h + 0.5, Math.max(0, b.w - 1), Math.max(0, h - 1)); } else { ctx.fillStyle = p.poc; ctx.fillRect(x0, floor - 1, b.w, 1); } }
    if (hot) { ctx.globalAlpha = 0.9; ctx.fillStyle = p.dark ? '#ffffff' : '#14171c'; ctx.fillRect(x0, floor - h - 1.5, b.w, 1.5); }
    if (d.levels && i === d.levels.poc) { ctx.globalAlpha = 1; ctx.strokeStyle = p.poc; ctx.lineWidth = 1.5; ctx.strokeRect(x0 - 0.5, floor - h - 0.5, b.w + 1, h + 1); }
    if (i === d.hovered) { ctx.globalAlpha = 1; ctx.strokeStyle = p.text; ctx.lineWidth = 1; ctx.strokeRect(x0 - 1.5, floor - h - 1.5, b.w + 3, h + 3); }
  });
  // The Highlights' threshold, dashed within each run of one source (a break where the source changes or the data stops).
  if (hl && max > 0) {
    ctx.globalAlpha = 0.7; ctx.strokeStyle = p.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
    let open = false, last = '';
    bars.forEach((b, i) => {
      const th = hl.threshold[i]!, kind = b.source;
      if (!Number.isFinite(th) || kind === 'gap' || kind === 'partial' || kind !== last) open = false;
      last = kind;
      if (!Number.isFinite(th) || kind === 'gap' || kind === 'partial') return;
      const y = floor - Math.min(1, th / max) * H, x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
      if (!open) { ctx.moveTo(x0, y); open = true; } else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    });
    ctx.stroke(); ctx.setLineDash([]);
  }
  // The seam, and each part named at its left.
  ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  // Each named at its left, the second after the first ends; one with no room left out rather than over the other or off the map.
  let taken = 2;
  const name = (text: string, x: number, color: string): void => {
    const w = ctx.measureText(text).width + 8, at = Math.max(taken, x);
    if (at + w > d.pw - 2) return;
    ctx.globalAlpha = 0.85; ctx.fillStyle = p.panel; ctx.fillRect(at, top + 4, w, 14);
    ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.fillText(text, at + 4, top + 11);
    taken = at + w + 6;
  };
  const firstCandle = bars.findIndex(b => b.source === 'candle'), firstRecorded = bars.findIndex(b => b.source !== 'candle');
  if (firstCandle >= 0 && firstRecorded > firstCandle) {
    const seam = bars[firstRecorded]!.x - bars[firstRecorded]!.w / 2;
    ctx.globalAlpha = 0.9; ctx.strokeStyle = p.poc; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(Math.round(seam) + 0.5, top + 2); ctx.lineTo(Math.round(seam) + 0.5, floor); ctx.stroke(); ctx.setLineDash([]);
  }
  if (firstCandle >= 0) name(d.candles, bars[firstCandle]!.x - bars[firstCandle]!.w / 2, p.poc);
  if (firstRecorded >= 0) name(d.recorded, bars[firstRecorded]!.x - bars[firstRecorded]!.w / 2 + 2, p.text);
  ctx.restore();
}

/** The box of the bar under the pointer: the recorded bucket's figures (`timeLines`), or the candle's, with where it comes from. */
export function stripLines(bar: StripBar, c: { rows: TimeRows | null; tf: number; now: number; levels: TimeLevels | null; levelsIn: (i: number) => number; market: string; tfName: string;
  /** Whether the exchange reports taker buys (Binance): a candle without them then has them still to come, not none. */ reports: boolean;
  /** The strip's own total on screen, the recorded bars', for the share of each. */ total: number }): InfoLine[] {
  if (bar.source !== 'candle' && c.rows && bar.i >= 0) {
    const l = c.levels, rowsLevels = l ? { poc: c.levelsIn(l.poc), lo: c.levelsIn(l.lo), hi: c.levelsIn(l.hi) } : null;
    // A bar is the recording's whole or says it is partial itself: the rows' note that the window reaches back past the recording is the
    // seam's, drawn on the strip, not this bar's.
    const lines = timeLines({ ...c.rows, partial: false, total: c.total }, bar.i, { metric: 'volume', words: timeWords('volume'), spacingMs: 0, levels: rowsLevels, now: c.now });
    if (bar.source === 'partial') lines.push({ text: t('The recording began inside this bar: part of it only.'), color: 'muted', wrap: true });
    return lines;
  }
  const total = bar.buy + bar.sell, lines: InfoLine[] = [{ text: `${timeText(bar.t, c.tf, c.now)} – ${timeText(bar.t + c.tf, c.tf, c.now)}`, bold: true }];
  if (bar.split) {
    const net = bar.buy - bar.sell;
    lines.push({ label: VOLUME_WORDS.buy, text: `$${usd(bar.buy)}`, color: 'buy' }, { label: VOLUME_WORDS.sell, text: `$${usd(bar.sell)}`, color: 'sell' },
      { label: VOLUME_WORDS.net, text: `${net > 0 ? '+' : net < 0 ? '−' : ''}$${usd(Math.abs(net))}`, ...(net > 0 ? { color: 'buy' as const } : net < 0 ? { color: 'sell' as const } : {}) });
  } else lines.push({ label: t('Volume'), text: `$${usd(total)}` }, { text: c.reports ? t('Who bought in this candle is not loaded yet: the total only.') : t('{market} candles do not say who bought: the total only.', { market: c.market }), color: 'muted', wrap: true });
  lines.push({ text: t('≈ {market} {tf} candle: one market, before the recording reaches; its volume at its typical price.', { market: c.market, tf: c.tfName }), color: 'muted', wrap: true });
  return lines;
}

/** Two runs of rows of one step, the second starting where the first ends, as one (the closed buckets and the one under way). */
export function joinRows(a: TimeRows, b: TimeRows): TimeRows {
  const n = a.buy.length + b.buy.length, buy = new Float64Array(n), sell = new Float64Array(n);
  buy.set(a.buy); buy.set(b.buy, a.buy.length); sell.set(a.sell); sell.set(b.sell, a.buy.length);
  let total = 0, max = 0, poc = -1;
  for (let i = 0; i < n; i++) { const v = buy[i]! + sell[i]!; total += v; if (v > max) { max = v; poc = i; } }
  return { ...a, to: b.to, buy, sell, gaps: [...a.gaps, ...b.gaps], buyN: null, sellN: null, total, max, poc };
}
