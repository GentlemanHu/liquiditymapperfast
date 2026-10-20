/**
 * A field of waves on the card (Karl, 2026-10-17): every large order drops a pulse where it shows, and it runs out across the screen as a
 * real wave, bending where it enters glass (slower there), partly thrown back and partly let through by the splitters and the edges of the
 * panes, and soaked up by the screen's own edges so nothing rings for ever. Buys and sells are two fields in one texture (red and green
 * channels), so their crests keep their colours and pass through each other.
 *
 * The field is the 2D wave equation on a grid a quarter of the screen across (`CELL` CSS px a cell), stepped with leapfrog in substeps of
 * one fixed length (`SUBSTEP_MS`, as many a frame as its time holds), in half-float textures. A pulse's height grows with the square
 * root of the order's size and its width with the size's logarithm, so a larger order makes a taller wave and a longer one, as a larger
 * stone does. It runs only while a pulse is still in it (a few seconds after the last), and needs a card that can draw into half floats;
 * `WaveField.create` says null where it cannot, and the glass keeps its older light then.
 *
 * One class, one instance per WebGL context: the page's glass (glass/ui-glass.ts) and the Tape view's (candle/trail-gl.ts) each have their
 * own; a texture cannot be shared across contexts.
 */

/** CSS px a cell of the field. */
export const CELL = 4;
/** The wave's speed over open screen (CSS px a second); glass is slower by its index. */
export const WAVE_SPEED = 900;
/** The index of the chrome's glass: a wave is this many times slower inside it, and bends where it crosses into it. */
export const GLASS_INDEX = 1.5;
/** A wall's speed against the open screen's (a splitter, a pane's edge): low enough to throw back part of a wave, so it echoes faintly, not as a grid. */
export const WALL_SPEED = 0.55;
/** How long the field runs after its last pulse (ms): by then the edges and the damping have taken it. */
export const RING_MS = 3_200;
const MAX_SOURCES = 16;

/** One pulse into the field: where (CSS px), how tall (about 1 for a large order), how wide (CSS px), and whose (0 buy, 1 sell). */
export interface WaveSource { x: number; y: number; amp: number; width: number; side: 0 | 1 }
/** A region of the field's medium (CSS px): glass slows a wave, a wall mostly throws it back. */
export interface WaveRegion { x: number; y: number; w: number; h: number; kind: 'glass' | 'wall' }

/**
 * The one length of a substep (ms): four to a 120 Hz frame, eight to a 60 Hz one, as a 120 Hz phone already stepped it; a Courant number
 * of 0.47 at the open screen's speed, well inside the 0.71 that leapfrog allows in 2D.
 *
 * Every substep must be as long as the one before (Karl's iPad, 2026-10-19). Leapfrog keeps a wave's speed only as how far it moved in the
 * last substep, so a substep of another length rescales every speed in the field. The length used to be each frame's time over as many
 * substeps as it needed, and Safari's clock reads whole milliseconds: a 60 Hz frame read 16 ms, then 17, 17, 16 (six substeps of 2.67 ms,
 * then seven of 2.43), a 120 Hz one 8, then 9 (three, then four). Rescaled back and forth in a pattern that repeats, the waves were pumped
 * as a swing is, faster than the damping takes them, until the page was white with them. Chrome's clock reads tenths, so every frame
 * there came to the same substeps, and its waves died down.
 */
export const SUBSTEP_MS = 1000 / 480;
/** The step shader's `courant`: the open screen's Courant number squared, the same for every substep. */
const COURANT = (WAVE_SPEED / CELL / 1000 * SUBSTEP_MS) ** 2;
/** The most a frame steps (ms): after a stall the field goes on from where it was rather than running the whole stall at once. */
const MAX_FRAME_MS = 50;

/** A pulse for an order of `usd` against the size that starts one (`min`): height with the square root, width with the logarithm. */
export function pulseFor(usd: number, min: number): { amp: number; width: number } {
  const r = Math.max(1, Math.abs(usd) / min);
  return { amp: Math.min(1.6, 0.35 * Math.sqrt(r)), width: 4 + 3 * Math.log10(r) };
}

const VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// One substep: the next height from this one and the last (leapfrog), the neighbours' pull scaled by the medium's speed there, damped a
// little everywhere and much at the screen's edges; on a frame's first substep, the new pulses.
const STEP = `#version 300 es
precision highp float;
uniform sampler2D cur, prev, medium; uniform vec2 texel; uniform float courant;
uniform int n; uniform vec4 src[${MAX_SOURCES}]; uniform float side[${MAX_SOURCES}];
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 c = texture(cur, uv), p = texture(prev, uv), m = texture(medium, uv);
  vec4 lap = texture(cur, uv + vec2(texel.x, 0.0)) + texture(cur, uv - vec2(texel.x, 0.0)) + texture(cur, uv + vec2(0.0, texel.y)) + texture(cur, uv - vec2(0.0, texel.y)) - 4.0 * c;
  vec4 next = (2.0 * c - p + courant * m.r * lap) * (1.0 - m.g);
  for (int i = 0; i < ${MAX_SOURCES}; i++) {
    if (i >= n) break;
    vec2 d = gl_FragCoord.xy - src[i].xy; float b = src[i].z * exp(-dot(d, d) / (2.0 * src[i].w * src[i].w));
    if (side[i] < 0.5) next.r += b; else next.g += b;
  }
  o = vec4(clamp(next.rg, -4.0, 4.0), 0.0, 1.0);
}`;

// The medium: the speed squared (against the open screen's) in red, the damping in green.
const MEDIUM = `#version 300 es
precision highp float;
uniform vec4 region[24]; uniform float kind[24]; uniform int n; uniform vec2 cells; uniform float glassC, wallC;
out vec4 o;
void main() {
  vec2 c = gl_FragCoord.xy; float speed = 1.0;
  for (int i = 0; i < 24; i++) {
    if (i >= n) break;
    vec4 r = region[i];
    if (c.x >= r.x && c.x <= r.x + r.z && c.y >= r.y && c.y <= r.y + r.w) speed = kind[i] > 0.5 ? wallC : min(speed, glassC);
  }
  // The edges soak a wave up over a few cells, so it does not come back from them.
  float edge = min(min(c.x, cells.x - c.x), min(c.y, cells.y - c.y));
  float damp = 0.0009 + 0.18 * (1.0 - smoothstep(0.0, 7.0, edge));
  o = vec4(speed * speed, damp, 0.0, 1.0);
}`;

export class WaveField {
  readonly gl: WebGL2RenderingContext;
  #step: WebGLProgram; #medium: WebGLProgram;
  #loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  #tex: WebGLTexture[] = []; #fbo: WebGLFramebuffer[] = [];
  #mediumTex: WebGLTexture; #mediumFbo: WebGLFramebuffer;
  #cols = 1; #rows = 1; #cssH = 1;
  /** Which of the three textures is the last, this and the next step (leapfrog keeps two and writes the third). */
  #i = 0;
  #pending: WaveSource[] = [];
  #lastSource = -Infinity;
  #last = 0;
  /** How far the field's time is behind the clock (ms, within half a substep either way): carried to the next frame, never dropped. */
  #carry = 0;
  /** Whether the field has been set back to still since its waves ran out (so nothing stays frozen in it). */
  #still = true;

  /** A field in `gl`, or null where the card cannot draw into half floats (the caller keeps its older light). */
  static create(gl: WebGL2RenderingContext): WaveField | null {
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
    try { return new WaveField(gl); } catch { return null; }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.#step = this.#program(STEP, ['cur', 'prev', 'medium', 'texel', 'courant', 'n', 'src', 'side']);
    this.#medium = this.#program(MEDIUM, ['region', 'kind', 'n', 'cells', 'glassC', 'wallC']);
    for (let i = 0; i < 3; i++) { this.#tex.push(this.#texture()); this.#fbo.push(gl.createFramebuffer()!); }
    this.#mediumTex = this.#texture(); this.#mediumFbo = gl.createFramebuffer()!;
    this.resize(4, 4);
    // A card that lists the extension but cannot draw into the texture after all: no field.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo[0]!);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('half floats are not drawable here');
  }

  /** The field's grid: `cols` by `rows` cells, each `CELL` CSS px. */
  get cols(): number { return this.#cols; }
  get rows(): number { return this.#rows; }
  /** The texture of the heights now (red buy, green sell), linear filtered: sample it at (CSS px / CELL) / (cols, rows), y up. */
  get texture(): WebGLTexture { return this.#tex[(this.#i + 1) % 3]!; }
  /** The heights a substep before (`waveFront` reads the two: a front is where the height still rises; the wake a 2D wave leaves is not). */
  get previous(): WebGLTexture { return this.#tex[this.#i]!; }
  /**
   * Whether a pulse is still in the field (the caller keeps drawing while it is): for RING_MS after the last was added, whether it has been
   * stepped in or not. A pulse still waiting then is dropped at the next step: a caller that stopped stepping (its glass switched off) must
   * not be kept drawing by it for ever, nor have it burst out when it steps again.
   */
  alive(now: number): boolean { return now - this.#lastSource < RING_MS; }

  /** Size the field for a screen `cssW` by `cssH` CSS px; its waves start again from still. */
  resize(cssW: number, cssH: number): void {
    const cols = Math.max(4, Math.ceil(cssW / CELL)), rows = Math.max(4, Math.ceil(cssH / CELL));
    this.#cssH = cssH;
    if (cols === this.#cols && rows === this.#rows) return;
    this.#cols = cols; this.#rows = rows;
    const gl = this.gl;
    for (const [i, t] of [...this.#tex, this.#mediumTex].entries()) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, cols, rows, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const fbo = i < 3 ? this.#fbo[i]! : this.#mediumFbo;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.setMedium([]);
  }

  /** What the waves cross (CSS px, top-down): glass that slows them, walls that throw most of them back. */
  setMedium(regions: readonly WaveRegion[]): void {
    const gl = this.gl, l = this.#loc.get(this.#medium)!, n = Math.min(24, regions.length);
    const r = new Float32Array(24 * 4), k = new Float32Array(24);
    regions.slice(0, 24).forEach((q, i) => {
      // Cells count bottom-up, as the card's rows do.
      r.set([q.x / CELL, (this.#cssH - q.y - q.h) / CELL, q.w / CELL, q.h / CELL], i * 4); k[i] = q.kind === 'wall' ? 1 : 0;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#mediumFbo); gl.viewport(0, 0, this.#cols, this.#rows);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.#medium);
    gl.uniform4fv(l.get('region')!, r); gl.uniform1fv(l.get('kind')!, k); gl.uniform1i(l.get('n')!, n);
    gl.uniform2f(l.get('cells')!, this.#cols, this.#rows); gl.uniform1f(l.get('glassC')!, 1 / GLASS_INDEX); gl.uniform1f(l.get('wallC')!, WALL_SPEED);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** A pulse, added on the next step. */
  add(s: WaveSource, now: number): void {
    this.#pending.push(s);
    if (this.#pending.length > MAX_SOURCES) this.#pending.splice(0, this.#pending.length - MAX_SOURCES);
    this.#lastSource = now; this.#still = false;
  }

  /** Step the field to `now` (ms). Leaves the default framebuffer bound and blending off; the caller sets its own viewport after. */
  step(now: number): void {
    const gl = this.gl, l = this.#loc.get(this.#step)!;
    // A still field keeps no time: the first frame of the next pulse steps one frame's time, not the whole idle spell (50 ms, 24 substeps).
    if (!this.alive(now)) { this.#pending.length = 0; this.#last = 0; this.#carry = 0; if (!this.#still) this.#clear(); return; }
    // Whole substeps of the one length, to the nearest, and what is left over (either way) goes into the next frame: so frames of 16 and
    // 17 ms are eight substeps each, a second draw in the same millisecond steps none, and a clock that went back (a page woken from the
    // background) steps none either. A pulse waiting for a frame that steps none goes in with the next substep.
    const dt = this.#last ? Math.min(MAX_FRAME_MS, Math.max(0, now - this.#last)) : 16.7; this.#last = now;
    const due = this.#carry + dt, steps = Math.max(0, Math.round(due / SUBSTEP_MS));
    this.#carry = due - steps * SUBSTEP_MS;
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.#cols, this.#rows);
    gl.useProgram(this.#step);
    gl.uniform2f(l.get('texel')!, 1 / this.#cols, 1 / this.#rows); gl.uniform1f(l.get('courant')!, COURANT);
    gl.uniform1i(l.get('cur')!, 0); gl.uniform1i(l.get('prev')!, 1); gl.uniform1i(l.get('medium')!, 2);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.#mediumTex);
    for (let k = 0; k < steps; k++) {
      const prev = this.#i, cur = (this.#i + 1) % 3, next = (this.#i + 2) % 3;
      const src = k === 0 ? this.#pending.splice(0) : [];
      const s = new Float32Array(MAX_SOURCES * 4), side = new Float32Array(MAX_SOURCES);
      src.forEach((q, i) => { s.set([q.x / CELL, (this.#cssH - q.y) / CELL, q.amp, Math.max(0.8, q.width / CELL)], i * 4); side[i] = q.side; });
      gl.uniform1i(l.get('n')!, src.length); gl.uniform4fv(l.get('src')!, s); gl.uniform1fv(l.get('side')!, side);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#tex[cur]!);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#tex[prev]!);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo[next]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.#i = cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Every height back to zero: the waves have run out, and what little is left must not stay on the screen. Its clock starts again too. */
  #clear(): void {
    const gl = this.gl;
    for (const fbo of this.#fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#still = true; this.#last = 0; this.#carry = 0;
  }

  #texture(): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  #program(frag: string, names: string[]): WebGLProgram {
    const gl = this.gl;
    const shader = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, frag)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '');
    this.#loc.set(p, new Map(names.map(n => [n, gl.getUniformLocation(p, n)])));
    return p;
  }
}

/**
 * The GLSL a renderer adds to read the field: `waveAt(cssPx)` the two heights there (buy, sell), `waveFront(cssPx)` how fast they rise
 * there (the moving fronts, bright; the slow wake a 2D wave leaves behind them, dark), and `waveSlope(cssPx)` their summed slope, from the
 * textures bound to `waves` and `wavesPrev` with the grid's size in `waveCells` (CSS px are top-down; the field's rows bottom-up).
 */
export const WAVE_GLSL = `
uniform sampler2D waves, wavesPrev; uniform vec2 waveCells; uniform float waveCssH; uniform bool hasWaves;
vec2 waveUv(vec2 p) { return vec2(p.x, waveCssH - p.y) / ${CELL}.0 / waveCells; }
vec2 waveAt(vec2 p) { if (!hasWaves) return vec2(0.0); return texture(waves, waveUv(p)).rg; }
vec2 waveFront(vec2 p) { if (!hasWaves) return vec2(0.0); vec2 uv = waveUv(p); return max(texture(waves, uv).rg - texture(wavesPrev, uv).rg, vec2(0.0)) * 3.0; }
vec2 waveSlope(vec2 p) {
  if (!hasWaves) return vec2(0.0);
  vec2 a = waveAt(p + vec2(${CELL}.0, 0.0)) - waveAt(p - vec2(${CELL}.0, 0.0)), b = waveAt(p + vec2(0.0, ${CELL}.0)) - waveAt(p - vec2(0.0, ${CELL}.0));
  return vec2(a.r + a.g, b.r + b.g) * 0.5;
}`;
