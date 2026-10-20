import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveField, type WaveRegion } from '../src/app/glass/waves.ts';

/**
 * The wave field run on the processor: a stand-in for WebGL2 that records what `WaveField` asks the card to do (each substep's Courant
 * number and pulses, the medium's regions) and does the same sums as its two shaders, so a test can step the real `WaveField.step` with the
 * frame times a browser gives it and watch whether the waves die down (Karl's iPad, 2026-10-19: in Safari they grew at every bounce until
 * the screen was white with them; on his Android phone they died down). One channel (the buys') is enough: the sells' runs the same sums.
 */
function cpuField(): { gl: WebGL2RenderingContext; energy: () => number; peak: () => number; courants: number[]; draws: () => number } {
  const consts = new Map<string, number>();
  const constant = (name: string): number => { if (!consts.has(name)) consts.set(name, consts.size + 1); return consts.get(name)!; };
  interface Program { src: string; uniforms: Map<string, number | number[]> }
  let current: Program | null = null, draws = 0;
  let cols = 0, rows = 0, speed2 = new Float32Array(0), damp = new Float32Array(0);
  let prev = new Float32Array(0), cur = new Float32Array(0), next = new Float32Array(0);
  const courants: number[] = [];
  const value = (v: unknown): number | number[] => typeof v === 'number' ? v : Array.from(v as ArrayLike<number>);
  const set = (loc: unknown, v: number | number[]): void => { current?.uniforms.set(loc as string, v); };
  const num = (name: string): number => current!.uniforms.get(name) as number;
  const arr = (name: string): number[] => current!.uniforms.get(name) as number[];
  const smoothstep = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // The medium shader: the speed squared and the damping of each cell, from the regions `setMedium` worked out.
  const medium = (): void => {
    const [cx, cy] = arr('cells') as [number, number], n = num('n'), region = arr('region'), kind = arr('kind'), glassC = num('glassC'), wallC = num('wallC');
    cols = cx; rows = cy; speed2 = new Float32Array(cols * rows); damp = new Float32Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const fx = x + 0.5, fy = y + 0.5; let speed = 1;
      for (let i = 0; i < n; i++) {
        const [rx, ry, rw, rh] = region.slice(i * 4, i * 4 + 4) as [number, number, number, number];
        if (fx >= rx && fx <= rx + rw && fy >= ry && fy <= ry + rh) speed = kind[i]! > 0.5 ? wallC : Math.min(speed, glassC);
      }
      const edge = Math.min(Math.min(fx, cols - fx), Math.min(fy, rows - fy));
      speed2[y * cols + x] = speed * speed; damp[y * cols + x] = 0.0009 + 0.18 * (1 - smoothstep(0, 7, edge));
    }
    if (prev.length !== cols * rows) { prev = new Float32Array(cols * rows); cur = new Float32Array(cols * rows); next = new Float32Array(cols * rows); }
  };
  // The step shader: leapfrog, the neighbours' pull scaled by the medium, the damping, the pulses, the clamp.
  const step = (): void => {
    const courant = num('courant'), n = num('n'), src = arr('src'), side = arr('side');
    courants.push(courant);
    const was = prev, now = cur, out = next, s2 = speed2, dm = damp, w = cols, r = rows;
    for (let y = 0; y < r; y++) {
      // The texture's edge repeats its last texel (CLAMP_TO_EDGE): the neighbour past the edge is the cell itself.
      const up = y + 1 < r ? w : 0, down = y > 0 ? -w : 0, row = y * w;
      for (let x = 0; x < w; x++) {
        const k = row + x, c = now[k]!;
        const lap = now[x + 1 < w ? k + 1 : k]! + now[x > 0 ? k - 1 : k]! + now[k + up]! + now[k + down]! - 4 * c;
        let h = (2 * c - was[k]! + courant * s2[k]! * lap) * (1 - dm[k]!);
        for (let i = 0; i < n; i++) {
          if (side[i]! >= 0.5) continue;
          const dx = x + 0.5 - src[i * 4]!, dy = y + 0.5 - src[i * 4 + 1]!, width = src[i * 4 + 3]!;
          h += src[i * 4 + 2]! * Math.exp(-(dx * dx + dy * dy) / (2 * width * width));
        }
        // Heights this small are nothing on the card (its half floats hold nothing under 6e-8), and on a processor they are subnormal
        // floats, a hundred times slower to add.
        out[k] = h > 4 ? 4 : h < -4 ? -4 : Math.abs(h) < 1e-12 ? 0 : h;
      }
    }
    prev = now; cur = out; next = was;
  };
  const calls: Record<string, (...a: unknown[]) => unknown> = {
    getExtension: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'), getUniformLocation: (_p, name) => name,
    createShader: () => ({ src: '' }), shaderSource: (s, src) => { (s as { src: string }).src = src as string; },
    createProgram: (): Program => ({ src: '', uniforms: new Map() }), attachShader: (p, s) => { (p as Program).src += (s as { src: string }).src; },
    useProgram: p => { current = p as Program; },
    uniform1f: (l, v) => set(l, value(v)), uniform1i: (l, v) => set(l, value(v)), uniform2f: (l, a, b) => set(l, [a as number, b as number]),
    uniform1fv: (l, v) => set(l, value(v)), uniform4fv: (l, v) => set(l, value(v)),
    // Every clear is of the heights (a new size, or the field gone still): the field starts again from still.
    clear: () => { prev.fill(0); cur.fill(0); next.fill(0); },
    drawArrays: () => { draws++; if (current?.src.includes('uniform float courant')) step(); else if (current?.src.includes('glassC')) medium(); },
  };
  const gl = new Proxy({}, {
    get: (_t, name) => typeof name !== 'string' ? undefined : /^[A-Z0-9_]+$/.test(name) ? constant(name) : calls[name] ?? (() => ({})),
  }) as unknown as WebGL2RenderingContext;
  const energy = (): number => { let e = 0; for (const h of cur) e += h * h; return e; };
  const peak = (): number => { let m = 0; for (const h of cur) m = Math.max(m, Math.abs(h)); return m; };
  return { gl, energy, peak, courants, draws: () => draws };
}

/** The Tape view's glass on a small screen (CSS px): the bid book's piece, the candle's and the ask book's, welded by walls. */
const W = 400, H = 300;
const TAPE: WaveRegion[] = [
  { x: 2, y: 20, w: 146, h: 260, kind: 'glass' }, { x: 148, y: 20, w: 6, h: 260, kind: 'wall' },
  { x: 154, y: 20, w: 94, h: 260, kind: 'glass' }, { x: 248, y: 20, w: 6, h: 260, kind: 'wall' },
  { x: 254, y: 20, w: 144, h: 260, kind: 'glass' },
];
/** How long each run lasts (ms): long enough for a wave to cross the screen and come back from its walls a few dozen times. */
const RUN_MS = 5_000;

/** A seeded generator, so a run with frames of mixed lengths is the same every time. */
function seeded(seed: number): () => number { let s = seed; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); }

/**
 * Each frame's time as each browser reads it (ms): Safari's clock reads whole milliseconds, Chrome's tenths. The Tape's loop draws a
 * 120 Hz display's frame when orders came and every other one otherwise, hence the frames of mixed lengths.
 */
const CLOCKS: Record<string, () => () => number> = {
  'Safari, 60 Hz': () => { let t = 1000.3; return () => Math.floor(t += 1000 / 60); },
  'Safari, 120 Hz': () => { let t = 1000.3; return () => Math.floor(t += 1000 / 120); },
  'Safari, 120 Hz drawn when orders came': () => { let t = 1000.3; const r = seeded(7); return () => Math.floor(t += r() < 0.5 ? 1000 / 120 : 1000 / 60); },
  'Chrome, 60 Hz': () => { let t = 1000.3; return () => Math.floor((t += 1000 / 60) * 10) / 10; },
};

/** One large buy near the bid book's weld, then `ms` of frames: the sum of the squared heights half a second in and at the end. */
function run(clock: () => number, ms: number): { early: number; late: number; peak: number; courants: number[] } {
  const cpu = cpuField(), field = WaveField.create(cpu.gl)!;
  field.resize(W, H); field.setMedium(TAPE);
  let now = clock();
  const start = now;
  field.add({ x: 120, y: 150, amp: 1.2, width: 10, side: 0 }, now);
  let early = 0, peak = 0, keep = now, look = start + 500;
  for (; now - start < ms; now = clock()) {
    // The tape's orders keep the field running (it stops RING_MS after the last pulse); these add nothing to it.
    if (now - keep > 1_000) { field.add({ x: 120, y: 150, amp: 0, width: 10, side: 0 }, now); keep = now; }
    field.step(now);
    if (now >= look) { if (!early) early = cpu.energy(); peak = Math.max(peak, cpu.peak()); look += 100; }
  }
  return { early, late: cpu.energy(), peak, courants: cpu.courants };
}

test('the waves die down under every browser\'s clock: Safari\'s whole milliseconds at 60 and 120 Hz as Chrome\'s tenths', t => {
  const runs = Object.entries(CLOCKS).map(([name, make]) => ({ name, ...run(make(), RUN_MS) }));
  const at = `${RUN_MS / 1000} s`;
  for (const { name, early, late, peak } of runs) t.diagnostic(`${name}: sum of squared heights ${early.toFixed(2)} at 0.5 s, ${late.toFixed(2)} at ${at}; highest after 0.5 s ${peak.toFixed(2)}`);
  for (const { name, early, late, peak } of runs) {
    assert.ok(late < early / 2, `${name}: the waves die down (${early.toFixed(2)} at 0.5 s, ${late.toFixed(2)} at ${at})`);
    assert.ok(peak < 4, `${name}: and never reach the field's cap (${peak.toFixed(2)})`);
  }
});

test('every substep is as long as the one before, however the frames come', () => {
  const { courants } = run(CLOCKS['Safari, 120 Hz drawn when orders came']!(), 1_000);
  assert.ok(courants.length > 100, 'it stepped');
  assert.equal(new Set(courants).size, 1, `one Courant number for every substep (${[...new Set(courants)].map(c => c.toFixed(4)).join(', ')})`);
});

test('a frame with no time in it steps nothing, nor does a clock that went back; a pulse then waits for the next substep', () => {
  const cpu = cpuField(), field = WaveField.create(cpu.gl)!;
  field.resize(W, H); field.setMedium(TAPE);
  field.add({ x: 120, y: 150, amp: 1, width: 10, side: 0 }, 1_000);
  field.step(1_000); field.step(1_016.7);
  const before = cpu.draws();
  field.step(1_016.7); field.step(1_010);
  assert.equal(cpu.draws(), before, 'a second draw in the same millisecond, and a clock that went back, step nothing');
  field.add({ x: 200, y: 150, amp: 1, width: 10, side: 0 }, 1_010);
  const e = cpu.energy(); field.step(1_010.5);
  assert.equal(cpu.energy(), e, 'half a millisecond is no substep: the pulse is not in yet');
  field.step(1_027); assert.ok(cpu.energy() > e, 'and goes in with the next one');
});
