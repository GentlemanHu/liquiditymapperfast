import { SIZE_MAX_USD } from '../sizes.ts';
import { LIQUIDATION_FLOOR_USD } from '../../shared/liquidations.ts';

/** What the Tape shows: market orders only, forced liquidations only, or both together (without double-counting). */
export type TapeMode = 'trades' | 'both' | 'liquidations';

/**
 * Trades' settings (the flow column's second view, which replaced Time & sales and All trades on 2026-11-13): what it shows (`mode`),
 * what one row is (`unit`: 0 is each order, else a block of that many whole seconds), the smallest order counted (0: any size), the
 * smallest liquidation counted (coin-scaled, from $100), the side, whether a burst is one row (each order only), and whether a pinned
 * recent-liquidations strip sits above Trades/Both.
 */
export interface TradesSettings { mode: TapeMode; unit: number; minUsd: number; liqMinUsd: number; side: 'both' | 'buy' | 'sell'; group: boolean; pinLiq: boolean }
export const TRADES_DEFAULTS: Readonly<TradesSettings> = { mode: 'trades', unit: 0, minUsd: 0, liqMinUsd: 1_000, side: 'both', group: true, pinLiq: false };
/** The defaults until 2026-11-14 (revision 5 of the page's defaults): a second a row, any size, both sides, grouping off. */
export const TRADES_REV5: Readonly<TradesSettings> = { mode: 'trades', unit: 1, minUsd: 0, liqMinUsd: 1_000, side: 'both', group: false, pinLiq: false };
/**
 * Whether a save's Trades settings are revision 5's defaults as it wrote them down (every save wrote them, chosen or not): each field it
 * holds is that default, a field it lacks (a save from before the field) counting as one.
 */
export function tradesRev5Default(saved: unknown): boolean {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADES_REV5;
  return (s.unit ?? d.unit) === d.unit && (s.minUsd ?? d.minUsd) === d.minUsd && (s.side ?? d.side) === d.side && (s.group ?? d.group) === d.group;
}
/** The sizes offered after "Any size" (BTC's dollars; scaled for a coin that trades less; any size can be typed). */
export const TRADES_MINIMUMS: readonly number[] = [1_000, 5_000, 10_000, 25_000, 100_000];
/** The liquidation sizes offered in the Tape (BTC's dollars, coin-scaled; every liquidation from $100 is kept). */
export const TRADES_LIQ_MINIMUMS: readonly number[] = [100, 1_000, 5_000, 10_000, 25_000, 100_000, 500_000];
/** The units the Group by menu offers (0: each order); any whole number of seconds up to `UNIT_MAX_S` can be chosen as Custom. */
export const TRADE_UNITS: readonly number[] = [0, 1, 60, 300, 900];
export const UNIT_MAX_S = 900;
/** Orders of one market and side in the same slice of this long are one row when grouping is on (fixed slices, so a row never changes as the list scrolls; the tape carries no fill count: ×N counts orders). */
export const GROUP_MS = 100;
/** Liquidations of one market and side in the same fixed slice are one row when grouping is on (cascades emit rapid fills per venue). */
export const LIQ_GROUP_MS = 250;

/** A unit as saved: 0 (each order) or a whole number of seconds from 1 to `UNIT_MAX_S`. */
export const readUnit = (v: unknown, fallback: number): number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= UNIT_MAX_S ? v : fallback;

export function readTrades(saved: unknown): TradesSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = TRADES_DEFAULTS;
  const min = typeof s.minUsd === 'number' && Number.isFinite(s.minUsd) && s.minUsd >= 0 && s.minUsd <= SIZE_MAX_USD ? s.minUsd : d.minUsd;
  const liqMin = typeof s.liqMinUsd === 'number' && Number.isFinite(s.liqMinUsd) && s.liqMinUsd >= LIQUIDATION_FLOOR_USD && s.liqMinUsd <= SIZE_MAX_USD ? s.liqMinUsd : d.liqMinUsd;
  const mode: TapeMode = s.mode === 'both' || s.mode === 'liquidations' ? s.mode : 'trades';
  // A save from before the unit existed was All trades' (each order) or Time & sales' (the large orders): both open on the default.
  return { mode, unit: readUnit(s.unit, d.unit), minUsd: min, liqMinUsd: liqMin, side: s.side === 'buy' || s.side === 'sell' ? s.side : 'both', group: typeof s.group === 'boolean' ? s.group : d.group, pinLiq: typeof s.pinLiq === 'boolean' ? s.pinLiq : d.pinLiq };
}
