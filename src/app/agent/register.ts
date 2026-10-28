/**
 * Offers the page's tools (tools.ts) to an agent in the browser, where the browser has page tools (`document.modelContext`); loaded only
 * there (main.ts). A tool the browser refuses (no permission, a name taken) is left out and the page goes on without it.
 */
import { currentCoin } from '../coin.ts';
import { TIMEFRAMES } from '../hub.ts';
import type { ScriptPane } from '../panes/script-pane.ts';
import { replaying } from '../replay/clock.ts';
import type { Store } from '../store.ts';
import { agentTools, type AgentPage, type AgentTool } from './tools.ts';

/** The part of the page-tools interface the page uses. */
interface ModelContextLike {
  registerTool(tool: AgentTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

/** The page as the tools see it. */
export function agentPage(store: Store, script: ScriptPane): AgentPage {
  return {
    view: () => {
      const s = store.state, last = s.candles[s.candles.length - 1];
      return { coin: currentCoin().coin, market: s.seriesInstrument, timeframe: s.timeframe, candles: s.candles.length, newest: last ? { time: last[0], close: last[4] } : null, replaying: replaying(), scriptsOn: s.show.script };
    },
    timeframes: Object.keys(TIMEFRAMES),
    scripts: () => script.records.map(r => {
      const a = script.analysisOf(r), reading = 'program' in a ? null : a, result = reading ? null : script.resultOf(r.id);
      // A run's warnings hold the reading's; without a run, the reading's stand with the page's own.
      const warnings = [...script.warningsOf(r.id), ...('program' in a && !result?.ok ? a.warnings : [])];
      return { id: r.id, name: r.name, on: r.on, place: r.place, source: r.source, options: r.options, reading, result, warnings, candles: script.ranOn(r.id)?.candles ?? 0 };
    }),
    tryScript: (source, options, signal) => script.tryScript(source, options, signal),
    propose: p => script.proposeScript(p),
    setTimeframe: timeframe => { if (store.state.timeframe !== timeframe) store.set({ timeframe }); },
  };
}

/** Offer the tools; the answer withdraws them. Nothing where the browser has no page tools. */
export function registerAgentTools(store: Store, script: ScriptPane): () => void {
  const context = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (typeof context?.registerTool !== 'function') return () => {};
  const stop = new AbortController();
  script.warmTrials();
  for (const tool of agentTools(agentPage(store, script))) {
    void Promise.resolve().then(() => context.registerTool(tool, { signal: stop.signal })).catch(() => { /* refused: left out */ });
  }
  return () => stop.abort();
}
