import { binOf, type FootprintRow, type ProfileAnswer } from '../../shared/footprint.ts';
import { markedPart, type AbsorptionGroup } from '../../shared/absorption.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import { usd } from '../format.ts';
import { t } from '../i18n.ts';
import { VOLUME_WORDS, type ColumnWords, type TradedRows } from '../traded.ts';

/**
 * What the volume profile column adds up by price. Traded volume is the footprint's; the others put another record on the same rows, two
 * sides each in the same places (bid colour, then ask colour), so the bars, the point of control, the value area and the lines read them
 * the same way:
 * - absorption: the marked part of each absorption group (shared/absorption.ts `markedPart`, counted once a group) at the threshold the
 *   Absorption settings judge it at: market sells that met resting buyers, then market buys that met resting sellers;
 * - liquidations: reported liquidations at the price the market was at (shared/liquidations.ts): shorts liquidated (forced buys), then longs
 *   liquidated (forced sells). Only the venues that publish them count, Binance at most one a market a second.
 * - open interest: each perpetual's change between its readings spread over the prices that traded on it in between (shared/oi-profile.ts):
 *   where exposure grew, then where it shrank. An estimate of where, never of who.
 * Each is what was recorded, not all there was: the column's header says where a record is cut.
 */
export type ProfileMetric = 'volume' | 'oi' | 'absorption' | 'liquidations';
export const PROFILE_METRICS: readonly ProfileMetric[] = ['volume', 'oi', 'absorption', 'liquidations'];

/** The words of each measure: what its rows' two sides are called, and its header. */
export function metricWords(metric: ProfileMetric): ColumnWords {
  switch (metric) {
    case 'absorption': return { buy: t('Resting buyers took'), sell: t('Resting sellers took'), net: t('Difference'), share: t('Share of the absorbed'), none: t('Nothing absorbed at these prices in this window.') };
    case 'liquidations': return { buy: t('Shorts liquidated'), sell: t('Longs liquidated'), net: t('Difference'), share: t('Share of the liquidations'), none: t('No liquidation reported at these prices in this window.') };
    case 'oi': return { buy: t('Open interest added'), sell: t('Open interest removed'), net: t('Net change'), share: t('Share of the change'), none: t('No change in open interest placed at these prices.') };
    default: return VOLUME_WORDS;
  }
}

/**
 * What a measure's answer leaves out: `cut`, its record was cut at a limit (the smallest left out); `incomplete`, some minutes keep only
 * their largest groups; `unplaced`, the change in open interest that could not be put at a price (USD, signed).
 */
export interface MetricFlags { cut: boolean; incomplete: boolean; unplaced?: number }

/** A signed USD amount: +$1.2M, −$300K. */
const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;

/**
 * The two header lines of a measure other than traded volume: its total, then where its record is cut (`warn`: said in amber), or the
 * largest row. Open interest gives what was added and what was removed, and the change it could not place when that is more than a
 * hundredth of what it placed.
 */
export function metricHeader(metric: ProfileMetric, rows: TradedRows | null, flags: MetricFlags): { head: string; sub: string; warn: boolean } {
  const head = metric === 'oi' ? t('OI CHANGE') : metric === 'absorption' ? t('ABSORBED') : t('LIQUIDATED');
  if (!rows) return { head, sub: '', warn: false };
  if (metric === 'oi') {
    let up = 0, down = 0; for (let i = 0; i < rows.buy.length; i++) { up += rows.buy[i]!; down += rows.sell[i]!; }
    const unplaced = flags.unplaced ?? 0, total = t('OI +{up} −{down}', { up: usd(up), down: usd(down) });
    return Math.abs(unplaced) > (up + down) / 100 ? { head: total, sub: t('{value} not placed', { value: signed(unplaced) }), warn: true } : { head: total, sub: t('ROW MAX {value}', { value: usd(rows.max) }), warn: false };
  }
  const total = metric === 'absorption' ? t('ABSORBED {value}', { value: usd(rows.total) }) : t('LIQUIDATED {value}', { value: usd(rows.total) });
  if (flags.cut) return { head: total, sub: metric === 'liquidations' ? t('the largest 5,000') : t('the largest only'), warn: true };
  if (flags.incomplete) return { head: total, sub: t('some minutes in part'), warn: true };
  return { head: total, sub: t('ROW MAX {value}', { value: usd(rows.max) }), warn: false };
}

/** Rows of `step` from amounts at prices, by instrument: [side a, side b] at each row, as a profile answer. */
function answerOf(by: Map<string, Map<number, [number, number]>>, step: number, from: number, to: number): ProfileAnswer {
  return {
    from, to,
    instruments: [...by].map(([id, bins]) => ({
      id, step, minutes: 0, first: null, earliest: null,
      rows: [...bins].sort((a, b) => a[0] - b[0]).map(([bin, [a, b]]): FootprintRow => [bin * step, a, b]),
    })),
  };
}

function add(by: Map<string, Map<number, [number, number]>>, id: string, bin: number, side: 0 | 1, amount: number): void {
  let bins = by.get(id); if (!bins) { bins = new Map(); by.set(id, bins); }
  const cell = bins.get(bin) ?? [0, 0]; cell[side] += amount; bins.set(bin, cell);
}

/** Liquidations of `ids` in [from, to) by price on rows of `step`: shorts liquidated, then longs liquidated, in USD. */
export function liquidationAnswer(rows: readonly Liquidation[], ids: readonly string[], from: number, to: number, step: number): ProfileAnswer {
  const wanted = new Set(ids), by = new Map<string, Map<number, [number, number]>>();
  for (const l of rows) if (wanted.has(l.id) && l.t >= from && l.t < to && l.price > 0) add(by, l.id, binOf(l.price, step), l.side === 'short' ? 0 : 1, l.usd);
  return answerOf(by, step, from, to);
}

/**
 * The marked part of each absorption group that began in [from, to), at its instrument's threshold (none: nothing of it is marked), by
 * price on rows of `step`: market sells taken by resting buyers, then market buys taken by resting sellers, in USD.
 */
export function absorptionAnswer(groups: readonly AbsorptionGroup[], thresholds: ReadonlyMap<string, number | null>, from: number, to: number, step: number): ProfileAnswer {
  const by = new Map<string, Map<number, [number, number]>>();
  for (const g of groups) {
    const threshold = thresholds.get(g.id);
    if (g.t0 < from || g.t0 >= to || threshold === null || threshold === undefined) continue;
    const part = markedPart(g, threshold);
    if (part) add(by, g.id, binOf(g.price, step), g.side === 'sell' ? 0 : 1, part.usd);
  }
  return answerOf(by, step, from, to);
}
