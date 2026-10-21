import { t } from '../i18n.ts';
import { clock, usd } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import type { OiBar } from '../store.ts';
import type { CandleFlow } from './candles.ts';
import { OI_HOLD_MS, heldOiAt } from '../oi-change.ts';

/**
 * NL/NS: an estimate of who opened and closed positions. Every position has a long and a short holder, so open interest cannot say which
 * side was new; this gives each change of open interest to the side that traded at market on the same market over the same stretch (its
 * taker delta, or, where its flow is not recorded, the way the chart's price went). Up with buyers: longs opened; up with sellers: shorts
 * opened; down with sellers: longs closed; down with buyers: shorts closed.
 *
 * A market's change is measured between its own readings (its bars), never between values carried from one: a venue read every five minutes
 * (or hourly, in older history) changes once, by the whole step, in the candle of its new reading, and that step is given to its takers over
 * the whole stretch since the reading before, and marked coarse when that stretch is longer than a candle. Markets are each classified first
 * and then added up, so in one candle a venue's new longs and another's new shorts both show, and new longs beside shorts closed are +2 for
 * the longs side even when the open interest did not change.
 */

export type NlnsKind = 'newLongs' | 'newShorts' | 'longsClosed' | 'shortsClosed';
export interface NlnsCandle {
  t: number;
  /** The change of open interest attributed in this candle (coins) and what it was before, over the markets counted. */
  dOi: number; oiStart: number;
  /**
   * The four parts (coins, none negative); changes that went to neither side because the takers came out even (`unassigned`), and because
   * nothing said which way they went (`unknown`: the flow did not cover the whole stretch and the chart's price could not stand in).
   */
  longOpened: number; longClosed: number; shortOpened: number; shortClosed: number; unassigned: number; unknown: number;
  /** Longs opened less closed, shorts opened less closed, and the net of the two (`v = longs − shorts`). */
  longs: number; shorts: number; v: number;
  /** The largest part, or `mixed` when parts pulled both ways (new longs or shorts closed beside new shorts or longs closed); null when nothing was attributed. */
  kind: NlnsKind | 'mixed' | null;
  /** +1 the net went to longs, −1 to shorts, 0 neither; `byPrice`: some market was classified by the chart's price; `coarse`: some change
   *  covered more than this candle (readings further apart than a candle). */
  side: 1 | -1 | 0; byPrice: boolean; coarse: boolean;
  /** Markets whose open interest is known at this candle, and those with a change attributed in it. */
  covered: number; counted: number;
  /** Running sums from the last restart (of `v`, `longs`, `shorts`) and which run it is in. */
  cum: number; cumLongs: number; cumShorts: number; run: number;
}

/** One market for NL/NS: its open-interest bars on the chart's timeframe, and its taker flow per candle (aligned to the candle starts; null where not recorded). */
export interface NlnsMarket { bars: readonly OiBar[]; flows: readonly (CandleFlow | null)[] }

/**
 * The candles from `starts` (the chart's candle starts, oldest first): `closes` are the chart's candle closes by start (the price's way where a
 * market's flow is not recorded; empty when the chart's candles are another market's), `keys` the running sums' restart keys (they restart
 * where the key changes, and after a candle no market covers).
 */
export function nlnsModel(starts: readonly number[], markets: readonly NlnsMarket[], closes: ReadonlyMap<number, number>, keys: readonly number[], tfMs: number,
  holdMs = OI_HOLD_MS): NlnsCandle[] {
  // Bars a candle apart are consecutive readings however long the candle (a 4-hour or daily chart's bars are 4 h or a day apart).
  holdMs = Math.max(holdMs, tfMs);
  const index = new Map(starts.map((s, i) => [s, i] as const));
  const parts = starts.map(() => ({ dOi: 0, oiStart: 0, lo: 0, lc: 0, so: 0, sc: 0, un: 0, unknown: 0, byPrice: false, coarse: false, counted: 0 }));
  const carry = Math.max(2 * tfMs, 10 * 60_000), covered = new Array<number>(starts.length).fill(0);
  const closeAt = (time: number): number | undefined => { let best: number | undefined; for (let s = time; s >= time - holdMs; s -= tfMs) { best = closes.get(s); if (best !== undefined) break; } return best; };
  for (const market of markets) {
    const bars = [...market.bars].sort((a, b) => a[0] - b[0]);
    starts.forEach((s, i) => { if (heldOiAt(bars, s, carry, holdMs)) covered[i]!++; });
    for (let k = 1; k < bars.length; k++) {
      const before = bars[k - 1]!, now = bars[k]!, i = index.get(now[0]);
      if (i === undefined || now[0] - before[0] > holdMs) continue;
      const d = now[4] - before[4], p = parts[i]!;
      p.counted++; p.dOi += d; p.oiStart += before[4];
      if (now[0] - before[0] > tfMs) p.coarse = true;
      if (d === 0) continue;
      // The market's takers over the whole stretch since its reading before (the candles after it, up to and including this one), only when
      // every one of them is recorded: flow over part of the stretch (a start or a gap inside it) says nothing of the rest, which could turn it.
      let delta = 0, whole = true, first = i;
      for (let j = i; j >= 0 && starts[j]! > before[0]; j--) { const f = market.flows[j]; first = j; if (f) delta += f.delta; else whole = false; }
      if (starts[first]! - tfMs > before[0]) whole = false;
      let side = whole ? Math.sign(delta) : 0, known = whole;
      if (!whole) { const a = closeAt(before[0]), b = closeAt(now[0]); if (a !== undefined && b !== undefined) { side = Math.sign(b - a); known = true; if (side) p.byPrice = true; } }
      const size = Math.abs(d);
      if (!known) p.unknown += size;
      else if (side === 0) p.un += size;
      else if (d > 0) { if (side > 0) p.lo += size; else p.so += size; }
      else if (side < 0) p.lc += size; else p.sc += size;
    }
  }
  const out: NlnsCandle[] = [];
  let cum = 0, cumLongs = 0, cumShorts = 0, key = NaN, gap = true, run = -1;
  starts.forEach((s, i) => {
    if (!covered[i]) { gap = true; return; }
    // As the CVD: a new day or week starts the sums again; after a candle not covered they carry on, in a run of their own.
    if (keys[i] !== key) { cum = 0; cumLongs = 0; cumShorts = 0; key = keys[i]!; gap = false; run++; }
    else if (gap) { gap = false; run++; }
    const p = parts[i]!, longs = p.lo - p.lc, shorts = p.so - p.sc, v = longs - shorts;
    const named: [NlnsKind, number][] = [['newLongs', p.lo], ['longsClosed', p.lc], ['newShorts', p.so], ['shortsClosed', p.sc]];
    const nonzero = named.filter(([, x]) => x > 0), bothWays = (p.lo + p.sc > 0) && (p.so + p.lc > 0);
    const kind: NlnsCandle['kind'] = !nonzero.length ? null : bothWays ? 'mixed' : nonzero.sort((a, b) => b[1] - a[1])[0]![0];
    cum += v; cumLongs += longs; cumShorts += shorts;
    out.push({ t: s, dOi: p.dOi, oiStart: p.oiStart, longOpened: p.lo, longClosed: p.lc, shortOpened: p.so, shortClosed: p.sc, unassigned: p.un, unknown: p.unknown, longs, shorts, v, kind,
      side: Math.sign(v) as 1 | -1 | 0, byPrice: p.byPrice, coarse: p.coarse, covered: covered[i]!, counted: p.counted, cum, cumLongs, cumShorts, run });
  });
  return out;
}

/**
 * The candles NL/NS works out for the view's `starts`: those of one hold before them first (a reading's change is given to the takers since
 * the reading before, which can be before the view), with restart keys that put them in a run of their own so the sums still start at the
 * view. Drop the candles before `starts[0]` from the model.
 */
export function withLead(starts: readonly number[], keys: readonly number[], tfMs: number, holdMs = OI_HOLD_MS): { all: number[]; keys: number[] } {
  if (!starts.length) return { all: [], keys: [] };
  const lead = Math.ceil(Math.max(holdMs, tfMs) / tfMs);
  return { all: [...Array.from({ length: lead }, (_, k) => starts[0]! - (lead - k) * tfMs), ...starts], keys: [...Array.from({ length: lead }, () => -Infinity), ...keys] };
}

/** An amount of coins, signed and short: "+325 BTC", "−1.2M DOGE". */
export function coinText(v: number, coin: string): string {
  const a = Math.abs(v), body = a === 0 ? '0' : a >= 1_000 ? usd(a) : a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toPrecision(2);
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${body}${coin ? ` ${coin}` : ''}`;
}

const KIND_TEXT: Record<NlnsKind | 'mixed', () => string> = {
  newLongs: () => t('New longs'), newShorts: () => t('New shorts'), longsClosed: () => t('Longs closed'), shortsClosed: () => t('Shorts closed'), mixed: () => t('Both ways'),
};

/**
 * The popup of one candle: the change of open interest (and its share of it), its parts, what they come to for each side, the running sums,
 * and how it was read (the price where no flow was recorded, a stretch longer than the candle, markets that had no reading in it).
 */
export function nlnsCardLines(c: NlnsCandle, tf: string, coin: string, market: string, markets = 1): InfoLine[] {
  const share = c.oiStart > 0 ? ` · ${c.dOi >= 0 ? '+' : '−'}${(Math.abs(c.dOi) / c.oiStart * 100).toFixed(2)}%` : '';
  const lines: InfoLine[] = [
    { text: `${clock(c.t, true)} · ${tf}`, bold: true },
    { label: t('Open interest'), text: `${coinText(c.dOi, coin)}${share}`, bold: true },
    { label: t('Read as'), text: c.kind ? KIND_TEXT[c.kind]() : c.unassigned > 0 ? t('takers even') : c.unknown > 0 ? t('side unknown') : t('no change'), color: c.v > 0 ? 'buy' : c.v < 0 ? 'sell' : 'text' },
  ];
  for (const [label, x, color] of [[t('New longs'), c.longOpened, 'buy'], [t('Longs closed'), -c.longClosed, 'sell'], [t('New shorts'), c.shortOpened, 'sell'], [t('Shorts closed'), -c.shortClosed, 'buy']] as const)
    if (x !== 0) lines.push({ label, text: coinText(x, coin), color });
  if (c.unassigned > 0) lines.push({ label: t('Takers even'), text: coinText(c.unassigned, coin), color: 'muted' });
  // Neither the flow (not recorded over the whole stretch) nor the price (another market's candles) said which way.
  if (c.unknown > 0) lines.push({ label: t('Side unknown'), text: coinText(c.unknown, coin), color: 'muted' });
  lines.push(
    { label: t('Longs'), text: `${coinText(c.longs, coin)} · ${t('since the start')} ${coinText(c.cumLongs, coin)}`, color: c.longs > 0 ? 'buy' : c.longs < 0 ? 'sell' : 'text', rule: true },
    { label: t('Shorts'), text: `${coinText(c.shorts, coin)} · ${t('since the start')} ${coinText(c.cumShorts, coin)}`, color: c.shorts > 0 ? 'sell' : c.shorts < 0 ? 'buy' : 'text' },
    { label: t('Net'), text: `${coinText(c.v, coin)} · ${t('since the start')} ${coinText(c.cum, coin)}`, color: c.cum > 0 ? 'buy' : c.cum < 0 ? 'sell' : 'text' },
  );
  if (markets > 1 && c.covered < markets) lines.push({ text: t('{n} of {m} venues', { n: c.covered, m: markets }), color: 'muted' });
  if (c.coarse) lines.push({ text: t('A market read less often than every candle: its change since its last reading is given to its takers over that whole stretch.'), color: 'muted', wrap: true });
  if (c.byPrice) lines.push({ text: t('Where a market\'s flow is not recorded, the way the price went decides.'), color: 'muted', wrap: true });
  lines.push({ text: t('An estimate for {market}: the change of open interest given to the side that traded at market.', { market }), color: 'muted', wrap: true });
  return lines;
}
