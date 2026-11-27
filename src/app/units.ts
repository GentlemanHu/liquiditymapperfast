import { usd } from './format.ts';
import { currentCoin } from './coin.ts';

/**
 * The units the page writes sizes in (issue 9, 2026-11-26): dollars, or the coin on screen. One setting for the whole page (`state.units`,
 * kept in this browser like the clock, never in a layout), read by every figure that writes a size, as `format.ts` keeps the clock.
 *
 * - **Dollars mode is the page as it always was.** Dollars stay in every structure the page shares; coins are carried beside them (worked out
 *   only while coin mode is on) and chosen where a figure is drawn or written. What decides what is shown keeps reading dollars in both modes:
 *   size settings and filters (bubbles, liquidations, absorption, the Tape, sounds), Highlights, the top-N cuts, the cue tracker, scripts and
 *   the agent tools.
 * - **A coin figure is each part's dollars over the price that part was valued at**: a level's, a price row's, an order's, a liquidation's
 *   reported price, a second's volume-weighted price, a minute's or a candle's own price; parts are added up after that, never a total over
 *   today's price.
 * - **A floor written for dollars is a dollar's worth of coin** (`unitFloor`), so a picture keeps its look when the units change and only the
 *   numbers do.
 */
export type Units = 'usd' | 'coin';

let current: Units = 'usd';
export function setUnits(next: Units): void { current = next === 'coin' ? 'coin' : 'usd'; }
export const units = (): Units => current;
export const inCoins = (): boolean => current === 'coin';
/** A saved value as the setting holds it: anything but 'coin' is dollars. */
export const readUnits = (raw: unknown): Units => raw === 'coin' ? 'coin' : 'usd';
/** The unit's name for a heading or beside a figure: USD, or the coin's ticker (BTC). */
export const unitName = (): string => current === 'coin' ? currentCoin().coin : 'USD';
/**
 * A heading that names the units, as `full` while it fits in `room` pixels, else the units alone: a long ticker (VIRTUAL, BIGTIME) does
 * not run into the heading beside it. `measure` is the width of a text as it is drawn (a canvas's `measureText`).
 */
export const unitHead = (full: string, room: number, measure: (text: string) => number): string => measure(full) <= room ? full : unitName();

/** The coins `usdValue` bought at `price`; NaN where there is no price. */
export const coinsAt = (usdValue: number, price: number): number => price > 0 ? usdValue / price : Number.NaN;
/** An amount valued in dollars at `price`, in the page's units. */
export const inUnits = (usdValue: number, price: number): number => current === 'coin' ? coinsAt(usdValue, price) : usdValue;
/**
 * A floor written for dollars (`Math.max(x, 1)`, `value >= 1`) in the page's units at `price`: 1 in dollars, a dollar's worth of the coin in
 * coins, so the picture drawn from it does not change with the units.
 */
export const unitFloor = (price: number): number => current === 'coin' ? (price > 0 ? 1 / price : 1e-12) : 1;

const intl = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const UNITS = ['', 'K', 'M', 'B', 'T'] as const;
/**
 * Coins to three significant figures in the compact form (0.0125, 0.35, 13.2, 551, 5.51K, 1.38B): what Intl's compact notation writes, without
 * Intl (a book or a tape writes hundreds of figures a second, and Intl costs microseconds each, `format.ts`). A fraction of a coin is never
 * written 0. Where the division sits within a hair of a tie, and from a thousand trillion up, Intl's exact decimal decides. Checked against
 * Intl in tests/app-units.test.mts.
 */
export function coinText(value: number): string {
  if (!Number.isFinite(value)) return '–';
  if (value === 0) return '0';
  const a = Math.abs(value);
  if (a >= 1e15 || a < 1e-12) return intl.format(value);
  let e = Math.floor(Math.log10(a));
  // log10 is a hair off at some powers of ten (log10(1000) can read 2.9999999999999996): put the exponent right.
  if (a / 10 ** e >= 10) e++; else if (a / 10 ** e < 1) e--;
  let scaled = a / 10 ** (e - 2);
  if (Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-7) return intl.format(value);
  let m = Math.round(scaled);
  if (m >= 1000) {
    e++; scaled = a / 10 ** (e - 2);
    if (Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-7) return intl.format(value);
    m = Math.round(scaled);
  }
  const sign = value < 0 ? '-' : '';
  // Under a thousand the three figures take as many decimals as they need (0.0125, 5.51, 13.2, 551); from a thousand up they are written in
  // the unit they fall in (5.51K, 13.2M, 551B). Trailing zeros go (0.35, 1.2K, 5).
  const u = e < 3 ? 0 : Math.min(4, Math.floor(e / 3)), inUnit = e - 3 * u;
  if (inUnit > 2) return intl.format(value);
  const digits = 2 - inUnit;
  const text = digits === 0 ? String(m) : trimZeros((m / 10 ** digits).toFixed(digits));
  return `${sign}${text}${UNITS[u]}`;
}
const trimZeros = (s: string): string => s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;

/** A size already in the page's units, bare, as narrow places write sizes: "1.2M" in dollars, "13.2" or "0.0125" in coins. */
export const figure = (value: number): string => current === 'coin' ? coinText(value) : usd(value);
/**
 * A size already in the page's units with its unit: "$1.2M", or "13.2 BTC". In dollars exactly what `$${usd(value)}` wrote ("$–" for no
 * figure, "$-2.5K" for a negative one: say a sign with `signedAmount`).
 */
export const amount = (value: number): string => current === 'coin' ? `${coinText(value)} ${currentCoin().coin}` : `$${usd(value)}`;
/** A signed size with its unit, as the flow column writes one: "+$12.3M", "−$4.1M", "$0", "–" for none; in coins "+13.2 BTC", "−0.35 BTC", "0 BTC". */
export function signedAmount(value: number): string {
  if (!Number.isFinite(value)) return '–';
  if (value === 0) return current === 'coin' ? `0 ${currentCoin().coin}` : '$0';
  return `${value < 0 ? '−' : '+'}${amount(Math.abs(value))}`;
}
/** A signed size bare, as the order book writes one: "+1.2M", "−4.1M", "0"; in coins "+13.2", "−0.35". */
export const signedFigure = (value: number): string => `${value > 0 ? '+' : value < 0 ? '−' : ''}${figure(Math.abs(value))}`;
