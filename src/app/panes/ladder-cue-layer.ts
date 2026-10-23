import type { Palette } from '../theme.ts';
import type { LevelsFrame } from '../wire.ts';
import { scaledUsd } from '../coin.ts';
import type { TapeRing } from '../tape/ring.ts';
import { BookCueTracker, rowEvents, type CueEvent } from './book-cues.ts';
import { CellMap, CueBoard, MAX_PENDING, contactRows, maxAreaFor, shedEvents, type CueLook, type Geometry } from './ladder-cues.ts';
import { cueBox, cueShows, markBox, paintCue, paintMark, type Box } from './ladder-cue-paint.ts';
import { SENSE_SCALE_USD, type CueLookSetting, type Sense } from './ladder-cue-settings.ts';

/**
 * Everything between the tracker's findings and the pixels: the changes of the last data frames waiting for a draw, the board that decides who
 * gets light, where each venue's cell was drawn, and the repainting of the lit cells over the resting material.
 *
 * The pane draws the material and the ink as it always did and then calls `end()`. If anything is lit, or a change is waiting, the material
 * canvas is copied once (the resting book, `#base`) and the cues are laid over it; from then on a frame is made by restoring the cells the
 * last frame lit from that copy and laying the cues again, so a frame costs the lit cells and nothing else (study 2026-10-22: 0.3 ms for 50
 * cells against the 1.4 to 6.7 ms of drawing the book again). When nothing is lit nothing is scheduled: an idle book draws no frame.
 *
 * A pane that is hidden, covered, in replay or switched off keeps nothing lit and takes no backlog of changes: what happened while it was
 * away is not played back (the tracker goes on observing, so its history stays whole).
 */

/** The least the tracker takes as a change at all (BTC-sized, scaled by `scaledUsd`); the size at which a change is as strong as it gets is the sensitivity's (`SENSE_SCALE_USD`). */
export const CUE_FLOOR_USD = 10_000;
/** The least a market order must be (BTC-sized USD, scaled to the coin) to make a ripple, and the size that lights one fully. */
export const CONTACT_MIN_USD = 25_000, CONTACT_SCALE_USD = 500_000;
/** An order older than this when it is read is history, not contact (the ring can be filled late). */
const CONTACT_MAX_AGE_MS = 4_000;
/** How often the marks are redrawn while nothing is lit (they fade slowly), and, in reduced motion, how often the board is looked at to take them away. */
const MARK_REFRESH_MS = 100, STILL_REFRESH_MS = 600;

/** What the pane gives the layer: the material canvas it paints on, and what it knows of the page. */
export interface CueHost {
  readonly mat: CanvasRenderingContext2D;
  readonly canvas: HTMLCanvasElement;
  dpr(): number;
  palette(): Palette;
  /** Whether the book is on screen and live: the page is visible, the pane is shown and not covered, and no replay runs. */
  shown(): boolean;
  /** The part of the canvas (CSS px, from its left edge) that is in view: Single mode's books are side by side and the scroller shows some of them. */
  view(): { x0: number; x1: number };
}

/** The layout of the last draw that the layer needs: the absolute row index of the first row, the rows, where they start (CSS px) and how tall they are, the step, and whether each book has its own gutter. */
export interface CueLayout { top: number; rows: number; head: number; rowH: number; step: number; perVenue: boolean }

export class CueLayer {
  readonly tracker = new BookCueTracker();
  readonly board = new CueBoard();
  readonly cells = new CellMap();
  #events: CueEvent[] = [];
  #base = document.createElement('canvas');
  #baseCtx = this.#base.getContext('2d')!;
  /** The boxes (CSS px) the last frame painted on: restored from `#base` before the next. */
  #dirty: Box[] = [];
  #gutters: { id: string | null; x: number; w: number }[] = [];
  #layout: CueLayout = { top: 0, rows: 0, head: 0, rowH: 17, step: 0, perVenue: false };
  #raf = 0; #timer = 0;
  #look: CueLookSetting = 'wash';
  #sense: Sense = 'normal';
  #reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Whether `#base` holds the resting material of the canvas as it is now. */
  #baseValid = false;
  /** The write number of the next record of the trade tape to read (-1: not started: what the tape held before is not played back). */
  #seen = -1;

  constructor(private readonly host: CueHost) {
    if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', e => { this.#reduced = e.matches; if (e.matches) this.#stillLook(); else this.#schedule(); });
  }

  /** The look in force: reduced motion keeps only the signed marks (they hold still), whatever was chosen. */
  get look(): CueLook | 'off' { return this.#look === 'off' ? 'off' : this.#reduced ? 'marks' : this.#look; }
  setLook(look: CueLookSetting): void {
    if (look === this.#look) return;
    this.#look = look;
    // The pane draws again after a change of setting: Off takes everything away, Signs only the light (the marks stay).
    if (look === 'off') this.clear(); else if (look === 'marks') this.board.dim();
  }
  /** The look became still while cues were lit (reduced motion): the cells they lit are put back and only the marks are painted. */
  #stillLook(): void {
    this.board.dim();
    if (this.#baseValid) { this.#erase(); this.#paint(performance.now()); }
    this.#schedule();
  }
  setSense(sense: Sense): void { this.#sense = sense; }
  /** What a change must be to be at full strength, for the coin on screen and the sensitivity chosen. */
  get scale(): number { return scaledUsd(SENSE_SCALE_USD[this.#sense]); }
  /** Whether a gutter for the signed marks is drawn beside the bars. */
  get gutter(): boolean { return this.#look !== 'off'; }

  /** A levels frame: let the tracker see the books, and keep what it found for the next draw (when the book is live and a look is asked for). */
  feed(frame: LevelsFrame | null, ids: readonly string[], heat: boolean): void {
    if (!frame || (this.#look === 'off' && !heat)) { this.reset(); return; }
    const events = this.tracker.observe(frame.books, ids, { wall: Date.now(), scale: this.scale, floorUsd: scaledUsd(CUE_FLOOR_USD) });
    // Hidden, covered or in replay: what waited for a draw goes too (it would play, after what happened while away, as if it were new) and nothing is added;
    // the tracker goes on, its history is what the heat strip reads.
    if (this.#look === 'off' || !this.host.shown()) { this.#events.length = 0; return; }
    this.#events.push(...events);
    shedEvents(this.#events, MAX_PENDING);
  }

  /** Forget everything: a reconnect, a venue that went, a replay, another coin. */
  reset(): void { this.tracker.reset(); this.clear(); }
  /** Nothing lit and nothing waiting (the tracker keeps its history): the cells that were lit are put back as the draw left them. */
  clear(): void { this.#erase(); this.#drop(); }
  /** The pane is about to draw (or is hidden, or covered): what was lit and waits is let go, with nothing done to the canvas. */
  #drop(): void {
    if (this.#raf) { cancelAnimationFrame(this.#raf); this.#raf = 0; }
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = 0; }
    this.board.clear(); this.#events.length = 0; this.#dirty.length = 0; this.#baseValid = false;
  }
  /** Put back what the last frame painted (when its resting copy is the canvas's own size). */
  #erase(): void {
    const c = this.host.canvas;
    if (!this.#baseValid || this.#base.width !== c.width || this.#base.height !== c.height) return;
    for (const box of this.#dirty) this.#restore(box);
    this.#dirty.length = 0;
  }

  /**
   * A draw begins: where its rows are. The rows are indices at the step, so another step (a zoom) or another way of keeping the marks makes every
   * cue and mark that was kept the cue of another price: they go, and the changes the tracker found wait for the rows they are in now.
   */
  begin(layout: CueLayout): void {
    const L = this.#layout;
    if (layout.step !== L.step || layout.perVenue !== L.perVenue) {
      if (this.#raf) { cancelAnimationFrame(this.#raf); this.#raf = 0; }
      if (this.#timer) { clearTimeout(this.#timer); this.#timer = 0; }
      this.board.clear(); this.#dirty.length = 0; this.#baseValid = false;
    }
    this.#layout = layout; this.cells.begin(layout.top, layout.rows); this.#gutters.length = 0;
    this.#syncCap();
  }
  /** The area cap for the ladder as it is on screen (a share of it: a phone's book is small): set at every draw, before anything idles, and before a contact is admitted. */
  #syncCap(): void { const L = this.#layout, v = this.host.view(); this.board.setMaxArea(maxAreaFor(v.x1 - v.x0, L.head + L.rows * L.rowH)); }
  /** A book's gutter (the column of signed marks before its bars) at `x`; `id` is its venue in Single mode, null for the one shared gutter. */
  addGutter(id: string | null, x: number, w: number): void { this.#gutters.push({ id, x, w }); }

  /** The draw is done (material and ink): take the resting copy if anything is to be lit, give the waiting changes light, and paint. */
  end(): void {
    if (this.#look === 'off' || !this.host.shown()) { this.#dirty.length = 0; this.#baseValid = false; return; }
    const hasWork = this.#events.length > 0 || this.board.active.length > 0 || this.board.marks.size > 0;
    if (!hasWork) { this.#dirty.length = 0; this.#baseValid = false; return; }
    if (!this.#snapshot()) { this.#dirty.length = 0; this.#baseValid = false; return; }
    const now = performance.now(), look = this.look === 'off' ? 'marks' : this.look;
    // The cells were laid out again: what is lit is charged for the cells it lights now.
    const geo = this.#geometry();
    this.#syncCap();
    this.board.prune(now); this.board.reprice(now, look, geo);
    if (this.#events.length) {
      // Only the rows on screen: a band as wide as the book would make hundreds of rows nobody sees and push the ones that are seen out of the queue.
      const L = this.#layout, window = { lo: (L.top - L.rows + 1) * L.step, hi: (L.top + 1) * L.step };
      this.board.push(rowEvents(this.#events, L.step, this.scale, window)); this.#events.length = 0;
    }
    this.board.admit(now, look, geo, this.#layout.perVenue);
    this.#paint(now);
    this.#schedule();
  }

  /** The cells of the last draw that are in view: a book scrolled out of the scroller lights nothing and takes no place or area from the ones that show. */
  #geometry(): Geometry {
    const v = this.host.view();
    return { rowVisible: row => this.cells.rowVisible(row), cell: (id, side, row) => { const c = this.cells.cell(id, side, row); return c && c.x + c.w > v.x0 && c.x < v.x1 ? c : null; } };
  }

  /** The material canvas as it is now becomes the resting copy the lit cells are restored from. False when there is nothing to copy. */
  #snapshot(): boolean {
    const canvas = this.host.canvas;
    if (!(canvas.width > 0 && canvas.height > 0)) return false;
    if (this.#base.width !== canvas.width || this.#base.height !== canvas.height) { this.#base.width = canvas.width; this.#base.height = canvas.height; }
    const b = this.#baseCtx; b.setTransform(1, 0, 0, 1, 0, 0); b.clearRect(0, 0, canvas.width, canvas.height); b.drawImage(canvas, 0, 0);
    this.#baseValid = true; this.#dirty.length = 0;
    return true;
  }

  /**
   * The market orders the tape took since the last call: the large ones, as contacts with the side they took from (a buyer takes the asks) over the
   * rows they reached from the touch outward. Returns how many contacts that made. The tape's past is never played back: the first call only marks
   * where it stands.
   */
  readContacts(ring: TapeRing | null, ids: ReadonlySet<string>): number {
    if (!ring) { this.#seen = -1; return 0; }
    const step = this.#layout.step;
    if (this.#seen < 0 || this.#seen > ring.written) { this.#seen = ring.written; return 0; }
    if (!(step > 0)) return 0;
    const from = Math.max(this.#seen, ring.first), to = ring.written;
    this.#seen = to;
    const rows = contactRows(ring, from, to, { step, floor: scaledUsd(CONTACT_MIN_USD), scale: scaledUsd(CONTACT_SCALE_USD), now: Date.now(), ids, maxAgeMs: CONTACT_MAX_AGE_MS });
    if (rows.length && this.#look !== 'off' && this.host.shown()) this.board.pushContacts(rows);
    return rows.length;
  }

  /** Orders were read: light their contacts now, over the book as it was last drawn, without drawing the book again. */
  lightNow(): void {
    if (this.#look === 'off' || !this.host.shown() || !this.board.waiting) return;
    if (!this.#baseValid && !this.#snapshot()) return;
    const now = performance.now(), look = this.look === 'off' ? 'marks' : this.look, geo = this.#geometry();
    this.#syncCap();
    // What the book scrolled out of view lit gives its places back before a contact asks for one (nothing redraws the book on a scroll).
    this.board.prune(now); this.board.reprice(now, look, geo);
    this.board.admit(now, look, geo, this.#layout.perVenue);
    this.#paint(now);
    this.#schedule();
  }

  /** The trade tape was replaced (another coin) or is not being read (the pane is away, or the contacts are off): start reading it again from where it stands. */
  forgetTape(): void { this.#seen = -1; }

  /** What is lit stops: the pane is hidden or covered, or its draw says something else than the book (the canvases were just cleared: nothing is put back). */
  stop(): void { this.#drop(); }

  #restore(box: Box): void {
    const d = this.host.dpr(), c = this.host.canvas;
    const x0 = Math.max(0, Math.floor(box.x * d)), y0 = Math.max(0, Math.floor(box.y * d)), x1 = Math.min(c.width, Math.ceil((box.x + box.w) * d)), y1 = Math.min(c.height, Math.ceil((box.y + box.h) * d));
    if (x1 <= x0 || y1 <= y0) return;
    const m = this.host.mat; m.save(); m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(x0, y0, x1 - x0, y1 - y0); m.drawImage(this.#base, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    m.restore();
  }

  #paint(now: number): void {
    const c = this.host.canvas;
    if (!this.#baseValid || this.#base.width !== c.width || this.#base.height !== c.height) { this.#dirty.length = 0; return; }
    const m = this.host.mat, p = this.host.palette(), look = this.look === 'off' ? 'marks' : this.look, L = this.#layout, still = this.#reduced;
    for (const box of this.#dirty) this.#restore(box);
    this.#dirty.length = 0;
    const v = this.host.view(), inView = (x: number, w: number): boolean => x + w > v.x0 && x < v.x1;
    for (const cue of this.board.active) {
      const age = now - cue.t0;
      if (!cueShows(look, cue, age)) continue;
      const cell = this.cells.cell(cue.id, cue.side, cue.row); if (!cell || !inView(cell.x, cell.w)) continue;
      this.#dirty.push(cueBox(cell)); paintCue(m, look, cue, cell, age, p);
    }
    for (const mark of this.board.marks.values()) {
      const r = L.top - mark.row; if (r < 0 || r >= L.rows) continue;
      const g = L.perVenue ? this.#gutters.find(x => x.id === mark.id) : this.#gutters[0]; if (!g || !inView(g.x, g.w)) continue;
      const box = markBox(g.x, L.head + r * L.rowH, g.w, L.rowH);
      this.#dirty.push(box); paintMark(m, mark, box, now - mark.t0, p, still);
    }
  }

  #schedule(): void {
    const lit = this.board.active.length > 0, marks = this.board.marks.size > 0;
    if (!lit && !marks) return;
    if (this.#reduced) { if (!this.#timer) this.#timer = window.setTimeout(this.#slow, STILL_REFRESH_MS); return; }
    // A cue lit while only marks were fading takes the next animation frame, not the marks' slower turn.
    if (lit) { if (this.#timer) { clearTimeout(this.#timer); this.#timer = 0; } if (!this.#raf) this.#raf = requestAnimationFrame(this.#fast); }
    else if (!this.#raf && !this.#timer) this.#timer = window.setTimeout(this.#slow, MARK_REFRESH_MS);
  }
  #fast = (): void => { this.#raf = 0; this.#frame(); };
  #slow = (): void => { this.#timer = 0; this.#frame(); };
  #frame(): void {
    if (!this.host.shown() || this.#look === 'off') { this.clear(); return; }
    const now = performance.now();
    this.board.prune(now); this.board.reprice(now, this.look === 'off' ? 'marks' : this.look, this.#geometry());
    this.#paint(now);
    this.#schedule();
  }
}
