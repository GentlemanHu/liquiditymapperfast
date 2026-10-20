import type { Store } from '../store.ts';
import { HELP, helpButton } from '../help.ts';
import { note, selectRow, switchRow } from '../ui.ts';
import { t } from '../i18n.ts';
import type { MeasureStripSettings } from './settings.ts';

/**
 * The measure strip's panel (the key of its split button): its switch first, as every lamp feature's panel has, then the measure, and what
 * that measure covers and cannot say. Switching it never changes the measure chosen.
 */
export function buildMeasurePanel(store: Store, tools: HTMLElement, body: HTMLElement, rebuild: () => void): void {
  const s = store.state.measureStrip;
  const set = (change: Partial<MeasureStripSettings>): void => { store.set({ measureStrip: { ...store.state.measureStrip, ...change } }); rebuild(); };
  tools.append(helpButton('measures'));
  body.append(
    switchRow(t('Show the measure strip'), t('One bar per candle along the top of the chart: above the zero line for more, below it for less.'), s.on, on => set({ on })),
    selectRow(t('Measure'), t('What each candle\'s bar stands for.'), [['delta', t('Delta')], ['oi', t('OI change')]], s.kind, kind => set({ kind: kind === 'oi' ? 'oi' : 'delta', on: true })),
    // The help's own paragraphs, so the panel and its "?" cannot say different things.
    note(HELP.measures.body[s.kind === 'delta' ? 1 : 2] ?? ''),
    note(HELP.measures.body[3] ?? ''),
  );
}
