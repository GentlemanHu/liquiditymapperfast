import { t } from '../i18n.ts';
import type { Store } from '../store.ts';
import { heading, switchRow } from '../ui.ts';

/**
 * The Flow history's switch (`show.sizes`), the same rows in the flow column's settings and in the Bar stats' settings (Karl, 2026-11-20:
 * reachable from both), on a phone too. Its button in the top bar's Panels deck (toolbar.ts `PANE_TOGGLES`; Karl, 2026-11-21: these two alone
 * were hard to discover), which a phone's Settings also lists, is the same switch.
 */
export function flowHistoryRows(store: Store): HTMLElement[] {
  return [
    heading(t('Flow history')),
    switchRow(t('Show the Flow history'), t("A pane under the chart: liquidations, open interest's change and market orders in six size bands, candle by candle, the most unusual amounts the brightest."),
      store.state.show.sizes, on => store.set({ show: { ...store.state.show, sizes: on } })),
  ];
}
