import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, createRunner, runScript } from '../src/app/script/lang/engine.ts';
import { STEPS_PER_CANDLE } from '../src/app/script/lang/analysis.ts';
import { examples, exampleHeight } from '../src/app/script/examples.ts';
import { HEATMAP_SOURCE } from '../src/app/script/starter.ts';
import { filterKey, type BarInputs, type SourceInputs } from '../src/app/script/inputs.ts';

const N = 300, HOUR = 3_600_000;
/** Candles of a wandering price with flow and liquidations on every market set the examples read. */
function inputs(): BarInputs {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const close: number[] = []; let p = 80_000;
  for (let i = 0; i < N; i++) { p *= 1 + (rnd() - 0.5) * 0.01; close.push(p); }
  const flow = (): SourceInputs => ({
    vbuy: Float64Array.from({ length: N }, () => rnd() * 2e8), vsell: Float64Array.from({ length: N }, () => rnd() * 2e8),
    lbuy: Float64Array.from({ length: N }, () => rnd() < 0.3 ? rnd() * 5e6 : 0), lsell: Float64Array.from({ length: N }, () => rnd() < 0.3 ? rnd() * 5e6 : 0), markets: 3,
  });
  return {
    tf: HOUR, time: Float64Array.from({ length: N }, (_, i) => i * HOUR),
    // Wicks of their own length a candle, so candles can sit inside or reach past the one before, as real ones do.
    open: Float64Array.from(close, (c, i) => i ? close[i - 1]! : c), high: Float64Array.from(close, (c, i) => Math.max(c, i ? close[i - 1]! : c) * (1 + rnd() * 0.006)), low: Float64Array.from(close, (c, i) => Math.min(c, i ? close[i - 1]! : c) * (1 - rnd() * 0.006)),
    close: Float64Array.from(close), volume: Float64Array.from(close, () => 1),
    sources: { '': flow(), [filterKey({ kinds: ['perp'] })]: flow(), [filterKey({ kinds: ['spot'] })]: flow() },
    forming: true,
  };
}

test('every example reads, declares the options it reads, runs without a warning and draws, within its steps', () => {
  for (const ex of examples()) {
    const a = analyze(ex.source);
    assert.deepEqual([...a.read], [], `${ex.name}: every option it reads is declared`);
    const r = runScript('x', ex.source, {}, inputs());
    assert.ok(r.ok, `${ex.name}: ${r.ok ? '' : JSON.stringify(r.error)}`);
    assert.deepEqual(r.warnings, [], ex.name);
    assert.ok(r.plots.some(p => Object.values(p.fields).some(f => f.some(Number.isFinite))), `${ex.name} draws`);
    assert.ok(r.steps / N < STEPS_PER_CANDLE / 4, `${ex.name}: ${Math.round(r.steps / N)} steps a candle, well under the ${STEPS_PER_CANDLE} each may take`);
  }
});

test('the heat map: sixteen rows of colour on 0..100, its average over them, its widest windows within budget, and kept between runs', () => {
  const r = runScript('heat', HEATMAP_SOURCE, {}, inputs());
  assert.ok(r.ok);
  const rows = r.plots.filter(p => p.kind === 'brokenarea');
  assert.equal(rows.length, 16);
  assert.ok(rows.every(p => p.colors !== null && p.colors.some(c => !!c)), 'each row coloured candle by candle');
  const average = r.plots.find(p => p.title === 'Average')!;
  const last = average.fields.value![N - 1]!;
  assert.ok(last >= 0 && last <= 100, `average ${last}`);
  assert.equal(exampleHeight(HEATMAP_SOURCE), 160, 'its row has room for sixteen bands');
  const wide = runScript('heat', HEATMAP_SOURCE, { scale: 4 }, inputs());
  assert.ok(wide.ok && wide.steps / N < STEPS_PER_CANDLE / 4, 'windows four times as long stay within the budget');
  // Between two runs over the same closed candles only the candle under way runs again (its kept names are plain values).
  const runner = createRunner('heat', HEATMAP_SOURCE, {});
  const first = runner.run(inputs());
  const next = inputs(); next.close[N - 1] = next.close[N - 1]! * 1.001;
  const again = runner.run(next);
  assert.ok(first.ok && again.ok);
  assert.ok(again.steps < first.steps / 50, `the next run took ${again.steps} steps after ${first.steps}`);
  const colored = runScript('heat', HEATMAP_SOURCE, { colorCandles: true }, inputs());
  assert.ok(colored.ok && colored.candleColors?.some(c => !!c), 'candle colours when switched on');
  assert.ok(!r.candleColors?.some(c => !!c), 'and none by default');
});
