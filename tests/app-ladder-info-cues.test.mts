import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText, byPublication, cueLines, gutterLines, latestRowChange, levelLines, smallerVenuesLines, venueCellLines, type ChangeFact, type LevelFacts } from '../src/app/panes/ladder-info.ts';
import { rowEvents, type CueEvent } from '../src/app/panes/book-cues.ts';

let seq = 0;
const event = (lo: number, usd: number, extra: Partial<CueEvent> = {}): CueEvent => ({ id: 'binance:BTCUSDT', side: 'ask', lo, hi: lo + 20, grid: 20, sign: usd > 0 ? 1 : -1, usd, before: 5e6, after: 5e6 + usd, strength: 0.5, wall: 10_000, seq: ++seq, pub: 1, prevWall: 9_000,
  removed: false, added: false, pair: false, approx: false, band: false, confirmed: false, ...extra });

const facts = (extra: Partial<LevelFacts> = {}): LevelFacts => ({ low: 81_000, step: 50, mark: 81_040, ask: false, size: 12e6, cumulative: 30e6, venues: [{ name: 'Binance BTCUSDT', usd: 8e6, id: 'binance:BTCUSDT' }, { name: 'OKX BTC-USDT', usd: 4e6, id: 'okx:BTC-USDT' }], ...extra });
const change = (extra: Partial<ChangeFact> = {}): ChangeFact => ({ name: 'Binance BTCUSDT', id: 'binance:BTCUSDT', usd: 2.4e6, ageMs: 1_200, removed: false, pair: false, ...extra });

test('the figure the pointer reads for a row is the one its cell was lit with: the sum of what changed together in it, shared as the light shared it', () => {
  const together = [event(81_000, 1e6, { seq: 1 }), event(81_020, 2e6, { seq: 2 }), event(81_040, -0.5e6, { seq: 3 })];
  const row = latestRowChange([together], 810, 100, 1.5e6)!;
  assert.equal(row.usd, 2.5e6, 'three bins of one publication in one $100 row: their sum, not the newest one');
  assert.deepEqual(row, rowEvents(together, 100, 1.5e6).find(r => r.row === 810)!, 'the very row the cue was made from');
  assert.equal(row.wall, 10_000); assert.equal(row.prevWall, 9_000);
  const half = latestRowChange([[event(81_020, 1e6)]], 8_102, 10, 1.5e6)!;
  assert.equal(half.usd, 0.5e6, 'a $20 bin under $10 rows lights both rows with half, as the ladder itself shows it');
  assert.equal(latestRowChange([[event(81_020, 1e6)]], 8_104, 10, 1.5e6), null, 'a row the event did not reach');
  assert.equal(latestRowChange([], 810, 100, 1.5e6), null);
  const band = event(80_000, 1e6, { hi: 81_000, grid: 0, band: true });
  const fine = latestRowChange([[band]], 809_000, 0.1, 1.5e6)!;
  assert.ok(fine && Math.abs(fine.usd - 1e6 * 0.1 / 1_000) < 1e-6, 'a band a thousand dollars wide at Group $0.1: the row asked about gets its share, not null from a projection cut short');
});

test('what traded around a change is said beside it where the tape says, and nothing is said where it does not', () => {
  const beside = cueLines({ ask: true, changes: [change({ usd: -1.5e6, removed: true, traded: 1.1e6 })] });
  assert.equal(beside[0]!.text, '−$1.5M · emptied · 1 s ago · $1.1M traded');
  assert.ok(beside.some(l => /^Traded: market orders that reached this row/.test(l.text) && /does not say how much of the change/.test(l.text)), 'said once what it counts, and that it explains nothing by itself');
  const none = cueLines({ ask: true, changes: [change({ usd: -1.5e6, traded: 0 })] });
  assert.equal(none[0]!.text, '−$1.5M · 1 s ago · none traded');
  const unknown = cueLines({ ask: true, changes: [change({ usd: -1.5e6 })] });
  assert.equal(unknown[0]!.text, '−$1.5M · 1 s ago'); assert.ok(!unknown.some(l => /^Traded:/.test(l.text)), 'the tape does not say: nothing said, not "none"');
});

test('a newer publication that changed only a neighbouring row of the bin does not erase a row\'s last change', () => {
  // two $10 rows in one bin: the older publication changed both (+$2M and -$500K at their prices), the newer only the first (+$1M)
  const older = event(81_020, 1.5e6, { wall: 10_000, seq: 1, pub: 1, lv: { prev: [81_021, 1e6, 81_031, 1e6], cur: [81_021, 3e6, 81_031, 0.5e6] } });
  const newer = event(81_020, 1e6, { wall: 12_000, seq: 2, pub: 2, lv: { prev: [81_021, 3e6, 81_031, 0.5e6], cur: [81_021, 4e6, 81_031, 0.5e6] } });
  const groups = byPublication([newer, older]);
  assert.equal(groups.length, 2); assert.deepEqual(byPublication([older, event(81_040, 1e5, { wall: 10_000, seq: 3, pub: 1 })]).map(g => g.length), [2], 'events of one publication stay together');
  assert.equal(latestRowChange(groups, 8_102, 10, 1.5e6)!.usd, 1e6, 'the first row: its newest change');
  assert.equal(latestRowChange(groups, 8_103, 10, 1.5e6)!.usd, -0.5e6, 'the second row was not touched by the newer publication: the older one\'s change stands');
});

test('how long ago reads as a person says it', () => {
  assert.equal(agoText(0), 'just now'); assert.equal(agoText(999), 'just now');
  assert.equal(agoText(1_000), '1 s ago'); assert.equal(agoText(4_400), '4 s ago'); assert.equal(agoText(59_000), '59 s ago');
  assert.equal(agoText(60_000), '1 min ago'); assert.equal(agoText(125_000), '2 min ago');
});

test('a change says its size with the sign, how long ago, and what it is not', () => {
  const lines = cueLines({ ask: false, changes: [change(), change({ usd: -1e6, ageMs: 9_000, name: 'OKX BTC-USDT', id: 'okx:BTC-USDT' })] });
  assert.equal(lines[0]!.label, 'Last change'); assert.equal(lines[0]!.text, '+$2.4M · 1 s ago'); assert.equal(lines[0]!.mark, 'binance:BTCUSDT'); assert.equal(lines[0]!.rule, true); assert.equal(lines[0]!.color, 'below');
  assert.equal(lines[1]!.label, ''); assert.equal(lines[1]!.text, '−$1M · 9 s ago'); assert.equal(lines[1]!.mark, 'okx:BTC-USDT'); assert.equal(lines[1]!.rule, false);
  const last = lines[lines.length - 1]!;
  assert.match(last.text, /not an order/); assert.equal(last.wrap, true); assert.equal(last.color, 'muted');
  assert.equal(cueLines({ ask: true, changes: [change()] })[0]!.color, 'above', 'an ask is in the asks\' colour');
});

test('a cell that emptied, a pair and a limit of lines are said', () => {
  const emptied = cueLines({ ask: true, changes: [change({ usd: -5e6, removed: true })] });
  assert.equal(emptied[0]!.text, '−$5M · emptied · 1 s ago');
  const paired = cueLines({ ask: true, changes: [change({ pair: true })] });
  assert.ok(paired.some(l => /went the other way, by about the same size/.test(l.text)));
  assert.ok(!paired.some(l => /re-quote|requote|probably/i.test(l.text)), 'it names no cause: the book does not say whether it is one order moving, a row\'s edge crossed, or two');
  const many = cueLines({ ask: false, changes: [1, 2, 3, 4, 5].map(i => change({ ageMs: i * 1_000 })) });
  assert.equal(many.filter(l => /\$/.test(l.text) && /ago/.test(l.text)).length, 3, 'three by default');
  assert.equal(cueLines({ ask: false, changes: [1, 2, 3, 4, 5].map(i => change({ ageMs: i * 1_000 })) }, 5).filter(l => /ago/.test(l.text)).length, 5);
});

test('nothing changed and no heat: no lines', () => {
  assert.deepEqual(cueLines({ ask: false }), []);
  assert.deepEqual(cueLines({ ask: false, changes: [] }), []);
  assert.deepEqual(cueLines({ ask: false, heat: { kind: 'added', fresh: 0, unknown: 0, activity: 0 } }), []);
});

test('the heat says what it is a share of, and that a cell without history is not known yet', () => {
  const added = cueLines({ ask: false, heat: { kind: 'added', fresh: 0.37, unknown: 0.1, activity: 0.9 } });
  assert.deepEqual([added[0]!.label, added[0]!.text, added[0]!.rule], ['Recent adds', '37%', true]);
  assert.equal(added.length, 1);
  const active = cueLines({ ask: false, heat: { kind: 'activity', fresh: 0.37, unknown: 0.1, activity: 0.9 } });
  assert.deepEqual([active[0]!.label, active[0]!.text], ['Recent change', '90%']);
  const unknown = cueLines({ ask: false, heat: { kind: 'added', fresh: 0, unknown: 0.9, activity: 0 } });
  assert.ok(unknown.some(l => /first snapshot/.test(l.text)));
  const both = cueLines({ ask: false, changes: [change()], heat: { kind: 'added', fresh: 0.5, unknown: 0, activity: 0 } });
  assert.equal(both.find(l => l.label === 'Recent adds')!.rule, false, 'the rule is above the first group only');
});

test('the popups for a level, a venue\'s part and the smaller venues carry the changes; the gutter\'s popup stands alone', () => {
  const f = facts({ changes: [change()] });
  assert.ok(levelLines(f).some(l => l.label === 'Last change'));
  assert.ok(venueCellLines(f, f.venues[0]!).some(l => l.label === 'Last change'));
  assert.ok(smallerVenuesLines(f, f.venues).some(l => l.label === 'Last change'));
  assert.ok(!levelLines(facts()).some(l => l.label === 'Last change'), 'no change, no line');
  const venueLast = venueCellLines(facts({ changes: [change()] }), f.venues[0]!);
  assert.equal(venueLast[venueLast.length - 1]!.label, 'All venues here', 'the level\'s total stays last');
  const gutter = gutterLines({ low: 81_000, step: 50, mark: 81_040, ask: false, changes: [change({ removed: true, usd: -3e6 })], title: 'Binance BTCUSDT' });
  assert.equal(gutter[0]!.text, 'Binance BTCUSDT'); assert.ok(gutter.some(l => l.label === 'Price') && gutter.some(l => l.label === 'Distance') && gutter.some(l => /emptied/.test(l.text)));
  assert.equal(gutterLines({ low: 1, step: 1, mark: 1, ask: true, changes: [] })[0]!.text, 'Order book level');
});
