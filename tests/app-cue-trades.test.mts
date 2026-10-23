import test from 'node:test';
import assert from 'node:assert/strict';
import { TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { MEANWHILE_AFTER_MS, MEANWHILE_BEFORE_MS, meanwhile, tradedInRow } from '../src/app/panes/ladder-cues.ts';

const T0 = 1_760_000_000_000;
interface Order { id: string; t: number; price: number; usd: number; lo?: number; hi?: number }
function tapeOf(orders: Order[], seq = 1, ring = new TapeRing(4096)): TapeRing {
  const ids = [...new Set(orders.map(o => o.id))];
  const batch: TapeBatch = { seq, dropped: 0, ids, inst: Int32Array.from(orders.map(o => ids.indexOf(o.id))), t: Float64Array.from(orders.map(o => o.t)), price: Float64Array.from(orders.map(o => o.price)),
    usd: Float32Array.from(orders.map(o => o.usd)), lo: Float64Array.from(orders.map(o => o.lo ?? o.price)), hi: Float64Array.from(orders.map(o => o.hi ?? o.price)) };
  ring.add(batch, 1, 0);
  return ring;
}
/** The window a change's "meanwhile" looks in: [T0, T0 + 5,000] widened. */
const win = { from: T0 - MEANWHILE_BEFORE_MS, to: T0 + 5_000 + MEANWHILE_AFTER_MS };
const row = { lo: 81_000, hi: 81_050 };
/** The page's clock is a minute later than every interval below unless a test says otherwise. */
const later = { now: T0 + 60_000 };
/** An order well before every interval below (another venue, another row): the tape's stretch begins before they do. */
const early: Order = { id: 'c:BTC', t: T0 - 10_000, price: 82_500, usd: 1_000 };
/** And one after them: a tape that went quiet long before an interval ended does not cover it. */
const late: Order = { id: 'c:BTC', t: T0 + 20_000, price: 82_500, usd: 1_000 };
const ask = (id: string, extra: Partial<Parameters<typeof tradedInRow>[1]> = {}): Parameters<typeof tradedInRow>[1] => ({ id, ask: true, ...row, ...win, ...later, ...extra });

test('what traded at a row between two snapshots: the orders that reached it on that venue, on the side that takes from it', () => {
  const ring = tapeOf([early,
    { id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 },                          // a buyer at the row: takes the asks
    { id: 'a:BTC', t: T0 + 2_000, price: 81_030, usd: 200_000, lo: 80_990, hi: 81_070 },   // a buyer that walked through the row
    { id: 'a:BTC', t: T0 + 3_000, price: 81_020, usd: -150_000 },                          // a seller at the row: takes the bids
    { id: 'b:BTC', t: T0 + 3_500, price: 81_020, usd: 900_000 },                           // another venue
    { id: 'a:BTC', t: T0 + 4_000, price: 81_200, usd: 700_000 },                           // another row
    { id: 'a:BTC', t: T0 + 20_000, price: 81_020, usd: 800_000 },                          // after the interval
  ]);
  assert.equal(tradedInRow(ring, ask('a:BTC')), 500_000, 'asks: the two buyers, whole orders');
  assert.equal(tradedInRow(ring, ask('a:BTC', { ask: false })), 150_000, 'bids: the seller');
  assert.equal(tradedInRow(ring, ask('b:BTC')), 900_000);
  assert.equal(tradedInRow(ring, ask('c:BTC')), 0, 'a venue that is on the tape (it traded a few seconds before) and had no order there: nothing traded');
  assert.equal(tradedInRow(ring, ask('zz:BTC')), null, 'a venue that is not on the tape at all: its silence says nothing');
});

test('an order at the edge of a row: a price at the row\'s upper edge belongs to the next row; one that walked up to the lower edge reached the row', () => {
  const ring = tapeOf([early, { id: 'a:BTC', t: T0 + 100, price: 81_050, usd: 100_000 }, { id: 'a:BTC', t: T0 + 200, price: 80_990, usd: 50_000, lo: 80_990, hi: 81_000 }, late]);
  assert.equal(tradedInRow(ring, ask('a:BTC')), 50_000);
});

test('the interval is looked at a little widely (two clocks, a snapshot that lags its book) and no wider', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS - 1, price: 82_000, usd: 1 }, { id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS + 1, price: 81_010, usd: 10_000 }, { id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS - 1, price: 81_010, usd: 20_000 },
    { id: 'a:BTC', t: T0 + 5_000 + MEANWHILE_AFTER_MS - 1, price: 81_010, usd: 40_000 }, { id: 'a:BTC', t: T0 + 5_000 + MEANWHILE_AFTER_MS + 1, price: 81_010, usd: 80_000 }]);
  assert.equal(tradedInRow(ring, ask('a:BTC')), 50_000);
  assert.deepEqual(meanwhile(T0, T0 + 5_000), win);
});

test('unknown is not zero: an interval the tape does not cover (before it began, long after its last order, across a gap short or long) says nothing', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 }, { id: 'a:BTC', t: T0 + 2_000, price: 81_010, usd: 300_000 }]);
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 - 60_000, to: T0 + 1_500 })), null, 'it began later than the interval did');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 500_000, to: T0 + 501_000, now: T0 + 600_000 })), null, 'the interval is long after its last order');
  tapeOf([{ id: 'a:BTC', t: T0 + 100_000, price: 81_010, usd: 100_000 }], 9, ring); // a batch after a gap in the sequence: a new stretch
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 1_500, to: T0 + 100_500 })), null, 'a gap lies inside it');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 100_000, to: T0 + 100_500, now: T0 + 200_000 })), 100_000, 'inside the stretch after the gap it is known');
  assert.equal(tradedInRow(new TapeRing(4096), ask('a:BTC')), null, 'an empty tape');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: 5, to: 1 })), null, 'a backwards interval');
});

test('a short gap counts: the stretches either side of it are not one, and the slack of a running stretch does not bridge it', () => {
  const ring = tapeOf([early, { id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 }]);
  tapeOf([{ id: 'a:BTC', t: T0 + 1_500, price: 81_010, usd: 200_000 }, late], 9, ring); // the source skipped a batch between the two orders
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 500, to: T0 + 2_000 })), null, 'half a second of gap lies inside the interval: the first stretch ended at T0 + 1,000');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 1_500, to: T0 + 5_000 })), 200_000, 'wholly inside the stretch that goes on');
});

test('what the ring no longer holds is not "none traded": an interval that starts before the oldest order kept says nothing', () => {
  const ring = new TapeRing(4096), orders: Order[] = Array.from({ length: 5_000 }, (_, k) => ({ id: 'a:BTC', t: T0 + k, price: 81_010, usd: 1_000 }));
  tapeOf(orders, 1, ring);
  assert.equal(ring.written, 5_000); assert.equal(ring.heldFrom, T0 + 904, 'the oldest 904 orders were overwritten');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 500, to: T0 + 1_000 })), null, 'the interval began before the ring\'s memory did');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 1_000, to: T0 + 1_100 })), 101_000, 'after it, known');
});

test('an interval whose orders may still be on their way is not read yet', () => {
  const ring = tapeOf([early, { id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 }, late]);
  assert.equal(tradedInRow(ring, ask('a:BTC', { now: win.to + 500 })), null, 'half a second after its end');
  assert.equal(tradedInRow(ring, ask('a:BTC', { now: win.to + 1_500 })), 300_000, 'a second and a half after: read');
});

test('what the ring overwrote is lost through the greatest time it lost, whatever order the orders came in: nothing at or before it is read as "none traded"', () => {
  const ring = new TapeRing(4096);
  assert.equal(ring.lostThrough, -Infinity, 'a ring that has not wrapped has lost nothing');
  // arrival order: a $500K buyer stamped T0 + 1,000 (the first write: the 4,097th overwrites it), then an order stamped earlier (the first the ring keeps, T0 + 900), then fillers of the same venue outside the row
  const orders: Order[] = [{ id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 500_000 }, { id: 'a:BTC', t: T0 + 900, price: 82_000, usd: 1_000 }];
  for (let k = 0; k < 4_095; k++) orders.push({ id: 'a:BTC', t: T0 + 2_000 + k, price: 82_000, usd: 1_000 });
  tapeOf(orders, 1, ring);
  assert.equal(ring.written, 4_097); assert.equal(ring.lostThrough, T0 + 1_000); assert.equal(ring.heldFrom, T0 + 900, 'the oldest in arrival order is older than what was lost');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 950, to: T0 + 2_700 })), null, 'its interval reaches the overwritten trade: unknown, not 0');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 1_010, to: T0 + 2_700 })), 0, 'a little after what was lost it is known');
  ring.clear(); assert.equal(ring.lostThrough, -Infinity);
});

test('after the ring moves its time base the times it stores are exact only to a millisecond or two: what it lost is taken a couple of milliseconds later', () => {
  const ring = new TapeRing(4096);
  // batch one: a $500K buyer stamped T0 + 1 (the first write: it will be overwritten), and an order of the same venue outside the row at T0 + 1,500 (the venue is on the tape then)
  tapeOf([{ id: 'a:BTC', t: T0 + 1, price: 81_010, usd: 500_000 }, { id: 'a:BTC', t: T0 + 1_500, price: 82_000, usd: 1_000 }], 1, ring);
  // batch two, more than 2^24 ms later: the ring moves its time base and every stored offset is rounded again; 4,095 writes in all fill it and overwrite the first
  tapeOf(Array.from({ length: 4_095 }, (_, k) => ({ id: 'a:BTC', t: T0 + 17_000_000 + k, price: 82_000, usd: 1_000 })), 2, ring);
  assert.ok(ring.lostThrough >= T0 - 3 && ring.lostThrough <= T0 + 3, `lost through T0 + ${ring.lostThrough - T0}: the stored time of the overwritten order`);
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 1, to: T0 + 2_000, now: T0 + 20_000_000 })), null, 'its own millisecond is still reaching the overwritten trade');
  assert.equal(tradedInRow(ring, ask('a:BTC', { from: T0 + 6, to: T0 + 2_000, now: T0 + 20_000_000 })), 0, 'a few milliseconds on, known');
});
