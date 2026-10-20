import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL, SUBSTEP_MS, WAVE_SPEED, pulseFor } from '../src/app/glass/waves.ts';

test('the wave field\'s one substep is short enough to stay stable at its speed, and whole in the usual frames', () => {
  const courant = WAVE_SPEED / CELL / 1000 * SUBSTEP_MS;
  assert.ok(courant <= 0.6, `a Courant number of ${courant.toFixed(3)}, inside the 0.71 that leapfrog allows in 2D`);
  for (const hz of [30, 60, 120]) assert.ok(Math.abs(1000 / hz / SUBSTEP_MS - Math.round(1000 / hz / SUBSTEP_MS)) < 1e-9, `a whole number of substeps in a ${hz} Hz frame`);
});

test('a larger order makes a taller and a wider pulse, as a larger stone does, within bounds', () => {
  const small = pulseFor(25_000, 25_000), mid = pulseFor(250_000, 25_000), big = pulseFor(2_500_000, 25_000), huge = pulseFor(1e12, 25_000);
  assert.ok(small.amp < mid.amp && mid.amp < big.amp, 'taller');
  assert.ok(small.width < mid.width && mid.width < big.width, 'wider');
  assert.ok(huge.amp <= 1.6, 'and never past the cap');
  assert.deepEqual(pulseFor(-250_000, 25_000), mid, 'a sell as a buy');
});
