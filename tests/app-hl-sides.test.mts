import test from 'node:test';
import assert from 'node:assert/strict';
import { HL_MAX_DAYS, HL_PERIOD_MS, HL_RAMP, HL_ROLLUP_MS, HlSides, hlAt, hlColor, hlLines, hlName, hlTag, readSidesRows, shareOf, sidesUrls, type HlCell, type HlRow } from '../src/app/hl-sides.ts';
import type { LiqAnswer } from '../src/app/liq-history.ts';
import { placeEnds } from '../src/app/panes/ls-window.ts';
import { hlCardLines, hlTableRows } from '../src/app/panes/ls-pane.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** 2026-11-15T00:00:00Z. */
const D = 1_794_700_800_000;
const LEVELS = 'https://levels.example/v1/btc/liquidations.json';
const HEAD = { v: 1, coin: 'BTC', cell: ['walletsLong', 'walletsShort', 'usdLong', 'usdShort'], pnl: [8, 9, 10, 11, 12, 13, 14, 15], size: [16, 1, 2, 3, 4, 5, 6, 7] };

/** A row fetched at `at`: band i of PnL has i + 1 long and 1 short wallets, $100 a wallet; size band i the same, reversed. */
function row(at: number, size = true): unknown[] {
  const band = (i: number): number[] => [i + 1, 1, 100 * (i + 1), 100];
  const pnl = Array.from({ length: 8 }, (_, i) => band(i));
  return [at - 41 * MIN, at - 6 * MIN, at, 90_000.5, [36 + 4, 8 + 4, 3_600 + 400, 800 + 400], pnl, size ? pnl.slice().reverse() : null];
}
const file = (day: string, rows: unknown[][]): unknown => ({ ...HEAD, day, rows });

test('a file is read when its cells and bands are in the order the page reads, a broken row is left out', () => {
  const rows = readSidesRows(file('2026-11-15', [row(D + HOUR), [1, 2, 3], row(D + 2 * HOUR, false)]))!;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.all, [40, 12, 4_000, 1_200]);
  assert.equal(rows[1]!.size, null);
  assert.equal(readSidesRows({ ...HEAD, pnl: [15, 14, 13, 12, 11, 10, 9, 8], rows: [] }), null, 'bands in another order');
  assert.equal(readSidesRows({ ...HEAD, v: 2, rows: [] }), null);
  assert.equal(readSidesRows(null), null);
  const negative = row(D + HOUR); (negative[4] as number[])[0] = -1;
  assert.deepEqual(readSidesRows(file('2026-11-15', [negative])), []);
});

test('the default lines are the profitable traders, everyone and the losing traders; in dollars everyone is left out', () => {
  const rows = readSidesRows(file('2026-11-15', [row(D + HOUR), row(D + 2 * HOUR)]))!;
  const lines = hlLines(rows, 'groups', 'wallets', HL_PERIOD_MS);
  assert.deepEqual(lines.map(l => l.key), ['pos', 'all', 'neg']);
  // +PnL: bands 8 to 11 (1+2+3+4 long, 4 short); -PnL: bands 12 to 15 (5+6+7+8 long, 4 short).
  assert.equal(lines[0]!.points[0]!.long, 10 / 14);
  assert.equal(lines[1]!.points[0]!.long, 40 / 52);
  assert.equal(lines[2]!.points[0]!.long, 26 / 30);
  assert.deepEqual(lines[0]!.cells[0], [10, 4, 1_000, 400]);
  assert.deepEqual(lines.map(l => l.rank), [7, 4, 0]);
  assert.deepEqual(lines[0]!.points.map(p => p.t), [D + HOUR, D + 2 * HOUR], 'placed at fetchedAt');
  const dollars = hlLines(rows, 'groups', 'usd', HL_PERIOD_MS);
  assert.deepEqual(dollars.map(l => l.key), ['pos', 'neg']);
  assert.equal(dollars[0]!.points[0]!.long, 1_000 / 1_400);
  assert.deepEqual(hlLines(rows, 'off', 'wallets', HL_PERIOD_MS), [], 'switched off: no line');
});

test('by PnL the most profit is the top of the ramp; by size the largest; a snapshot without size bands has no point there', () => {
  const rows = readSidesRows(file('2026-11-15', [row(D + HOUR), row(D + 2 * HOUR, false)]))!;
  const pnl = hlLines(rows, 'pnl', 'wallets', HL_PERIOD_MS);
  assert.deepEqual(pnl.map(l => l.key), ['pnl8', 'pnl9', 'pnl10', 'pnl11', 'pnl12', 'pnl13', 'pnl14', 'pnl15']);
  assert.deepEqual(pnl.map(l => l.rank), [7, 6, 5, 4, 3, 2, 1, 0]);
  assert.equal(pnl[0]!.points.length, 2);
  const size = hlLines(rows, 'size', 'wallets', HL_PERIOD_MS);
  assert.deepEqual(size.map(l => l.key), ['size16', 'size1', 'size2', 'size3', 'size4', 'size5', 'size6', 'size7']);
  assert.deepEqual(size.map(l => l.rank), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(size[0]!.points.length, 1);
  // A group that holds no one has no reading, never 50 %.
  assert.equal(shareOf([0, 0, 0, 0] as HlCell, 'wallets'), null);
});

test('a reading holds until the next, or three periods when none follows', () => {
  const rows = readSidesRows(file('2026-11-15', [row(D + HOUR), row(D + 3 * HOUR)]))!;
  const [line] = hlLines(rows, 'groups', 'wallets', HL_PERIOD_MS);
  assert.equal(hlAt(line!, D + HOUR - 1), null);
  assert.deepEqual(hlAt(line!, D + HOUR + 89 * MIN)?.cell, [10, 4, 1_000, 400]);
  assert.equal(hlAt(line!, D + HOUR + 91 * MIN), null, 'a gap past three periods breaks the line');
  assert.ok(hlAt(line!, D + 3 * HOUR));
});

test('names and tags: the groups, and the bands by their edges in dollars', () => {
  assert.equal(hlName('pos'), '+PnL');
  assert.equal(hlName('neg'), '−PnL');
  assert.equal(hlName('pnl8'), '$1M and more');
  assert.equal(hlName('pnl13'), '−$100K to −$10K');
  assert.equal(hlName('pnl15'), '−$1M and less');
  assert.equal(hlName('size16'), '$0 to $250');
  assert.equal(hlName('size7'), '$5M and more');
  assert.deepEqual(['pnl8', 'pnl11', 'pnl12', 'pnl13', 'pnl15'].map(hlTag), ['+$1M', '+$0', '−$0', '−$10K', '−$1M']);
  assert.deepEqual(['size16', 'size1', 'size7'].map(hlTag), ['$0', '$250', '$5M']);
});

test('the ramp runs from the least to the most on either theme', () => {
  assert.equal(hlColor({ rank: 0 }, false), HL_RAMP.light[0]);
  assert.equal(hlColor({ rank: 7 }, true), HL_RAMP.dark[7]);
  assert.equal(hlColor({ rank: 9 }, false), HL_RAMP.light[7]);
  assert.equal(sidesUrls(LEVELS)!.rollup, 'https://levels.example/v1/plus/btc/long-short-history-4h.json');
  assert.equal(sidesUrls(LEVELS)!.day('2026-11-15'),'https://levels.example/v1/plus/btc/long-short-history/2026-11-15.json');
  assert.equal(sidesUrls('https://levels.example/other.json'), null);
});

/** A reader over a fake server: what was asked, and what each address answers. */
function rig(answers: (url: string) => LiqAnswer, pass: (now: number) => string | null = () => '') {
  const asked: string[] = [];
  let release: () => void = () => {};
  const landed = new Promise<void>(resolve => { release = resolve; });
  const fetch = async (url: string): Promise<LiqAnswer> => { asked.push(url); return answers(url); };
  const reader = new HlSides(fetch, pass, () => LEVELS);
  return { reader, asked, landed, release };
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('a view of days asks each day and the one before, holds past days, and asks the newest again after five minutes', async () => {
  const now = D + 12 * HOUR;
  const { reader, asked } = rig(url => ({ status: 200, body: file(url.slice(-15, -5), [row(Date.parse(`${url.slice(-15, -5)}T01:00:00Z`))]) }));
  let changes = 0;
  reader.ensure(D - DAY + HOUR, now, now, () => { changes++; });
  await settle();
  assert.deepEqual(asked.map(u => u.slice(-15, -5)), ['2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(changes, 3);
  const { rows, periodMs } = reader.rows(D - DAY + HOUR, now);
  assert.equal(periodMs, HL_PERIOD_MS);
  assert.deepEqual(rows.map(r => r.fetchedAt), [D - DAY + HOUR, D + HOUR], 'in the view, with the one in force at its start');
  // A minute later nothing is asked; five minutes later the newest two days again, never the day before them.
  reader.ensure(D - DAY + HOUR, now, now + MIN, () => {});
  assert.equal(asked.length, 3);
  reader.ensure(D - DAY + HOUR, now + 5 * MIN, now + 5 * MIN, () => {});
  await settle();
  assert.deepEqual(asked.slice(3).map(u => u.slice(-15, -5)), ['2026-11-14', '2026-11-15']);
});

test('a wide view reads the rollup, a refusal stops the asking, and without a pass nothing is asked', async () => {
  const now = D + 12 * HOUR, wide = { t0: now - (HL_MAX_DAYS + 1) * DAY, t1: now };
  const rolled = rig(() => ({ status: 200, body: { ...HEAD, hours: 4, rows: [row(now - 10 * DAY), row(now - 2 * HOUR)] } }));
  rolled.reader.ensure(wide.t0, wide.t1, now, () => {});
  await settle();
  assert.deepEqual(rolled.asked, ['https://levels.example/v1/plus/btc/long-short-history-4h.json']);
  const got = rolled.reader.rows(wide.t0, wide.t1);
  assert.equal(got.periodMs, HL_ROLLUP_MS);
  assert.equal(got.rows.length, 2);
  const refused = rig(() => ({ status: 403, body: { error: 'plus_required' } }));
  refused.reader.ensure(now - HOUR, now, now, () => {});
  await settle();
  const first = refused.asked.length;
  refused.reader.ensure(now - HOUR, now, now + HOUR, () => {});
  assert.equal(refused.asked.length, first, 'nothing more after the refusal');
  const member = rig(() => ({ status: 200, body: file('x', []) }), () => null);
  member.reader.ensure(now - HOUR, now, now, () => {});
  assert.deepEqual(member.asked, []);
  // A failed file is asked again a minute later, its rows kept.
  let fail = false;
  const flaky = rig(url => fail ? { status: 503, body: null } : { status: 200, body: file(url.slice(-15, -5), [row(D + HOUR)]) });
  flaky.reader.ensure(D, D + 2 * HOUR, D + 2 * HOUR, () => {});
  await settle();
  fail = true;
  flaky.reader.ensure(D, D + 2 * HOUR, D + 8 * HOUR, () => {});
  await settle();
  assert.equal(flaky.reader.rows(D, D + 2 * HOUR).rows.length, 1, 'kept through a failed read');
  const before = flaky.asked.length;
  flaky.reader.ensure(D, D + 2 * HOUR, D + 8 * HOUR + 30_000, () => {});
  assert.equal(flaky.asked.length, before, 'not within the minute');
  flaky.reader.ensure(D, D + 2 * HOUR, D + 8 * HOUR + 61_000, () => {});
  assert.ok(flaky.asked.length > before);
  const rows: HlRow[] = flaky.reader.rows(D, D + 2 * HOUR).rows;
  assert.equal(rows[0]!.createdAt, D + HOUR - 6 * MIN);
});

test('end marks and tags stay inside a short pane; where they cannot all fit, the most crowded tags give way', () => {
  // A 120 px pane: about 81 px between the top and bottom limits, room for six 14 px slots.
  const ends = [
    { id: 'bitget', x: 500, y: 10 }, { id: 'okx', x: 500, y: 24 }, { id: 'binance', x: 500, y: 26 }, { id: 'bybit', x: 500, y: 28 },
    { id: 'gate', x: 500, y: 40 }, { id: 'hl', x: 500, y: 25, tag: '-PnL' }, { id: 'hl', x: 500, y: 45, tag: 'All' }, { id: 'hl', x: 500, y: 87, tag: '+PnL' },
  ];
  const placed = placeEnds(ends, 6, 87);
  assert.equal(placed.length, 6, 'two tags give way');
  assert.deepEqual(placed.filter(e => e.tag).map(e => e.tag), ['+PnL'], 'the tags in the crowd go first; the lone one at the bottom stays');
  for (const e of placed) assert.ok(e.y >= 6 && e.y <= 87, `${e.id} at ${e.y}`);
  const ys = placed.map(e => e.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i]! - ys[i - 1]! >= 14 - 1e-9, `${ys}`);
  // Room for all: none dropped, and a stack that ran past the bottom is lifted back inside it.
  const lifted = placeEnds([{ x: 0, y: 80 }, { x: 0, y: 82 }, { x: 0, y: 84, tag: 'All' }], 6, 87);
  assert.deepEqual(lifted.map(e => e.y), [59, 73, 87]);
  // Ends far apart in time are not pushed apart.
  assert.deepEqual(placeEnds([{ x: 0, y: 50 }, { x: 300, y: 52 }], 6, 87).map(e => e.y), [50, 52]);
});

test('the popup names each Hyperliquid line with its share and the wallets or dollars behind it, and says what they count', () => {
  const rows = readSidesRows(file('2026-11-15', [row(D + HOUR)]))!;
  const at = D + HOUR + 10 * MIN;
  const wallets = hlCardLines(hlLines(rows, 'groups', 'wallets', HL_PERIOD_MS), at, 'wallets');
  assert.deepEqual(wallets.slice(0, 3).map(l => l.label), ['Hyperliquid +PnL', 'Hyperliquid Everyone', 'Hyperliquid −PnL']);
  assert.equal(wallets[0]!.text, '71.4% long · 28.6% short · L/S 2.50 · 10 long, 4 short');
  assert.equal(wallets[0]!.color, 'buy');
  assert.ok(wallets.every(l => l.table === false), 'the table carries the rows; the notes stay with the help');
  assert.match(wallets[3]!.text, /^Hyperliquid: every wallet's BTC position in HyperTracker's snapshots/);
  assert.equal(wallets.length, 4);
  const dollars = hlCardLines(hlLines(rows, 'groups', 'usd', HL_PERIOD_MS), at, 'usd');
  assert.deepEqual(dollars.slice(0, 2).map(l => l.label), ['Hyperliquid +PnL', 'Hyperliquid −PnL']);
  assert.equal(dollars[0]!.text, '71.4% long · 28.6% short · L/S 2.50 · $1K long, $400 short');
  assert.match(dollars[dollars.length - 1]!.text, /^In dollars every long has a short/);
  // A band by its range; a moment past the hold has no reading.
  const bands = hlCardLines(hlLines(rows, 'pnl', 'wallets', HL_PERIOD_MS), D + 5 * HOUR, 'wallets');
  assert.equal(bands[0]!.label, '$1M and more');
  assert.equal(bands[0]!.text, 'no reading');
  assert.deepEqual(hlCardLines([], at, 'wallets'), []);
  const PALETTE = { bid: '#00ff00', ask: '#ff0000', text: '#000000', muted: '#888888' };
  const table = hlTableRows(hlLines(rows, 'groups', 'wallets', HL_PERIOD_MS), at, PALETTE);
  assert.deepEqual(table[0]!.map(c => c.text), ['Hyperliquid +PnL', '71.4%', '28.6%', '2.50']);
  assert.deepEqual(hlTableRows(hlLines(rows, 'groups', 'wallets', HL_PERIOD_MS), D, PALETTE)[0]!.map(c => c.text), ['Hyperliquid +PnL', '–', '–', '–']);
});
