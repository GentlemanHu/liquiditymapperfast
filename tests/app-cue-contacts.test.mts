import test from 'node:test';
import assert from 'node:assert/strict';
import { TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { CONTACT_FALLOFF, CONTACT_LIFE_MS, CONTACT_ROWS, CONTACT_WEIGHT, CueBoard, contactRows, type ContactRow, type CueRow, type Geometry } from '../src/app/panes/ladder-cues.ts';

const T0 = 1_760_000_000_000;
interface Order { id: string; t: number; price: number; usd: number; lo?: number; hi?: number }
/** A tape holding `orders` in this order (the ring's first order sets its bases). */
function tapeOf(orders: Order[]): TapeRing {
  const ring = new TapeRing(4096), ids = [...new Set(orders.map(o => o.id))];
  const batch: TapeBatch = { seq: 1, dropped: 0, ids, inst: Int32Array.from(orders.map(o => ids.indexOf(o.id))), t: Float64Array.from(orders.map(o => o.t)), price: Float64Array.from(orders.map(o => o.price)),
    usd: Float32Array.from(orders.map(o => o.usd)), lo: Float64Array.from(orders.map(o => o.lo ?? o.price)), hi: Float64Array.from(orders.map(o => o.hi ?? o.price)) };
  ring.add(batch, 1, 0);
  return ring;
}
const opts = (extra: Partial<Parameters<typeof contactRows>[3]> = {}): Parameters<typeof contactRows>[3] => ({ step: 50, floor: 25_000, scale: 500_000, now: T0 + 1_000, ids: new Set(['a:BTC', 'b:BTC']), maxAgeMs: 4_000, ...extra });

test('a buyer\'s order is a contact with the asks it took, from the touch outward, weaker for each row it went on to', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0, price: 81_060, usd: 200_000, lo: 81_020, hi: 81_130 }]);
  const rows = contactRows(ring, 0, ring.written, opts());
  assert.deepEqual(rows.map(r => [r.side, r.row, r.buy]), [['ask', 1620, true], ['ask', 1621, true], ['ask', 1622, true]]);
  assert.ok(Math.abs(rows[0]!.strength - (1 - Math.exp(-0.4))) < 1e-9);
  assert.ok(Math.abs(rows[1]!.strength - rows[0]!.strength * CONTACT_FALLOFF) < 1e-9 && Math.abs(rows[2]!.strength - rows[0]!.strength * CONTACT_FALLOFF ** 2) < 1e-9);
  assert.ok(rows.every(r => r.id === 'a:BTC' && r.usd === 200_000 && r.wall === T0));
});

test('a seller\'s order is a contact with the bids, from the highest price down', () => {
  const ring = tapeOf([{ id: 'b:BTC', t: T0, price: 80_990, usd: -300_000, lo: 80_960, hi: 81_000 }]);
  const rows = contactRows(ring, 0, ring.written, opts());
  assert.deepEqual(rows.map(r => [r.side, r.row, r.buy, r.usd]), [['bid', 1620, false, 300_000], ['bid', 1619, false, 300_000]]);
});

test('an order at one price is one row; a long walk reaches at most the rows a contact may', () => {
  const one = tapeOf([{ id: 'a:BTC', t: T0, price: 81_010, usd: 60_000 }]);
  assert.equal(contactRows(one, 0, one.written, opts()).length, 1);
  const long = tapeOf([{ id: 'a:BTC', t: T0, price: 81_010, usd: 5e6, lo: 81_000, hi: 82_500 }]);
  assert.equal(contactRows(long, 0, long.written, opts()).length, CONTACT_ROWS);
});

test('small orders, other books and old orders are not contacts', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0, price: 81_010, usd: 20_000 }, { id: 'zz:BTC', t: T0, price: 81_010, usd: 900_000 }, { id: 'a:BTC', t: T0 - 10_000, price: 81_010, usd: 900_000 }, { id: 'b:BTC', t: T0, price: 81_010, usd: 25_000 }]);
  const rows = contactRows(ring, 0, ring.written, opts());
  assert.deepEqual(rows.map(r => [r.id, r.usd]), [['b:BTC', 25_000]], 'only the one that is large enough, on a book of the book, and recent');
  assert.deepEqual(contactRows(ring, 0, ring.written, opts({ step: 0 })), [], 'no step, no rows');
  assert.deepEqual(contactRows(ring, 2, 2, opts()), [], 'nothing between two write numbers that meet');
});

test('contacts are read between two write numbers only, so what the tape held before is not played back', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0, price: 81_010, usd: 100_000 }, { id: 'a:BTC', t: T0 + 10, price: 81_060, usd: 100_000 }, { id: 'a:BTC', t: T0 + 20, price: 81_110, usd: 100_000 }]);
  assert.deepEqual(contactRows(ring, 1, 3, opts()).map(r => r.seq), [1, 2]);
});

let seq = 0;
const contact = (id: string, row: number, strength: number, buy = true, side: 'bid' | 'ask' = 'ask'): ContactRow => ({ id, side, row, usd: 1e5, strength, wall: 1_000, seq: ++seq, buy });
const change = (id: string, row: number, usd: number, strength: number): CueRow => ({ id, side: 'ask', row, usd, strength, wall: 1_000, seq: ++seq, removed: false, added: false, pair: false, band: false });
const flat: Geometry = { rowVisible: () => true, cell: () => ({ x: 0, y: 0, w: 100, h: 10, usd: 5e6 }) };

test('a contact is a quick cue of its own that leaves no mark, takes the taker\'s side and is over in a few hundred ms', () => {
  const board = new CueBoard();
  board.pushContacts([contact('a:BTC', 5, 0.6), contact('b:BTC', 6, 0.5, false, 'bid')]);
  assert.equal(board.waiting, 2);
  board.admit(1_000, 'wash', flat);
  assert.equal(board.active.length, 2); assert.equal(board.marks.size, 0, 'a contact says nothing about the depth, so it marks nothing');
  const [buy, sell] = board.active;
  assert.deepEqual([buy!.kind, buy!.life, buy!.sign, buy!.buy, buy!.side], ['contact', CONTACT_LIFE_MS, 1, true, 'ask']);
  assert.deepEqual([sell!.sign, sell!.buy, sell!.side], [-1, false, 'bid']);
  assert.equal(board.prune(1_000 + CONTACT_LIFE_MS), true); assert.equal(board.prune(1_000 + CONTACT_LIFE_MS + 1), false);
});

test('contacts are lit after the changes and out of the same budget, at 1.5 times a wash of their strength in every look (a contact paints the whole cell), and their shorter life is counted by the light they show', () => {
  const board = new CueBoard({ maxCues: 2, maxArea: 1e9 });
  board.push([change('a:BTC', 5, 1e6, 0.5), change('b:BTC', 6, 1e6, 0.4)]);
  board.pushContacts([contact('c:BTC', 7, 0.99)]);
  board.admit(1_000, 'wash', flat);
  assert.deepEqual(board.active.map(c => c.kind), ['depth', 'depth'], 'the changes took the places: a contact, however strong, comes after them');
  assert.equal(board.stats.turnedDown, 1);
  const cost = new CueBoard();
  cost.push([change('a:BTC', 5, 1e6, 0.5)]); cost.pushContacts([contact('b:BTC', 6, 0.5)]); cost.admit(1_000, 'wash', flat);
  const [d, c] = cost.active;
  assert.ok(Math.abs(c!.cost / d!.cost - CONTACT_WEIGHT) < 1e-9);
  for (const look of ['rim', 'deposit'] as const) {
    const other = new CueBoard();
    other.push([change('a:BTC', 5, 1e6, 0.5)]); other.pushContacts([contact('b:BTC', 6, 0.5)]); other.admit(1_000, look, flat);
    const [x, y] = other.active;
    assert.ok(Math.abs(y!.cost - 100 * 10 * (0.25 + 0.75 * 0.5) * CONTACT_WEIGHT) < 1e-9, `${look}: a contact is not a thin edge`);
    assert.ok(y!.cost > x!.cost, `${look}: it costs more than the change beside it`);
  }
  assert.ok(cost.litArea(1_000 + 400) < cost.used, 'both have run down by then: the area they show is under what they cost at their peaks');
});

test('a contact where one is lit renews it, and the look of marks lights no contact', () => {
  const board = new CueBoard();
  board.pushContacts([contact('a:BTC', 5, 0.3)]); board.admit(1_000, 'wash', flat);
  board.pushContacts([contact('a:BTC', 5, 0.7)]); board.admit(1_200, 'wash', flat);
  assert.equal(board.active.length, 1); assert.equal(board.active[0]!.strength, 0.7); assert.equal(board.active[0]!.t0, 1_200);
  const marks = new CueBoard();
  marks.pushContacts([contact('a:BTC', 5, 0.9)]); marks.admit(1_000, 'marks', flat);
  assert.equal(marks.active.length, 0);
  const weak = new CueBoard();
  weak.pushContacts([contact('a:BTC', 5, 0.001)]); weak.admit(1_000, 'wash', flat);
  assert.equal(weak.active.length, 0, 'too small to see');
});

test('a contact needs the cell it reached to be on screen, and waiting contacts are bounded', () => {
  const board = new CueBoard();
  board.pushContacts([contact('a:BTC', 5, 0.6)]);
  board.admit(1_000, 'wash', { rowVisible: () => false, cell: () => null });
  assert.equal(board.active.length, 0);
  board.pushContacts(Array.from({ length: 600 }, (_, i) => contact('a:BTC', i, 0.5)));
  assert.equal(board.waiting, 256);
  board.clear(); assert.equal(board.waiting, 0);
});
