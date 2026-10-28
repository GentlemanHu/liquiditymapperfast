import { MAGNET_MODES, type MagnetMode } from './magnet.ts';

/**
 * How the drawing tools behave, kept with the page's settings (not in layouts: they are a person's way of drawing, as the drawings are
 * theirs): the magnet, whether it also lands on walls of resting liquidity, whether a tool stays armed after each drawing, and whether the
 * drawings show and can be changed at all.
 */
export interface DrawSettings { magnet: MagnetMode; walls: boolean; keep: boolean; shown: boolean; locked: boolean }

/** A weak magnet from the first visit (Karl, 2026-10-28), landing on walls too; one drawing at a time; shown and changeable. */
export const DRAW_DEFAULTS: Readonly<DrawSettings> = { magnet: 'weak', walls: true, keep: false, shown: true, locked: false };

/** Settings from storage, field by field: whatever is missing or not one of the choices is the default. */
export function readDrawSettings(saved: unknown): DrawSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>, d = DRAW_DEFAULTS;
  const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;
  return { magnet: MAGNET_MODES.includes(s.magnet as MagnetMode) ? s.magnet as MagnetMode : d.magnet, walls: flag(s.walls, d.walls), keep: flag(s.keep, d.keep), shown: flag(s.shown, d.shown), locked: flag(s.locked, d.locked) };
}
