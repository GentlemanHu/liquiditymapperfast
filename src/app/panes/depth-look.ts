/**
 * How the Depth pane's bands look: terraces (Karl's pick, 2026-11-22). `?depthLook=today|edges` in the address (or `window.__depthLook`
 * while testing) draws the plain rings or the contours alone, for comparing. Each look draws the same rings at the same heights and changes
 * only how the bands look. Worked out in a lab with the advisor and Astra (session notes `depth-3d-look.md`):
 * - edges: today's fills with a fine contour on every band's true edge, in a tone of that band's own hue 1.6:1 off both neighbours.
 * - terraces: stacked sheets, the innermost nearest: a contact seam outside each inner sheet (reach at most a quarter of the strip it lies on,
 *   none under 4 px), a thin bevel on each sheet's own strip lit by one light from the upper left, the same contours on top.
 * Colours come from the palette alone; tones keep the side colour's hue (OKLCH), never mixing in the text colour. Drawn once into a cached
 * layer per answer, view, size and palette, so a pointer move only copies it.
 */
import { contrastRatio, mixHex, rgb, type Palette } from '../theme.ts';

export type DepthLook = 'today' | 'edges' | 'terraces';
let urlLook: DepthLook | null = null;
/** The look asked for: `window.__depthLook` (tests), else `?depthLook=` in the address, else terraces. */
export function depthLook(): DepthLook {
  const live = (globalThis as { __depthLook?: unknown }).__depthLook;
  if (live === 'edges' || live === 'terraces' || live === 'today') return live;
  if (urlLook === null) {
    const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('depthLook');
    urlLook = v === 'edges' || v === 'today' ? v : 'terraces';
  }
  return urlLook;
}

// ---------- OKLab / OKLCH ----------
const toLin = (c: number): number => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const toSrgb = (c: number): number => c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map(toLin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
function labToLinear(L: number, A: number, B: number): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
const inGamut = (c: number[]): boolean => c.every(v => v >= -1e-4 && v <= 1 + 1e-4);
const hexOf = (c: number[]): string => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, toSrgb(Math.max(0, Math.min(1, v))))) * 255).toString(16).padStart(2, '0')).join('');
function lch(hex: string): [number, number, number] { const [L, A, B] = oklab(hex); return [L, Math.hypot(A, B), Math.atan2(B, A)]; }
/** An OKLCH colour, its chroma reduced until it fits the display (hue and lightness kept). */
function fromLch(L: number, C: number, h: number): string {
  L = Math.max(0, Math.min(1, L));
  const at = (c: number): number[] => labToLinear(L, c * Math.cos(h), c * Math.sin(h));
  if (inGamut(at(C))) return hexOf(at(C));
  let lo = 0, hi = C;
  for (let i = 0; i < 18; i++) { const c = (lo + hi) / 2; if (inGamut(at(c))) lo = c; else hi = c; }
  return hexOf(at(lo));
}
const shiftL = (hex: string, dL: number): string => { const [L, C, h] = lch(hex); return fromLch(L + dL, C, h); };
const rgba = (hex: string, a: number): string => { const [r, g, b] = rgb(hex); return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`; };

/** Today's fills, outermost lightest (the pane's own sRGB mix toward the ground). */
const fillsOf = (p: Palette, side: string, top: number): string[] => Array.from({ length: top + 1 }, (_, j) => mixHex(p.bg, side, top === 0 ? 1 : 0.3 + 0.7 * (1 - j / top)));
/** A contour's ink: the weakest same-hue tone `target`:1 from the band, the band outside and the bevel tones beside it; the other way where no room. */
function contourInk(inside: string, outside: string, dir: number, extras: readonly string[] = [], target = 1.6): string {
  const [L, C, h] = lch(inside), against = [inside, outside, ...extras];
  const search = (d0: number): { ink: string; score: number; ok: boolean } => {
    let best = inside, bestScore = 0;
    for (let d = 0.02; d <= 0.7; d += 0.01) {
      const ink = fromLch(L + d0 * d, C * (d0 > 0 ? 0.85 : 1), h), score = Math.min(...against.map(c => contrastRatio(ink, c)));
      if (score >= target) return { ink, score, ok: true };
      if (score > bestScore) { best = ink; bestScore = score; }
    }
    return { ink: best, score: bestScore, ok: false };
  };
  const a = search(dir); if (a.ok) return a.ink;
  const b = search(-dir); return b.ok || b.score > a.score ? b.ink : a.ink;
}
function contourDir(p: Palette, fills: readonly string[]): number {
  const Lg = oklab(p.bg)[0];
  if (Lg < 0.35) return 1;
  if (Lg > 0.8) return -1;
  const Lmax = Math.max(...fills.map(f => oklab(f)[0]));
  return 1 - Lmax > Lmax ? 1 : -1;
}

/** What the looks draw: the pane's own arrays and mapping (lower-panes.ts #paint). */
export interface BandInput {
  look: Exclude<DepthLook, 'today'>; palette: Palette; up: string; down: string;
  w: number; k: number; top: number; bid: ArrayLike<number>; ask: ArrayLike<number>; xs: Float64Array; mid: number; yOf: (v: number) => number; pw: number; ph: number;
}
type Side = { hs: Float32Array[]; sign: number; ink: string };

function heights(input: BandInput): Side[] {
  const { w, k, top, bid, ask, yOf } = input, up: Float32Array[] = [], down: Float32Array[] = [];
  for (let j = 0; j <= top; j++) {
    const u = new Float32Array(w), d = new Float32Array(w);
    for (let x = 0; x < w; x++) { u[x] = yOf(ask[x * k + j]!); d[x] = yOf(bid[x * k + j]!); }
    up.push(u); down.push(d);
  }
  return [{ hs: up, sign: -1, ink: input.up }, { hs: down, sign: 1, ink: input.down }];
}
function bandPath(input: BandInput, hs: Float32Array, sign: number): Path2D {
  const path = new Path2D(), { xs, mid, w } = input;
  let open = false;
  for (let x = 0; x < w; x++) {
    const h = hs[x]!;
    if (!(h > 0)) { if (open) { path.lineTo(xs[x]!, mid); path.closePath(); open = false; } continue; }
    const y = mid + sign * h;
    if (!open) { path.moveTo(xs[x]!, mid); path.lineTo(xs[x]!, y); open = true; } else path.lineTo(xs[x]!, y);
    path.lineTo(xs[x + 1]! + 0.6, y);
  }
  if (open) { path.lineTo(xs[w]! + 0.6, mid); path.closePath(); }
  return path;
}
function edgePath(input: BandInput, hs: Float32Array, sign: number, skip: ((x: number) => boolean) | null): Path2D {
  const path = new Path2D(), { xs, mid, w } = input;
  let open = false;
  for (let x = 0; x < w; x++) {
    const h = hs[x]!;
    if (!(h > 0) || skip?.(x)) { open = false; continue; }
    const y = mid + sign * h;
    if (!open) { path.moveTo(xs[x]!, y); open = true; } else path.lineTo(xs[x]!, y);
    path.lineTo(xs[x + 1]!, y);
  }
  return path;
}
/** A band's edge split by which way each piece faces one light from the upper left, and by a bucket per column (-1: left out). */
function facingPaths(input: BandInput, hs: Float32Array, sign: number, bucket: (x: number) => number, n: number): { lit: Path2D[]; shade: Path2D[] } {
  const lit = Array.from({ length: n }, () => new Path2D()), shade = Array.from({ length: n }, () => new Path2D()), { xs, mid, w } = input;
  for (let x = 0; x < w; x++) {
    const h = hs[x]!, b = h > 0 ? bucket(x) : -1; if (b < 0) continue;
    const y = mid + sign * h, t = sign < 0 ? lit[b]! : shade[b]!;
    t.moveTo(xs[x]!, y); t.lineTo(xs[x + 1]!, y);
    if (x + 1 < w) {
      const h2 = hs[x + 1]!; if (!(h2 > 0) || bucket(x + 1) < 0 || Math.abs(h2 - h) < 0.5) continue;
      const p = h2 > h ? lit[b]! : shade[b]!; p.moveTo(xs[x + 1]!, y); p.lineTo(xs[x + 1]!, mid + sign * h2);
    }
  }
  return { lit, shade };
}
const thick = (hs: Float32Array[], j: number, x: number): number => hs[j]![x]! - (j > 0 ? hs[j - 1]![x]! : 0);
function strip(paths: Path2D[], j: number): Path2D { if (j === 0) return paths[0]!; const s = new Path2D(); s.addPath(paths[j]!); s.addPath(paths[j - 1]!); return s; }

function contours(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, input: BandInput, s: Side, fills: string[], dir: number, extras: (j: number) => readonly string[]): void {
  const { top, palette: p } = input;
  ctx.lineJoin = 'round';
  for (let j = top; j >= 0; j--) {
    ctx.strokeStyle = contourInk(fills[j]!, j === top ? p.bg : fills[j + 1]!, dir, extras(j));
    ctx.lineWidth = j === top ? 1.25 : 1;
    // Where this edge lies on the next band's, only the outer contour is drawn.
    const skip = j < top ? (x: number): boolean => Math.abs(s.hs[j + 1]![x]! - s.hs[j]![x]!) < 0.5 : null;
    ctx.stroke(edgePath(input, s.hs[j]!, s.sign, skip));
  }
  ctx.lineWidth = 1;
}

/** Draw the bands in a look (the pane's coordinates, ctx transformed to the plot). */
export function paintBands(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, input: BandInput): void {
  const p = input.palette, compact = input.ph <= 320, sides = heights(input);
  for (const s of sides) {
    const fills = fillsOf(p, s.ink, input.top), dir = contourDir(p, fills);
    const paths: Path2D[] = []; for (let j = 0; j <= input.top; j++) paths.push(bandPath(input, s.hs[j]!, s.sign));
    for (let j = input.top; j >= 0; j--) { ctx.fillStyle = fills[j]!; ctx.fill(paths[j]!); }
    if (input.look === 'edges') { contours(ctx, input, s, fills, dir, () => []); continue; }
    // Terraces: the finish by ground lightness and frame; bolder only where the pane is tall and not on Paper or text mode.
    const Lg = oklab(p.bg)[0], frame = p.frame, bold = !compact && frame !== 'paper' && frame !== 'textmode' ? 1.7 : 1;
    const pale = Lg > 0.8, dark = Lg < 0.35, kk = pale ? 0 : dark ? 1 : (0.8 - Lg) / 0.45;
    const hard = frame === 'textmode' || frame === 'bevel', chrome = frame === 'bevel';
    const seam = (hard ? 1 : compact ? 1 : (pale ? 2 : 1.5 + 0.5 * (1 - kk)) * (frame === 'paper' ? 1.15 : 1)) * (frame === 'textmode' ? 1 : bold);
    const blur = hard ? 0 : (compact ? 0.4 : pale ? 0.75 : 0.6 + 0.15 * (1 - kk)) * bold;
    const alpha = frame === 'textmode' ? 0.45 : chrome ? Math.min(0.85, 0.4 * bold) : Math.min(0.6, (pale ? 0.16 : 0.18 + 0.05 * kk) * bold);
    const bevel = frame === 'textmode' ? 0 : chrome ? 1 : 0.75 * Math.min(bold, 1.4);
    const lift = Math.min(compact ? 0.04 : 0.06, (p.dark ? 0.04 : 0.03) * bold);
    const lo = (p.chrome?.lo) ?? '#808080';
    const caps = [1, 2, Infinity], bucketOf = (T: number): number => T < 4 ? -1 : T < 8 ? 0 : T < 12 ? 1 : 2;
    for (let j = input.top - 1; j >= 0; j--) {
      ctx.save(); ctx.clip(strip(paths, j + 1), 'evenodd');
      ctx.strokeStyle = rgba(chrome ? lo : shiftL(fills[j + 1]!, -0.55), alpha);
      if (blur > 0) ctx.filter = `blur(${blur}px)`;
      const { lit, shade } = facingPaths(input, s.hs[j]!, s.sign, x => bucketOf(thick(s.hs, j + 1, x)), 3);
      for (let b = 0; b < 3; b++) { ctx.lineWidth = 2 * Math.min(seam, caps[b]!); ctx.stroke(lit[b]!); ctx.stroke(shade[b]!); }
      ctx.filter = 'none'; ctx.restore();
    }
    const tones = fills.map(f => chrome ? ['#ffffff', lo] : [shiftL(f, lift), shiftL(f, -lift * 1.25)]);
    if (bevel > 0) for (let j = input.top; j >= 0; j--) {
      ctx.save(); ctx.clip(strip(paths, j), 'evenodd');
      const { lit, shade } = facingPaths(input, s.hs[j]!, s.sign, x => { const T = thick(s.hs, j, x); return T < 4 ? -1 : T < 8 ? 0 : 1; }, 2);
      for (let b = 0; b < 2; b++) {
        ctx.lineWidth = 2 * bevel * (b === 0 ? 0.5 : 1);
        ctx.strokeStyle = tones[j]![0]!; ctx.stroke(lit[b]!);
        ctx.strokeStyle = tones[j]![1]!; ctx.stroke(shade[b]!);
      }
      ctx.restore();
    }
    contours(ctx, input, s, fills, dir, j => bevel > 0 ? tones[j]! : []);
  }
}

/**
 * A layer canvas: a page canvas where there is a page (it stays on the GPU, so copying it each frame is a blit; an OffscreenCanvas made on the
 * page was copied over from memory on every frame: half of a maximized frame's 12 ms of script, 2026-11-22), else an OffscreenCanvas.
 */
type Layer = HTMLCanvasElement | OffscreenCanvas;
const layer = (w: number, h: number): Layer => {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};
const layerContext = (c: Layer): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D => c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The bands drawn once per answer, view mapping, size, palette and look, then copied on every frame that changes nothing of them. */
export class BandLayer {
  #canvas: Layer | null = null;
  #key: unknown[] = [];
  /** How long the last rebuild took (ms), and how many rebuilds so far, for the prototype's timing. */
  lastBuildMs = 0; builds = 0;
  paint(ctx: CanvasRenderingContext2D, input: BandInput, dpr: number): void {
    const key = [input.look, input.palette, input.up, input.down, input.bid, input.ask, input.top, input.k, input.w, input.pw, input.ph, dpr,
      Math.round(input.xs[0]! * 8), Math.round(input.xs[input.w]! * 8), input.yOf(1e8), input.yOf(1e10), input.mid];
    const W = Math.max(1, Math.ceil(input.pw * dpr)), H = Math.max(1, Math.ceil(input.ph * dpr));
    if (!this.#canvas || this.#canvas.width !== W || this.#canvas.height !== H || key.length !== this.#key.length || key.some((v, i) => v !== this.#key[i])) {
      const t0 = performance.now();
      this.#canvas ??= layer(W, H);
      if (this.#canvas.width !== W) this.#canvas.width = W;
      if (this.#canvas.height !== H) this.#canvas.height = H;
      const c = layerContext(this.#canvas);
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, H); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintBands(c, input);
      this.#key = key; this.lastBuildMs = performance.now() - t0; this.builds++;
    }
    ctx.drawImage(this.#canvas, 0, 0, W / dpr, H / dpr);
  }
}

// ---------- the band under the pointer, lit (Karl, 2026-11-22: "hover over one level, highlighting that particular level ... and the
// neighboring levels with decreasing intensity"; worked out in the lab with the advisor) ----------

/** A band on one side of the price: 'up' the asks (or shorts) above the centre line, 'down' the bids (or longs) below it. */
export interface LitBand { side: 'up' | 'down'; j: number }
/** What the pick reads of the pane: its arrays, the centre line and the mapping from a value to a height. */
export type BandsAt = Pick<BandInput, 'k' | 'top' | 'bid' | 'ask' | 'mid' | 'yOf'>;
/**
 * The band under the pointer at column `col` and height `y` (plot px), or null over bare ground: the band nearest the price whose column
 * holds the point. The band lit before (`keep`) stays lit while the point is within `margin` px of its two edges, so a sweep along a ragged
 * edge does not flicker between two bands (in the lab: 30 changes along the noisiest line became 9).
 */
export function bandUnder(b: BandsAt, col: number, y: number, keep: LitBand | null, margin: number): LitBand | null {
  if (col < 0) return null;
  const height = (side: 'up' | 'down', j: number): number => j < 0 ? 0 : b.yOf((side === 'up' ? b.ask : b.bid)[col * b.k + j]!);
  if (keep && keep.j <= b.top) {
    const h = keep.side === 'up' ? b.mid - y : y - b.mid, outer = height(keep.side, keep.j), inner = height(keep.side, keep.j - 1);
    // Never across the price line: the innermost band on the side the pointer left lets go as soon as it crosses.
    if (outer - inner >= 0.5 && h >= Math.max(0, inner - margin) && h <= outer + margin) return keep;
  }
  const side = y < b.mid ? 'up' : 'down', h = side === 'up' ? b.mid - y : y - b.mid;
  for (let j = 0; j <= b.top; j++) { const v = height(side, j); if (v > 0 && h <= v) return { side, j }; }
  return null;
}
/** How much each band lights up: the band under the pointer fully, its neighbours 0.45 and 0.18, the same bands across the price at half. */
export function litWeights(top: number, lit: LitBand | null): { up: Float32Array; down: Float32Array } {
  const up = new Float32Array(top + 1), down = new Float32Array(top + 1), fall = [1, 0.45, 0.18];
  if (lit) for (let j = 0; j <= top; j++) { const w = fall[Math.abs(j - lit.j)] ?? 0; (lit.side === 'up' ? up : down)[j] = w; (lit.side === 'up' ? down : up)[j] = w * 0.5; }
  return { up, down };
}
/**
 * A lit band's tones: its fill a step toward the band inside it (60 % of the way, never past it, so the ramp keeps its order: checked for
 * every lit band in all 23 themes), the innermost a step away from the ground; its edge in a strong ink of its own hue, 3:1 against both
 * fills beside it, lit or not, where there is room (2.82:1 at worst, Terminal).
 */
function litTones(p: Palette, fills: readonly string[]): { tint: string[]; ink: string[] } {
  const dir = contourDir(p, fills), top = fills.length - 1;
  const tint = fills.map((f, j) => j > 0 ? mixHex(f, fills[j - 1]!, 0.6) : shiftL(f, dir * 0.07));
  const ink = fills.map((f, j) => contourInk(f, j === top ? p.bg : fills[j + 1]!, dir, [tint[j]!, j === top ? p.bg : tint[j + 1]!], 3));
  return { tint, ink };
}
type Run = { x0: number; x1: number; y: number };
type Ring = { x0: number; x1: number; yo: number; yi: number };
/**
 * A lit edge as rectangles, treads and risers, on whole device pixels (a stroked or filled stair-step path this long goes through the
 * canvas's slow path renderer on every frame, rectangles do not: 25-55 ms a lit frame became 7-9 in the lab): square corners, each tread
 * reaching over its riser's width and each riser standing between the treads, so a translucent line neither doubles at a corner nor shows a seam.
 */
function litEdge(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, runs: readonly Run[], lw: number, dpr: number): void {
  const L = Math.max(1, Math.round(lw * dpr)), w = L / dpr, back = Math.floor(L / 2) / dpr, Y = (y: number): number => Math.round(y * dpr) / dpr - back;
  for (let i = 0; i < runs.length; i++) {
    const a = runs[i]!, prev = i > 0 && runs[i - 1]!.x1 === a.x0, next = i + 1 < runs.length && runs[i + 1]!.x0 === a.x1, ya = Y(a.y);
    const xl = prev ? a.x0 - back : a.x0, xr = next ? a.x1 - back + w : a.x1;
    ctx.fillRect(xl, ya, xr - xl, w);
    if (next) { const yn = Y(runs[i + 1]!.y), lo = Math.min(ya, yn) + w, hi = Math.max(ya, yn); if (hi > lo) ctx.fillRect(a.x1 - back, lo, w, hi - lo); }
  }
}
/**
 * The band under the pointer lit over the drawn bands: each lit band's own strip toward its lit tone, then each edge it touches stronger and
 * wider by the larger light of the two bands it divides (to the power 1.5: a neighbour's edge at a third of the lit one's, the next left to its
 * plain contour), with a soft halo of its own ink on dark editor and paper frames, of the side's colour on pale ones (on a layer composited once at
 * low alpha, so overlapping pieces never add up); Classic and the text modes take the hard line alone. The runs are worked out once per answer.
 */
export class LitPainter {
  #key: unknown[] = [];
  #sides: { runs: Run[][]; rings: Ring[][]; tint: string[]; ink: string[]; side: string }[] = [];
  /** The overlay of the band lit last (tints, halo, edges), and of what (`#litKey`): rebuilt only when the band or the bands' drawing changes. */
  #overlay: Layer | null = null; #halo: Layer | null = null; #litKey = '';
  paint(ctx: CanvasRenderingContext2D, input: BandInput, lit: LitBand, dpr: number): void {
    const p = input.palette, key = [p, input.up, input.down, input.bid, input.ask, input.top, input.k, input.w, input.pw, input.ph,
      Math.round(input.xs[0]! * 8), Math.round(input.xs[input.w]! * 8), input.yOf(1e8), input.yOf(1e10), input.mid];
    const fresh = key.length !== this.#key.length || key.some((v, i) => v !== this.#key[i]);
    if (fresh) {
      this.#sides = heights(input).map(s => {
        const fills = fillsOf(p, s.ink, input.top), tones = litTones(p, fills), runs: Run[][] = [], rings: Ring[][] = [];
        for (let j = 0; j <= input.top; j++) {
          const r: Run[] = [], g: Ring[] = []; let cur: Run | null = null, ring: Ring | null = null;
          for (let x = 0; x < input.w; x++) {
            const h = s.hs[j]![x]!, hi = j > 0 ? s.hs[j - 1]![x]! : 0;
            if (!(h > 0)) { cur = null; ring = null; continue; }
            const y = input.mid + s.sign * h, x0 = input.xs[x]!, x1 = input.xs[x + 1]!;
            if (cur && cur.y === y && cur.x1 === x0) cur.x1 = x1; else { cur = { x0, x1, y }; r.push(cur); }
            if (h - hi < 0.01) { ring = null; continue; }
            const yi = input.mid + s.sign * hi;
            if (ring && ring.yo === y && ring.yi === yi && ring.x1 === x0) ring.x1 = x1; else { ring = { x0, x1, yo: y, yi }; g.push(ring); }
          }
          runs.push(r); rings.push(g);
        }
        return { runs, rings, ...tones, side: s.ink };
      });
      this.#key = key;
    }
    const W = Math.max(1, Math.ceil(input.pw * dpr)), H = Math.max(1, Math.ceil(input.ph * dpr)), litKey = `${lit.side}|${lit.j}|${W}|${H}|${dpr}`;
    if (fresh || litKey !== this.#litKey || !this.#overlay) {
      this.#overlay ??= layer(W, H);
      if (this.#overlay.width !== W) this.#overlay.width = W;
      if (this.#overlay.height !== H) this.#overlay.height = H;
      const o = layerContext(this.#overlay);
      o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, W, H); o.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A compact pane (its usual height) takes thinner lit lines and no halo: there a band is a few pixels, and the glow filled them. The lit edge
      // is at most half a pixel over the plain 1 px contour (Karl, 2026-11-24: 2.5 px read too thick), its halo 5 px at most and fainter.
      const compact = input.ph <= 160, soft = p.frame !== 'bevel' && p.frame !== 'textmode', glow = soft && !compact, weights = litWeights(input.top, lit);
      // The lit strips first, then the halo under the edges (drawn opaque on a layer of its own and laid on once at low alpha, so overlapping
      // pieces never add up), then the edges.
      this.#sides.forEach((s, i) => {
        const w = i === 0 ? weights.up : weights.down;
        for (let j = input.top; j >= 0; j--) if (w[j]! >= 0.1) {
          o.globalAlpha = Math.min(1, w[j]!); o.fillStyle = s.tint[j]!;
          for (const q of s.rings[j]!) o.fillRect(q.x0, Math.min(q.yo, q.yi), q.x1 - q.x0, Math.abs(q.yo - q.yi));
        }
        o.globalAlpha = 1;
      });
      if (glow) {
        this.#halo ??= layer(W, H);
        if (this.#halo.width !== W) this.#halo.width = W;
        if (this.#halo.height !== H) this.#halo.height = H;
        const halo = layerContext(this.#halo);
        halo.setTransform(1, 0, 0, 1, 0, 0); halo.clearRect(0, 0, W, H); halo.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.#sides.forEach((s, i) => {
          const w = i === 0 ? weights.up : weights.down;
          for (let j = input.top; j >= 0; j--) {
            const k = Math.min(1, Math.max(w[j]!, j < input.top ? w[j + 1]! : 0)) ** 1.5; if (k < 0.25) continue;
            halo.fillStyle = p.dark ? s.ink[j]! : s.side; litEdge(halo, s.runs[j]!, 1 + 4 * k, dpr);
          }
        });
        o.setTransform(1, 0, 0, 1, 0, 0); o.globalAlpha = p.dark ? 0.18 : 0.12; o.drawImage(this.#halo, 0, 0); o.globalAlpha = 1; o.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      this.#sides.forEach((s, i) => {
        const w = i === 0 ? weights.up : weights.down;
        for (let j = input.top; j >= 0; j--) {
          const k = Math.min(1, Math.max(w[j]!, j < input.top ? w[j + 1]! : 0)) ** 1.5; if (k < 0.05) continue;
          o.fillStyle = s.ink[j]!; o.globalAlpha = 0.25 + 0.75 * k; litEdge(o, s.runs[j]!, 1 + (glow ? 0.5 : 0.35) * k, dpr); o.globalAlpha = 1;
        }
      });
      this.#litKey = litKey;
    }
    ctx.drawImage(this.#overlay, 0, 0, W / dpr, H / dpr);
  }
}
