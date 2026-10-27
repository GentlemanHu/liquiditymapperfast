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
  const [r, g, b] = [0, 1, 2].map(k => Math.round(clamp(c[k] ?? 0, 0, 255)));
  return c.length >= 4 ? `rgba(${r}, ${g}, ${b}, ${+clamp(c[3]!, 0, 1).toFixed(3)})` : `rgb(${r}, ${g}, ${b})`;
}

/** A colour's channels (0..255, alpha 0..1), or null when it is not one this page reads. */
export function parseColor(raw: unknown): [number, number, number, number] | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const named = Object.prototype.hasOwnProperty.call(COLOR_NAMES, s) ? COLOR_NAMES[s] : undefined;
  if (named) return parseColor(named);
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
  const c = parseColor(raw);
  return c ? (c[3] >= 1 ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})` : `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${+c[3].toFixed(3)})`) : fallback;
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
  const parsed = colors.map(parseColor).filter((c): c is [number, number, number, number] => c !== null);
  if (!parsed.length) return typeof colors[0] === 'string' ? colors[0] : 'rgba(0, 0, 0, 0)';
  if (parsed.length === 1 || !Number.isFinite(ratio)) return rgb(parsed[0]!);
  const x = clamp(ratio, 0, 1) * (parsed.length - 1), k = Math.min(parsed.length - 2, Math.floor(x)), f = x - k;
  const a = parsed[k]!, b = parsed[k + 1]!;
  const mixed = [0, 1, 2, 3].map(j => a[j]! + (b[j]! - a[j]!) * f);
  return rgb(mixed[3]! >= 1 ? mixed.slice(0, 3) : mixed);
}
