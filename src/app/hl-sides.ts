/**
 * Hyperliquid's long and short sides by HyperTracker's groups of wallets (the levels service's `sides.rs`, 2026-11-27), for the Long/Short
 * pane.
 *
 * Hyperliquid publishes no long/short ratio, and in coins its two sides are always equal: every contract has a long and a short holder. Each
 * HyperTracker snapshot of every wallet's BTC position (about every 29 minutes, the positions some 35 minutes old) tells how many wallets are
 * long and how many short, and the dollars on each side: for all wallets, and by HyperTracker's own bands of all-time PnL and of size, each
 * wallet in the bands that snapshot gives it. The service keeps a row per snapshot, placed at the moment it fetched it (`fetchedAt`: when a
 * page could first have shown it), a file per UTC day and a rollup of a row per four hours, all under its paid prefix (free while Plus is).
 *
 * In dollars all wallets together are always half long (every long has a short), so that line is not drawn there; the profitable and the
 * losing traders then sit on opposite sides of 50 % by construction. What a line says is who held each side then: not where price goes.
 */
import type { LsPoint } from '../shared/long-short.ts';
import { usd } from './format.ts';
import { t } from './i18n.ts';
import { liqLevelsUrl } from './liq-url.ts';
import { isRefusal, linkedWebFetch, type LiqFetch } from './liq-history.ts';
import { HOLD_PERIODS } from './panes/ls-window.ts';

import type { HlSplit, HlUnit } from './hl-split.ts';

/** `[walletsLong, walletsShort, usdLong, usdShort]`. */
export type HlCell = readonly [number, number, number, number];
/** One snapshot: its times, its mark, all wallets, the eight PnL bands (most profit first) and the eight size bands (smallest first; null when the snapshot's file had none). */
export interface HlRow { asOf: number; createdAt: number; fetchedAt: number; mark: number; all: HlCell; pnl: readonly HlCell[]; size: readonly HlCell[] | null }

const DAY = 86_400_000;
/** A day's rows hold for this long each (a snapshot comes about every 29 minutes): a gap past three of them breaks the line. */
export const HL_PERIOD_MS = 30 * 60_000;
/** The rollup's rows: one per four hours. */
export const HL_ROLLUP_MS = 4 * 3_600_000;
/** Views of up to this many days read the day files (a month is about 900 kB of JSON); wider ones read the rollup. */
export const HL_MAX_DAYS = 31;
/** The day still being written (and the one before, for a while after midnight) is asked again this often; the rollup this often. */
const FRESH_EVERY_MS = 5 * 60_000, ROLLUP_EVERY_MS = 30 * 60_000;
/** A file that could not be read is asked again after this long. */
const FAILED_WAIT_MS = 60_000;
/** Days held at most: the ones farthest from the view go first. */
const DAYS_KEPT = 64;

/** A band: its HyperTracker id and its edges in dollars (null: open). */
export interface HlBand { id: number; lo: number | null; hi: number | null }
/** HyperTracker's all-time PnL bands in the files' order, the most profit first. 8 to 11 are the profitable traders. */
export const PNL_BANDS: readonly HlBand[] = [
  { id: 8, lo: 1e6, hi: null }, { id: 9, lo: 1e5, hi: 1e6 }, { id: 10, lo: 1e4, hi: 1e5 }, { id: 11, lo: 0, hi: 1e4 },
  { id: 12, lo: -1e4, hi: 0 }, { id: 13, lo: -1e5, hi: -1e4 }, { id: 14, lo: -1e6, hi: -1e5 }, { id: 15, lo: null, hi: -1e6 }];
/** HyperTracker's size bands in the files' order, the smallest first (its documentation bands them by perp equity; the files' own equity does not keep to those edges). */
export const SIZE_BANDS: readonly HlBand[] = [
  { id: 16, lo: 0, hi: 250 }, { id: 1, lo: 250, hi: 1e4 }, { id: 2, lo: 1e4, hi: 5e4 }, { id: 3, lo: 5e4, hi: 1e5 },
  { id: 4, lo: 1e5, hi: 5e5 }, { id: 5, lo: 5e5, hi: 1e6 }, { id: 6, lo: 1e6, hi: 5e6 }, { id: 7, lo: 5e6, hi: null }];
const CELL = ['walletsLong', 'walletsShort', 'usdLong', 'usdShort'];

/** The service's files of the long and short sides, beside its levels file (`…/v1/btc/liquidations.json` → `…/v1/plus/btc/…`). */
export function sidesUrls(levelsUrl: string): { day: (day: string) => string; rollup: string } | null {
  const m = /^(.*)\/v1\/([a-z0-9]+)\/liquidations\.json$/.exec(levelsUrl);
  if (!m) return null;
  const base = `${m[1]}/v1/plus/${m[2]}`;
  return { day: day => `${base}/long-short-history/${day}.json`, rollup: `${base}/long-short-history-4h.json` };
}

const cellOf = (raw: unknown): HlCell | null =>
  Array.isArray(raw) && raw.length === 4 && raw.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) ? raw as unknown as HlCell : null;
const cellsOf = (raw: unknown): HlCell[] | null => {
  if (!Array.isArray(raw) || raw.length !== 8) return null;
  const cells = raw.map(cellOf);
  return cells.every(Boolean) ? cells as HlCell[] : null;
};
const sameList = (raw: unknown, want: readonly (string | number)[]): boolean => Array.isArray(raw) && raw.length === want.length && raw.every((v, i) => v === want[i]);

/**
 * A day's or the rollup's rows, checked: the format, the cells and bands in the order this page reads them, and each row's numbers. A row
 * that is not whole is left out; a file of another shape is none (null).
 */
export function readSidesRows(raw: unknown): HlRow[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  if (file.v !== 1 || !sameList(file.cell, CELL) || !sameList(file.pnl, PNL_BANDS.map(b => b.id)) || !sameList(file.size, SIZE_BANDS.map(b => b.id)) || !Array.isArray(file.rows)) return null;
  const rows: HlRow[] = [];
  for (const row of file.rows) {
    if (!Array.isArray(row) || row.length !== 7) continue;
    const [asOf, createdAt, fetchedAt, mark] = row;
    if (![asOf, createdAt, fetchedAt, mark].every(n => typeof n === 'number' && Number.isFinite(n))) continue;
    const all = cellOf(row[4]), pnl = cellsOf(row[5]), size = row[6] === null ? null : cellsOf(row[6]);
    if (!all || !pnl || (row[6] !== null && !size)) continue;
    rows.push({ asOf: asOf as number, createdAt: createdAt as number, fetchedAt: fetchedAt as number, mark: mark as number, all, pnl, size });
  }
  return rows;
}

/** The long share of a cell by wallets or by dollars; null where the side counts hold nothing. */
export function shareOf(cell: HlCell, unit: HlUnit): number | null {
  const long = unit === 'wallets' ? cell[0] : cell[2], short = unit === 'wallets' ? cell[1] : cell[3];
  return long + short > 0 ? long / (long + short) : null;
}

const sum = (cells: readonly HlCell[]): HlCell => {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (const c of cells) for (let k = 0; k < 4; k++) out[k]! += c[k]!;
  return out;
};

/** One of Hyperliquid's lines: which group it is, its place on the ramp, and its readings with the counts behind each. */
export interface HlLine {
  /** `all`, `pos` (+PnL), `neg` (−PnL), or a band: `pnl<id>`, `size<id>`. */
  key: string;
  /** Its step on the ramp: 0 the least (the most loss, the smallest) to 7 the most. */
  rank: number;
  /** Each snapshot's long share, at its `fetchedAt`. */
  points: LsPoint[];
  /** The cell each point was read from. */
  cells: HlCell[];
  periodMs: number;
}

/**
 * Hyperliquid's lines of a split, read from `rows` (oldest first). Everyone, +PnL (bands 8 to 11) and −PnL (12 to 15) by default, everyone
 * left out in dollars (always half long); or each PnL band, or each size band (where a snapshot has them). A snapshot whose group holds no
 * one has no point there.
 */
export function hlLines(rows: readonly HlRow[], split: HlSplit, unit: HlUnit, periodMs: number): HlLine[] {
  if (split === 'off') return [];
  const groups: { key: string; rank: number; of: (r: HlRow) => HlCell | null }[] = split === 'groups'
    ? [
      { key: 'pos', rank: 7, of: r => sum(r.pnl.slice(0, 4)) },
      ...(unit === 'wallets' ? [{ key: 'all', rank: 4, of: (r: HlRow) => r.all }] : []),
      { key: 'neg', rank: 0, of: r => sum(r.pnl.slice(4)) },
    ]
    : split === 'pnl'
      ? PNL_BANDS.map((b, i) => ({ key: `pnl${b.id}`, rank: 7 - i, of: (r: HlRow) => r.pnl[i] ?? null }))
      : SIZE_BANDS.map((b, i) => ({ key: `size${b.id}`, rank: i, of: (r: HlRow) => r.size?.[i] ?? null }));
  return groups.map(({ key, rank, of }) => {
    const points: LsPoint[] = [], cells: HlCell[] = [];
    for (const r of rows) {
      const cell = of(r), long = cell && shareOf(cell, unit);
      if (cell && long !== null) { points.push({ t: r.fetchedAt, long }); cells.push(cell); }
    }
    return { key, rank, points, cells, periodMs };
  });
}

/** The reading of a line in effect at `time` (the last at or before it, while its hold lasts) and the counts behind it. */
export function hlAt(line: Pick<HlLine, 'points' | 'cells' | 'periodMs'>, time: number): { point: LsPoint; cell: HlCell } | null {
  let lo = 0, hi = line.points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (line.points[mid]!.t <= time) lo = mid + 1; else hi = mid; }
  const point = line.points[lo - 1], cell = line.cells[lo - 1];
  return point && cell && time < point.t + HOLD_PERIODS * line.periodMs ? { point, cell } : null;
}

const bandOf = (key: string): HlBand | undefined =>
  key.startsWith('pnl') ? PNL_BANDS.find(b => `pnl${b.id}` === key) : key.startsWith('size') ? SIZE_BANDS.find(b => `size${b.id}` === key) : undefined;
/** Dollars as a band's edge: `$10K`, `−$1M`. */
const money = (v: number): string => `${v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;

/** A line's name in the popup and the table. */
export function hlName(key: string): string {
  if (key === 'all') return t('Everyone');
  if (key === 'pos') return t('+PnL');
  if (key === 'neg') return t('−PnL');
  const band = bandOf(key);
  if (!band) return key;
  if (band.hi === null) return t('{v} and more', { v: money(band.lo ?? 0) });
  if (band.lo === null) return t('{v} and less', { v: money(band.hi) });
  return t('{lo} to {hi}', { lo: money(band.lo), hi: money(band.hi) });
}

/** A line's short tag where it ends on the chart: the group, or the band's edge nearest zero (`+$100K`, `−$10K`, `$250`). */
export function hlTag(key: string): string {
  if (key === 'all') return t('All');
  if (key === 'pos' || key === 'neg') return hlName(key);
  const band = bandOf(key);
  if (!band) return key;
  if (key.startsWith('size')) return money(band.lo ?? 0);
  return (band.lo ?? -1) >= 0 ? `+${money(band.lo ?? 0)}` : `−$${usd(Math.abs(band.hi ?? 0))}`;
}

/**
 * Hyperliquid's lines in one ordered ramp of its blue, from the least (the most loss, the smallest) to the most, each theme's steps checked
 * against its surface (dataviz validator, ordinal: one hue, lightness monotone, steps 0.06 apart): darker is more on a light theme, brighter
 * on a dark one. Everyone stands in the middle of the ramp between the losing and the profitable traders. Identity is never the colour
 * alone: each line's end carries its tag, and the readout, popup and table name it.
 */
export const HL_RAMP: { light: readonly string[]; dark: readonly string[] } = {
  light: ['#7cb4fc', '#669de4', '#5187cc', '#3c71b5', '#265c9e', '#0f4887', '#003371', '#001f5c'],
  dark: ['#2d5289', '#40669e', '#537ab4', '#678fca', '#7ba4e1', '#90baf8', '#a6d0ff', '#bbe7ff'],
};
export const hlColor = (line: Pick<HlLine, 'rank'>, dark: boolean): string => (dark ? HL_RAMP.dark : HL_RAMP.light)[Math.max(0, Math.min(7, line.rank))]!;

/** What the reader holds of one file: its rows, when it was asked, and whether that answer was read. */
interface Held { rows: HlRow[]; at: number; ok: boolean }

const dayText = (day: number): string => new Date(day).toISOString().slice(0, 10);

/**
 * The files the pane reads: a view of up to `HL_MAX_DAYS` days its UTC days (the day before its start too, whose last row holds into it),
 * a wider one the rollup. Each file is asked once at a time; past days are held, the newest two asked again every five minutes and the
 * rollup every thirty, a failed file a minute later. Without a pass while Plus is sold nothing is asked; the gate's refusal stops the asking
 * (nothing is drawn, nothing offered).
 */
export class HlSides {
  #days = new Map<number, Held>();
  #rollup: Held | null = null;
  #asking = new Set<string>();
  #refused = false;
  constructor(private fetch: LiqFetch = linkedWebFetch, private pass: (now: number) => string | null = () => '', private levelsUrl: () => string = liqLevelsUrl) {}

  /** Whether a read is under way. */
  get reading(): boolean { return this.#asking.size > 0; }

  /** Ask for what a view of [t0, t1] needs and is not held fresh as of `now`; `changed` is called when an answer lands. */
  ensure(t0: number, t1: number, now: number, changed: () => void): void {
    const urls = sidesUrls(this.levelsUrl()), pass = this.pass(now);
    if (!urls || pass === null || this.#refused) return;
    if (t1 - t0 > HL_MAX_DAYS * DAY) {
      this.#ask('rollup', urls.rollup, pass, now, ROLLUP_EVERY_MS, this.#rollup, held => { this.#rollup = held; }, changed);
      return;
    }
    const today = Math.floor(now / DAY) * DAY;
    for (let day = Math.floor(t0 / DAY) * DAY - DAY; day <= Math.min(t1, now); day += DAY) {
      this.#ask(`day:${day}`, urls.day(dayText(day)), pass, now, day >= today - DAY ? FRESH_EVERY_MS : Infinity, this.#days.get(day) ?? null, held => { this.#days.set(day, held); }, changed);
    }
    if (this.#days.size > DAYS_KEPT) {
      const mid = (t0 + t1) / 2, far = [...this.#days.keys()].sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
      for (const day of far.slice(0, this.#days.size - DAYS_KEPT)) this.#days.delete(day);
    }
  }

  #ask(key: string, url: string, pass: string, now: number, every: number, held: Held | null, keep: (held: Held) => void, changed: () => void): void {
    if (this.#asking.has(key) || (held && now - held.at < (held.ok ? every : FAILED_WAIT_MS))) return;
    this.#asking.add(key);
    const kept = held?.rows ?? [];
    void this.fetch(url, pass).then(answer => {
      if (isRefusal(answer)) { this.#refused = true; return; }
      const rows = answer.status >= 200 && answer.status < 300 ? readSidesRows(answer.body) : null;
      keep({ rows: rows ?? kept, at: now, ok: rows !== null });
    }, () => keep({ rows: kept, at: now, ok: false })).finally(() => { this.#asking.delete(key); changed(); });
  }

  /** The rows a view of [t0, t1] draws (with those in force at its start), oldest first, once each, and the period they hold for. */
  rows(t0: number, t1: number): { rows: HlRow[]; periodMs: number } {
    if (t1 - t0 > HL_MAX_DAYS * DAY) {
      const from = t0 - HOLD_PERIODS * HL_ROLLUP_MS;
      return { rows: (this.#rollup?.rows ?? []).filter(r => r.fetchedAt >= from && r.fetchedAt <= t1), periodMs: HL_ROLLUP_MS };
    }
    const from = t0 - HOLD_PERIODS * HL_PERIOD_MS, seen = new Set<number>(), rows: HlRow[] = [];
    for (let day = Math.floor(t0 / DAY) * DAY - DAY; day <= t1; day += DAY) {
      for (const r of this.#days.get(day)?.rows ?? []) {
        if (r.fetchedAt < from || r.fetchedAt > t1 || seen.has(r.createdAt)) continue;
        seen.add(r.createdAt); rows.push(r);
      }
    }
    rows.sort((a, b) => a.fetchedAt - b.fetchedAt);
    return { rows, periodMs: HL_PERIOD_MS };
  }
}
