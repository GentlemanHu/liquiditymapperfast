import { el } from '../dom.ts';
import { t, tn } from '../i18n.ts';
import { MEASURES, measureDef, type ProfileMetric } from '../measures/registry.ts';
import { PLACEMENTS, isPlaced, placedOn, type ProfileInstance, type ProfilePlacement, type ProfileSet } from './profiles.ts';
import type { Arranged } from './arrange.ts';

/**
 * The Volume profile panel's places (Karl, 2026-10-20): a grid with a row for each measure the registry holds and a column for each place
 * (right of the map, left of it, along the top), each cell a switch; and beside it a small picture of the chart that shows which edges hold
 * which profiles, the columns adding up by price and the bands by time, stacked as they will be and with what has no room. The picture is a
 * preview, never an editor: the switches are the one way to choose.
 */

/** What each place is called at the head of its column of the grid, and what it adds up by. */
const placeName = (p: ProfilePlacement): string => p === 'right' ? t('Right') : p === 'left' ? t('Left') : t('Top');
const placeAxis = (p: ProfilePlacement): string => p === 'top' ? t('by time') : t('by price');

/** The grid: a row a measure, a switch a place; `onToggle` switches one measure at one place. */
export function placementGrid(set: ProfileSet, onToggle: (metric: ProfileMetric, placement: ProfilePlacement, on: boolean) => void): HTMLElement {
  const head = el('div', { class: 'place-row place-head' }, el('span'),
    ...PLACEMENTS.map(p => el('span', { class: 'place-col' }, el('b', { textContent: placeName(p) }), el('small', { textContent: placeAxis(p) }))));
  const rows = MEASURES.map(m => {
    const cells = PLACEMENTS.map(p => {
      const box = el('input', { type: 'checkbox', checked: isPlaced(set, m.id, p), ariaLabel: `${m.name()} · ${placeName(p)}` });
      box.dataset.focus = `placement-${m.id}-${p}`;
      box.onchange = () => onToggle(m.id, p, box.checked);
      return el('label', { class: 'place-cell' }, el('span', { class: 'switch' }, box, el('i')));
    });
    return el('div', { class: 'place-row' }, el('span', { class: 'place-name', textContent: m.name(), tip: m.tip() }), ...cells);
  });
  return el('div', { class: 'place-grid', role: 'group', ariaLabel: t('Where each measure is drawn') }, head, ...rows);
}

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The picture's size and its parts' widths (SVG units). */
const W = 248, H = 132, FLOW = 22, COL = 15, BOOK = 22, AXIS = 14, TIME = 11, PLOT_H = H - TIME;

/**
 * The small picture of the chart: the flow column, the columns left of the map, the map with its bands along the top, the book profile, the
 * columns right of the map and the price axis, each profile named and coloured as its measure's two sides are. Where `arranged` says what
 * fits (the map's room as it was last drawn), a profile with no room is drawn dashed, outside the others, and said under the picture.
 */
export function placementSketch(set: ProfileSet, arranged: Arranged | null): HTMLElement {
  const right = placedOn(set, 'right'), left = placedOn(set, 'left'), top = placedOn(set, 'top');
  const hidden = new Set(arranged?.hidden ?? []), root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'place-sketch', role: 'img', 'aria-label': t('A sketch of the chart: where each profile is drawn') });
  const frame = (x: number, y: number, w: number, h: number, cls: string): void => { root.append(svg('rect', { x, y, width: w, height: h, class: cls })); };
  // The fixed parts: the flow column, the book profile and the axes.
  const mapX = FLOW + left.length * COL, mapW = W - mapX - BOOK - right.length * COL - AXIS;
  frame(0.5, 0.5, FLOW - 1, PLOT_H - 1, 'sk-fixed');
  root.append(svg('text', { x: FLOW / 2, y: PLOT_H / 2, class: 'sk-word sk-up', transform: `rotate(-90 ${FLOW / 2} ${PLOT_H / 2})` }, t('Flow')));
  frame(mapX + 0.5, 0.5, mapW - 1, PLOT_H - 1, 'sk-map');
  frame(mapX + mapW + 0.5, 0.5, BOOK - 1, PLOT_H - 1, 'sk-fixed');
  root.append(svg('text', { x: mapX + mapW + BOOK / 2, y: PLOT_H / 2, class: 'sk-word sk-up', transform: `rotate(-90 ${mapX + mapW + BOOK / 2} ${PLOT_H / 2})` }, t('Book')));
  frame(W - AXIS + 0.5, 0.5, AXIS - 1, H - 1, 'sk-fixed');
  frame(0.5, PLOT_H + 0.5, W - AXIS - 1, TIME - 1, 'sk-fixed');
  // A side column: the measure's two sides as bars from the map's edge outward, its name along it; dashed when it has no room.
  const column = (p: ProfileInstance, x: number, side: 'right' | 'left'): void => {
    const off = hidden.has(p), g = svg('g', { class: off ? 'sk-off' : 'sk-on' });
    g.append(svg('rect', { x: x + 0.5, y: 0.5, width: COL - 1, height: PLOT_H - 1, class: 'sk-col' }));
    for (let i = 0; i < 9; i++) {
      const len = (COL - 4) * [0.4, 0.7, 1, 0.8, 0.5, 0.65, 0.35, 0.55, 0.3][i]!, y = 18 + i * 10;
      g.append(svg('rect', { x: side === 'right' ? x + 2 : x + COL - 2 - len, y, width: len, height: 6, class: i % 2 ? 'sk-ask' : 'sk-bid' }));
    }
    const cx = x + COL / 2;
    g.append(svg('text', { x: cx, y: PLOT_H / 2, class: 'sk-word sk-up', transform: `rotate(-90 ${cx} ${PLOT_H / 2})` }, measureDef(p.metric).short()));
    root.append(g);
  };
  left.forEach((p, i) => column(p, mapX - (i + 1) * COL, 'left'));
  right.forEach((p, i) => column(p, mapX + mapW + BOOK + i * COL, 'right'));
  // The bands, stacked from the top of the map down as they will be: the first by order lowest, nearest the chart.
  const drawnTop = top.filter(p => !hidden.has(p)), bandH = drawnTop.length <= 1 ? 20 : drawnTop.length === 2 ? 15 : 12;
  [...top].reverse().forEach((p, i) => {
    const off = hidden.has(p), y = 6 + i * (bandH + 2), g = svg('g', { class: off ? 'sk-off' : 'sk-on' });
    g.append(svg('rect', { x: mapX + 4.5, y: y + 0.5, width: mapW - 9, height: bandH - 1, class: 'sk-col' }));
    for (let k = 0; k < 14; k++) {
      const len = (bandH - 4) * [0.3, 0.6, 0.9, 0.5, 0.4, 1, 0.7, 0.35, 0.5, 0.8, 0.45, 0.6, 0.3, 0.5][k]!;
      g.append(svg('rect', { x: mapX + 44 + k * ((mapW - 52) / 14), y: y + 2, width: Math.max(1.5, (mapW - 52) / 14 - 1.5), height: len, class: k % 3 ? 'sk-bid' : 'sk-ask' }));
    }
    g.append(svg('text', { x: mapX + 7, y: y + bandH / 2 + 0.5, class: 'sk-word sk-left' }, measureDef(p.metric).short()));
    root.append(g);
  });
  // What each kind adds up by, where there is room to say it.
  const captionY = PLOT_H - 6;
  if (mapW > 70) root.append(svg('text', { x: mapX + mapW / 2, y: captionY, class: 'sk-cap' }, top.length && (left.length || right.length) ? t('columns by price, bands by time') : top.length ? t('bands by time') : left.length || right.length ? t('columns by price') : t('No profile placed')));
  const wrap = el('div', { class: 'place-sketch-wrap' });
  wrap.append(root);
  return wrap;
}

/** What had no room, in words: how many, which, and that they stay switched on. */
export function hiddenText(hidden: readonly ProfileInstance[]): string {
  const where = (p: ProfileInstance): string => {
    const measure = measureDef(p.metric).name();
    return p.placement === 'right' ? t('{measure} right of the map', { measure }) : p.placement === 'left' ? t('{measure} left of the map', { measure }) : t('{measure} along the top', { measure });
  };
  return tn(hidden.length, '{n} profile hidden for space: {which}. It stays switched on and shows when there is room: a wider window, a taller chart, or fewer profiles.',
    '{n} profiles hidden for space: {which}. They stay switched on and show when there is room: a wider window, a taller chart, or fewer profiles.', { which: hidden.map(where).join(', ') });
}
