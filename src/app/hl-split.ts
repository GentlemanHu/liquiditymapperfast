/**
 * The Long/Short pane's choices for Hyperliquid's lines (hl-sides.ts), kept apart so the store can read them without loading the feature's
 * code: how the line is split, and what each side counts.
 */

/** Everyone with the profitable and the losing traders (HyperTracker's all-time PnL above or below zero), the eight PnL bands, or the eight size bands. */
export type HlSplit = 'groups' | 'pnl' | 'size';
/** The wallets on each side, or the dollars they hold. */
export type HlUnit = 'wallets' | 'usd';
export const HL_SPLITS: readonly HlSplit[] = ['groups', 'pnl', 'size'];
export const HL_UNITS: readonly HlUnit[] = ['wallets', 'usd'];
