import { createRunner, type ScriptRunner } from './lang/engine.ts';
import type { RunRequest, RunResponse, ScriptResult } from './protocol.ts';

/**
 * The scripts' own thread: it runs each script of a request over the inputs it was handed and answers with what to draw. It reads nothing
 * else: no network, no storage, no page. A script that throws is answered as an error; the page ends this worker when a run takes too long.
 * Each script is read once and kept (`createRunner`) while its text, its options and its language version stay the same, so a run over the
 * same closed candles only runs the candle under way again.
 */

const scope = self as unknown as { postMessage(message: RunResponse, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<RunRequest>) => void) | null };

const runners = new Map<string, { key: string; runner: ScriptRunner }>();

scope.onmessage = event => {
  const req = event.data;
  if (!req || req.t !== 'run') return;
  const results: ScriptResult[] = [];
  for (const job of req.jobs) {
    const key = `${job.api}\u0001${JSON.stringify(job.options)}\u0001${job.source}`;
    let held = runners.get(job.id);
    if (!held || held.key !== key) { held = { key, runner: createRunner(job.id, job.source, job.options) }; runners.set(job.id, held); }
    try { results.push(held.runner.run(req.inputs)); }
    catch { runners.delete(job.id); results.push({ id: job.id, ok: false, error: { code: 'internal', line: 0, col: 0 } }); }
  }
  // A script no longer asked for is let go.
  for (const id of [...runners.keys()]) if (!req.jobs.some(j => j.id === id)) runners.delete(id);
  // The plots are copied, not handed over: the runner keeps them to take the closed candles over into its next run.
  scope.postMessage({ t: 'result', seq: req.seq, results });
};

// Loaded: the page starts a run's clock only from here, so the time a worker takes to load is never taken for a script that runs too long.
scope.postMessage({ t: 'ready' });
