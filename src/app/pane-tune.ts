import { el } from './dom.ts';
import { openSheet, type Sheet } from './sheet.ts';
import { t } from './i18n.ts';

/**
 * The header of a pane on a phone is one slim row (Karl, 2026-10-26: three rows of small selects left a third of the screen to the chart): its
 * title, the choice that is changed all the time, and a key that opens the rest as a sheet. The controls are the pane's own elements, moved
 * into the sheet while it is open and put back where they were when it closes, so nothing is rebuilt and each keeps its handlers and its state.
 * A desktop never shows the key and nothing moves there (the stylesheet hides only on a phone). The elements named as `rest` are the ones that
 * wait in the sheet; any other control of the header stays in the row.
 */
const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';

export interface Tune { readonly key: HTMLButtonElement; readonly open: () => Sheet | null; readonly sheet: () => Sheet | null }

export function addTune(head: HTMLElement, rest: readonly HTMLElement[], title: string): Tune {
  head.classList.add('tuned');
  for (const node of rest) node.classList.add('rest');
  let sheet: Sheet | null = null;
  const open = (): Sheet | null => {
    if (sheet) return sheet;
    // Each control leaves a mark where it was, so it goes back to the same place whatever else changed in the row meanwhile.
    const holes = rest.map(node => { const hole = document.createComment(''); node.replaceWith(hole); return hole; });
    sheet = openSheet(title, body => { body.classList.add('tune-body'); for (const node of rest) body.append(node); }, () => {
      holes.forEach((hole, i) => hole.replaceWith(rest[i]!));
      sheet = null; key.classList.remove('open');
    });
    key.classList.add('open');
    return sheet;
  };
  const key = el('button', { type: 'button', class: 'tune-btn', ariaLabel: t('Settings'), tip: t('Settings'), onclick: () => { if (sheet) sheet.close(); else open(); } });
  key.insertAdjacentHTML('afterbegin', ICON);
  head.append(key);
  return { key, open, sheet: () => sheet };
}
