/**
 * The map's top strip as one system (Karl, 2026-11-21: "each layer came at a different time, so now it looks not coherent"; of three
 * proposals, same layout with one style, one grid, one grid with History in the levels panel, he chose the grid with History kept on the map,
 * where people see it). Every column beside the map has the same heading: its name on the corner tools'
 * row (the liquidation column's levels button, "Profile" for the book's column, the measure's name for a Volume profile column), then its
 * figures from one line under that row, 12 px a line, so the same figure stands at the same height in every column; notes come after the
 * figures. What stands there has three roles, each with one look:
 * - a control (pressed) is a map button (`styles.css`): the corner tools, the levels button, History; 26 px tall, 23 in the Bevel frame;
 * - a name (what a column, a sub-column or a lane is) is `nameFont` in the text colour;
 * - a figure or a note (how much; why) is `bodyFont`, muted; a warning (a group's orders not on the server, a measure's record cut short) is
 *   the theme's caution words colour (theme.ts `cautionInk`: amber moved toward the text until it reads), as every caution on the page is.
 * A compact map (a map pane under 520 px across: a phone's, or a narrow window's) has an 84 px profile column too narrow for a name and two
 * figure lines under the tools' row: it keeps its two figure lines at the top, as before (heat-pane.ts `#paintProfile`).
 * Pure: the painters (panes/heat-pane.ts) read the numbers here, and `tests/app-map-top.test.mts` holds them.
 */

/** The corner tools' row: its top (`styles.css` `.pane.heat .map-tools`) and a map button's height (23 in the Bevel frame, whose buttons cast no shadow). */
export const TOOLS_TOP = 8, TOOLS_H = 26, TOOLS_H_BEVEL = 23;
export const toolsH = (frame?: string): number => frame === 'bevel' ? TOOLS_H_BEVEL : TOOLS_H;
/** A map button's hard shadow under it (`3px 3px 0`): room kept below a button in a heading so the rows do not start under its shadow. */
export const TOOLS_SHADOW = 3;
/** Every column's words, and its buttons, stand this far in from its edge. The corner tools end 8 px left of the column and cast a 3 px shadow, so a
 * column's button stands 12 px clear of them and reads as that column's, not one more map tool. */
export const HEAD_INSET = 7;
/** A heading line. */
export const HEAD_PITCH = 12;
/** Room between the tools' row and the first line under it, and after the last line before the column's rows show again. */
export const HEAD_GAP = 4;
/** The heading band's opacity over the column's rows. */
export const HEAD_ALPHA = 0.9;

/** The first line under the tools' row (a line's top, `textBaseline` top): 38, 35 in the Bevel frame. */
export const firstLine = (frame?: string): number => TOOLS_TOP + toolsH(frame) + HEAD_GAP;
/** Where a name on the tools' row stands (a line's top) so that it reads level with the buttons' labels beside it. */
export const rowNameTop = (frame?: string): number => TOOLS_TOP + Math.round((toolsH(frame) - 10) / 2) - 1;
/** The band of a heading that has `lines` lines under the tools' row. */
export const headBand = (frame: string | undefined, lines: number): number => firstLine(frame) + HEAD_PITCH * lines + HEAD_GAP;

/**
 * The liquidation column's heading: `lines` lines under the tools' row (the figures, the words across a split, the notes), then History,
 * a map button, where it shows. `historyTop` is where History stands, `band` how far the band reaches (History and its shadow included).
 */
export function liqHeading(frame: string | undefined, lines: number, history: boolean): { first: number; historyTop: number; band: number } {
  const text = headBand(frame, lines);
  return { first: firstLine(frame), historyTop: text, band: history ? text + toolsH(frame) + TOOLS_SHADOW + HEAD_GAP : text };
}

/**
 * The split's two names on the levels button, which under a drawn split is as wide as the column (`room` px, its left edge at the column's
 * inset): each name stands as far into its own sub-column as the first does into the left one (the button's inset, its border `border` and
 * its left padding `pad`), the divider on the sub-columns' own (`subX` px from the column's left edge), neither name past the divider or
 * the arrow in the button's right padding (`arrow`). Positions are from the left of the button's padding box, where its absolutely placed
 * children are measured from.
 */
export function splitNames(o: { subX: number; room: number; border: number; pad: number; arrow: number }): { firstMax: number; divider: number; secondLeft: number; secondMax: number } {
  const divider = o.subX - HEAD_INSET - o.border, into = HEAD_INSET + o.border + o.pad, secondLeft = divider + into;
  return { firstMax: Math.max(0, divider - o.pad - 4), divider, secondLeft, secondMax: Math.max(0, o.room - 2 * o.border - o.arrow - secondLeft) };
}

/** What a line of a heading is: a name (whose levels), a note (what the curve leaves out), or a warning. */
export type HeadRole = 'name' | 'note' | 'warn';
export interface HeadLine { text: string; role: HeadRole }

const FACE = 'ui-sans-serif, system-ui, sans-serif';
/** A name: what a column, a sub-column or a lane is. */
export const nameFont = (size = 10): string => `600 ${size}px ${FACE}`;
/** A figure or a note. */
export const bodyFont = (size = 10): string => `${size}px ${FACE}`;
/** The type of a line in its role. */
export const roleFont = (role: HeadRole, size = 10): string => role === 'name' ? nameFont(size) : bodyFont(size);
/** The ink of a line in its role, from the theme's text and muted colours and its caution words colour. */
export const roleInk = (role: HeadRole, ink: { text: string; muted: string; caution: string }): string => role === 'name' ? ink.text : role === 'warn' ? ink.caution : ink.muted;
