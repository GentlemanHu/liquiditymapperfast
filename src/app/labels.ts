/** A rectangle on the plot, in CSS pixels. */
export interface LabelBox { x0: number; x1: number; y0: number; y1: number }

/**
 * The names put at the right ends of lines in one frame. The Volume profile's lines, the key levels and the VWAP each name their lines and each
 * left out a name that would cover another of its own; one of another feature went unseen, so a point of control and a previous low at one price
 * were printed over each other. They share one board a frame, in the order they are drawn (the Volume profile's first: its lines have no tag on the
 * price axis to fall back on, the key levels' and the VWAP's have): a name is kept only when it is clear of every one already kept.
 */
export class LabelBoard {
  readonly #kept: LabelBox[] = [];

  /** Begin a frame. */
  clear(): void { this.#kept.length = 0; }

  /** Keep `box` and say so; when it would cover a kept one, keep nothing and say so. */
  claim(box: LabelBox): boolean {
    for (const k of this.#kept) if (k.x0 < box.x1 && box.x0 < k.x1 && k.y0 < box.y1 && box.y0 < k.y1) return false;
    this.#kept.push(box);
    return true;
  }
}
