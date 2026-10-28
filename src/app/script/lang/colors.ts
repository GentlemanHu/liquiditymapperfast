/**
 * Colours as scripts write them: `rgb(r, g, b)`, `rgba(r, g, b, a)`, `#rrggbb`, `#rgb`, `#rrggbbaa` or a CSS name, and blends between
 * them (`interpolate`). Everything a script gives as a colour is checked here before the page paints with it.
 */

export const COLOR_NAMES: Readonly<Record<string, string>> = {
  transparent: 'rgba(0, 0, 0, 0)', black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', navy: '#000080', teal: '#008080', pink: '#ffc0cb',
  gold: '#ffd700', brown: '#a52a2a', violet: '#ee82ee', indigo: '#4b0082', coral: '#ff7f50', salmon: '#fa8072', crimson: '#dc143c',
  tomato: '#ff6347', turquoise: '#40e0d0', khaki: '#f0e68c', orchid: '#da70d6', plum: '#dda0dd', lavender: '#e6e6fa', beige: '#f5f5dc',
  chocolate: '#d2691e', tan: '#d2b48c', skyblue: '#87ceeb', steelblue: '#4682b4', royalblue: '#4169e1', dodgerblue: '#1e90ff',
  deepskyblue: '#00bfff', limegreen: '#32cd32', forestgreen: '#228b22', seagreen: '#2e8b57', springgreen: '#00ff7f', darkgreen: '#006400',
  darkred: '#8b0000', darkblue: '#00008b', darkorange: '#ff8c00', darkviolet: '#9400d3', deeppink: '#ff1493', hotpink: '#ff69b4',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969',
  slategray: '#708090', lightblue: '#add8e6', lightgreen: '#90ee90', yellowgreen: '#9acd32', greenyellow: '#adff2f', chartreuse: '#7fff00',
};

const clamp = (v: number, lo: number, hi: number): number => Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;

/** `rgb(...)`/`rgba(...)` from numbers: each channel held to 0..255, alpha to 0..1. */
export function rgb(c: readonly number[]): string {
  const r = Math.round(clamp(c[0] ?? 0, 0, 255)), g = Math.round(clamp(c[1] ?? 0, 0, 255)), b = Math.round(clamp(c[2] ?? 0, 0, 255));
  if (c.length < 4) return lastSafe = `rgb(${r}, ${g}, ${b})`;
  const a = +clamp(c[3]!, 0, 1).toFixed(3), out = `rgba(${r}, ${g}, ${b}, ${a})`;
  // Whole channels and an alpha of three decimals under 1 are written as `safeColor` writes them; an alpha of 1 is not (it writes rgb).
  if (a < 1) lastSafe = out;
  return out;
}

/**
 * The last colour `rgb` made that `safeColor` would write the same: a script blends a colour (`interpolate`) and paints a point with it at
 * once, and that colour is then taken as it is rather than read again.
 */
let lastSafe = '';

/** A colour's channels (0..255, alpha 0..1). */
export type Channels = readonly [number, number, number, number];

/**
 * What reading a text as a colour gave, kept by the text: a script hands the same few colours over on every candle (a heat map's three, its
 * rows' blends) and the page reads them again on every frame, and reading one with patterns was the larger part of running such a script
 * (2026-10-27). Bounded: a full table starts again, and only short texts are kept (a colour is; a script's text may be 100,000 characters,
 * and is read as before without being kept). The channels are frozen, since every reader of the same text shares them.
 */
const CACHED = 4096, KEPT_CHARS = 64;
const parsed = new Map<string, Channels | null>();
const safe = new Map<string, string | null>();
const remember = <T>(table: Map<string, T>, key: string, value: T): T => {
  if (key.length > KEPT_CHARS) return value;
  if (table.size >= CACHED) table.clear();
  table.set(key, value);
  return value;
};

/** A colour's channels (0..255, alpha 0..1), or null when it is not one this page reads. */
export function parseColor(raw: unknown): Channels | null {
  if (typeof raw !== 'string') return null;
  const had = parsed.get(raw);
  return had !== undefined ? had : remember(parsed, raw, readColor(raw));
}
function readColor(raw: string): Channels | null {
  const c = channelsOf(raw);
  return c ? Object.freeze(c) : null;
}
function channelsOf(raw: string): [number, number, number, number] | null {
  const s = raw.trim().toLowerCase();
  const named = Object.prototype.hasOwnProperty.call(COLOR_NAMES, s) ? COLOR_NAMES[s] : undefined;
  if (named) return channelsOf(named);
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) { const h = m[1]!; const ch = (k: number): number => parseInt(h[k]! + h[k]!, 16); return [ch(0), ch(1), ch(2), h.length === 4 ? ch(3) / 255 : 1]; }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) { const h = m[1]!; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1]; }
  m = /^rgba?\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*(?:,\s*([-\d.]+)\s*)?\)$/.exec(s);
  if (m) return [clamp(+m[1]!, 0, 255), clamp(+m[2]!, 0, 255), clamp(+m[3]!, 0, 255), m[4] === undefined ? 1 : clamp(+m[4], 0, 1)];
  return null;
}

/** A colour the page may paint with: the script's own when it reads as one, else `fallback`. */
export function safeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  if (raw === lastSafe && raw !== '') return raw;
  let out = safe.get(raw);
  if (out === undefined) {
    const c = parseColor(raw);
    out = remember(safe, raw, c ? (c[3] >= 1 ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})` : `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${+c[3].toFixed(3)})`) : null);
  }
  return out ?? fallback;
}

/** A colour with its alpha multiplied by `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${+clamp(c[3] * alpha, 0, 1).toFixed(3)})`;
}

/**
 * The colour at `ratio` (0..1, held there) along `colors`, evenly spaced, blending each channel and the alpha linearly between the two
 * around it. With one colour it is that colour; with none, or a ratio that is not a number, the first colour.
 */
export function interpolateColors(ratio: number, colors: readonly unknown[]): string {
  const read = readList(colors);
  if (!read.length) return typeof colors[0] === 'string' ? colors[0] : 'rgba(0, 0, 0, 0)';
  if (read.length === 1 || !Number.isFinite(ratio)) return rgb(read[0]!);
  const x = clamp(ratio, 0, 1) * (read.length - 1), k = Math.min(read.length - 2, Math.floor(x)), f = x - k;
  const a = read[k]!, b = read[k + 1]!;
  const mixed: number[] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const alpha = a[3] + (b[3] - a[3]) * f;
  if (!(alpha >= 1)) mixed.push(alpha);
  return rgb(mixed);
}

/**
 * The last list of colours read, and the ones of it that read as colours: a script blends between the same few on every call. Only a short
 * list of short texts is kept: anything else a script passes (a function, a long text) is read without being held after the call.
 */
let lastList: readonly string[] = [], lastRead: readonly Channels[] = [];
function readList(colors: readonly unknown[]): readonly Channels[] {
  let same = colors.length === lastList.length;
  for (let k = 0; same && k < colors.length; k++) same = colors[k] === lastList[k];
  if (same) return lastRead;
  const out: Channels[] = [];
  for (const c of colors) { const ch = parseColor(c); if (ch) out.push(ch); }
  if (colors.length <= 16 && colors.every(c => typeof c === 'string' && c.length <= KEPT_CHARS)) { lastList = colors.slice() as string[]; lastRead = out; }
  return out;
}
