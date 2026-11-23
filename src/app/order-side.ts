/**
 * Two-sided figures take the colour of what their orders do (Karl, 2026-11-21, to cut mental load; AGENTS "Words and look"): the buy colour
 * for a side whose orders buy, the sell colour for one whose orders sell, whatever the side is called. The book's bids buy and its asks sell;
 * the liquidation levels are named after positions, and a position is closed by the opposite order, so their colours are the other way round
 * from their names' usual green and red. This module is that rule for the levels, pure: new code that draws them asks it (older surfaces still
 * restate it locally, each pinned by its own tests; AGENTS names them).
 */
import type { LevelsKind } from './liq-levels.ts';

/** What a side's orders do. */
export type OrderSide = 'buy' | 'sell';

/**
 * What the orders on one side of the liquidation levels would do when price reached them. `side` is the levels' ARRAY side, not whose
 * positions they are: 'long' below the price, 'short' above (`LiqLevels`). Liquidations and stops (`kind` liq, stops, both) close positions:
 * a long by a sell, a short by a buy. Take profits alone keep the shorts' take profits below the price, in the 'long' array
 * (`sideTitle('takes', 'long')` is "Take profits of shorts"): those buy, and the longs' above sell, as a book's bids and asks do. Under every
 * kind the two sides do opposite things.
 */
export function levelsOrderSide(kind: LevelsKind, side: 'long' | 'short'): OrderSide {
  return (side === 'long') === (kind === 'takes') ? 'buy' : 'sell';
}

/** What the two sides of a pane like Depth do: the side above the price and the side below it. */
export interface DepthSides { above: OrderSide; below: OrderSide }

/**
 * What the Depth pane's two sides do: `kind` null for the order book (its asks above sell, its bids below buy), else the liquidation levels'
 * kind as drawn (`curveOf`), whose shorts above are bought back and longs below sold, and whose take profits alone are like the book.
 */
export function depthOrderSides(kind: LevelsKind | null): DepthSides {
  return kind === null ? { above: 'sell', below: 'buy' } : { above: levelsOrderSide(kind, 'short'), below: levelsOrderSide(kind, 'long') };
}

/**
 * A Depth figure's Δ: what its orders would buy less what they would sell (`depthBuyLessSell`), the sign and the colour saying the same thing:
 * positive in the buy colour, negative in the sell colour. Karl, 2026-11-22: the liquidation table's Δ was the first column less the second,
 * longs less shorts, which is selling less buying, and left uncoloured; in the Terminal theme the plain text is the buy colour, so "−117M"
 * (shorts leading: buying) read green whatever its sign, and the same figure was green with either sign.
 */
export function depthBuyLessSell(below: number, above: number, sides: DepthSides): number {
  return sides.below === 'buy' ? below - above : above - below;
}

/**
 * Which colour of the book's pair a side's orders take, as the palette's key: 'bid' for buys, 'ask' for sells. The surface picks the pair (the
 * Depth pane and every pane table ink in bid and ask, the map's liquidation column in the candle colours); the side's orders pick which of its two.
 */
export const bidAskKey = (side: OrderSide): 'bid' | 'ask' => side === 'buy' ? 'bid' : 'ask';
