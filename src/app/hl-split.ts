/**
 * The Long/Short pane's choices for Hyperliquid's lines (hl-sides.ts), kept apart so the store can read them without loading the feature's
 * code: how the line is split, and what each side counts.
 */

/**
 * Everyone with the profitable and the losing traders (HyperTracker's all-time PnL above or below zero), the eight PnL bands, the eight size
 * bands, or none (`off`: the exchanges' lines alone, on their own scale).
 */
export type HlSplit = 'groups' | 'pnl' | 'size' | 'off';
/** The wallets on each side, or the dollars they hold. */
export type HlUnit = 'wallets' | 'usd';
export const HL_SPLITS: readonly HlSplit[] = ['groups', 'pnl', 'size', 'off'];
export const HL_UNITS: readonly HlUnit[] = ['wallets', 'usd'];
