import type { FlowSeries } from '../../shared/flow.ts';
import type { FlowBook } from '../flow-book.ts';
import type { Kind } from '../scope.ts';
import type { FlowTrack } from './track.ts';
import { buildFamilies, type Family } from './families.ts';
import { Ranker, pickTop, quiet, rankAll, type RankInput } from './rank.ts';
import { RANK_MS, type CvdSettings } from './settings.ts';

/** A lane's figures over the ranking window in one unit: buy minus sell, buy plus sell, buy and sell. */
export interface LaneFigures { delta: number; gross: number; buy: number; sell: number }

/**
 * One line of the column: a lane's running delta over the window, a value per pixel column.
 *
 * Units (units.ts, issue 9): the line itself (`lo`, `hi`, `last`, `min`, `max`, `before`) is only drawn and read out, so it is made in the
 * page's units: from the lane's coin track on a model built with `coins` (each second's dollars over that second's own volume-weighted price,
 * each minute's over its last price before the seconds begin: `FlowBook.track`). The figures over the ranking window stay dollars, which the
 * judgments read (the divergence note, the ranking, the quiet flag), with their coins beside them (`coins`) for the labels; `series` stays the
 * dollars' series, which the line's end flash and its wave are judged on.
 */
export interface LaneLine extends LaneFigures {
  /** The instrument (empty for an aggregate). */
  id: string; kind: Kind; series: FlowSeries | null;
  /** Per pixel column: the lowest, highest and last running delta inside it, NaN where the series holds nothing yet (in the page's units). */
  lo: Float64Array; hi: Float64Array; last: Float64Array;
  /** The range of all of the above (NaN when the line has no value), for scaling. */
  min: number; max: number;
  /** The running delta as it stood just before the window's left edge (0 for a line that began inside it): what a line drawn without rebasing has behind it. */
  before?: number;
  /** The figures over the ranking window in coins, on a model built with `coins` (what its labels write then); the lane's own are dollars. */
  coins?: LaneFigures;
  /** Nothing traded in the last five completed minutes. */
  quiet: boolean;
}
/** `gross` is the ranking's dollars; `coins` its coins (its lanes' added up), on a model built with `coins`. */
export interface FamilyRow { key: string; rank: number; share: number; gross: number; quiet: boolean; lanes: LaneLine[]; coins?: { gross: number } }
/** What a label writes of a lane over the ranking window: its coins on a model built in coins, else its dollars. */
export const laneFigures = (lane: LaneLine): LaneFigures => lane.coins ?? lane;
export interface CvdModel {
  /** The window drawn, in ms, and the number of pixel columns across it. */
  t0: number; t1: number; columns: number;
  /** The ranking window in seconds, and the instant (whole seconds) it ends at. */
  rankSec: number; nowSec: number;
  rows: FamilyRow[];
  /** Every spot lane added together, and every perpetual lane: the top row. */
  spot: LaneLine | null; perp: LaneLine | null;
  /** How many instruments are in the aggregate, and how many exchanges have traded in the window but are not shown (past the top N). */
  instruments: number; hidden: number;
  /** The instruments the two aggregate lines are made of (the first spot and the first perpetual market of every exchange with flow), for the figures that must agree with them. */
  counted: string[];
}

export interface ModelInput {
  flow: FlowBook;
  /** The instruments that count: enabled venues inside the Spot / Perp filter. Those without flow are skipped. */
  ids: readonly string[];
  kindOf: (id: string) => Kind | null;
  t0: number; t1: number; columns: number; now: number;
  settings: CvdSettings;
  ranker: Ranker;
  /** Draw the lines in coins and give the labels' figures their coins (units.ts): the page writes sizes in coins. */
  coins?: boolean;
}

const nan = (n: number): Float64Array => new Float64Array(n).fill(NaN);
const range = (...arrays: Float64Array[]): { min: number; max: number } => {
  let min = Infinity, max = -Infinity;
  for (const a of arrays) for (let i = 0; i < a.length; i++) { const v = a[i]!; if (v === v) { if (v < min) min = v; if (v > max) max = v; } }
  return min <= max ? { min, max } : { min: NaN, max: NaN };
};

/**
 * The families the ALL VENUES lines are made of: those of the instruments with flow, and also those that have only older minutes (nothing
 * traded in the last day), whose part of a window reaching back to them would otherwise be left out. Those with seconds come first, so one
 * never takes the place of a market that trades now. The Delta pane adds up the same instruments, so the two never disagree.
 */
export function aggregateFamilies(flow: FlowBook, ids: readonly string[], kindOf: (id: string) => Kind | null): { withFlow: string[]; olderOnly: string[]; families: Family[]; aggregate: Family[] } {
  const withFlow = ids.filter(id => { const s = flow.get(id); return s !== undefined && !s.empty; }), active = new Set(withFlow);
  const families = buildFamilies(withFlow, kindOf);
  const olderOnly = ids.filter(id => !active.has(id) && flow.track(id)?.first != null);
  return { withFlow, olderOnly, families, aggregate: olderOnly.length ? buildFamilies([...withFlow, ...olderOnly], kindOf) : families };
}

/** The instruments of the ALL VENUES lines, spot and perpetual together (one of each kind per exchange). */
export const aggregateIds = (flow: FlowBook, ids: readonly string[], kindOf: (id: string) => Kind | null): string[] =>
  aggregateFamilies(flow, ids, kindOf).aggregate.flatMap(f => f.lanes.map(l => l.id));

/** A series' figures over whole seconds [from, to]. */
function figures(series: FlowSeries, from: number, to: number): LaneFigures {
  const delta = series.delta(from, to), gross = series.gross(from, to);
  return { delta, gross, buy: (gross + delta) / 2, sell: (gross - delta) / 2 };
}

/**
 * A lane's line over [t0, t1) from its track (its seconds, and its minutes before them; in the page's units): the running delta from the
 * window's left edge (or as it stands, with `rebase` off), and its figures over the rank window from its seconds (dollars, and with `coins`,
 * the coin series' beside them).
 */
function laneLine(id: string, kind: Kind, series: FlowSeries, track: FlowTrack, o: { t0Sec: number; t1Sec: number; columns: number; winStart: number; nowSec: number; now: number; rebase: boolean; quietFlag: boolean }, coins?: FlowSeries): LaneLine {
  const out = new Float64Array(o.columns * 3);
  track.decimate(o.t0Sec, o.t1Sec, o.columns, out);
  const edge = track.cumDelta(o.t0Sec - 1), base = o.rebase ? edge : 0, before = track.first !== null && track.first <= o.t0Sec - 1 ? edge : 0;
  const lo = new Float64Array(o.columns), hi = new Float64Array(o.columns), last = new Float64Array(o.columns);
  for (let c = 0; c < o.columns; c++) { lo[c] = out[c * 3]! - base; hi[c] = out[c * 3 + 1]! - base; last[c] = out[c * 3 + 2]! - base; }
  const r = range(lo, hi);
  const delta = series.delta(o.winStart, o.nowSec), gross = series.gross(o.winStart, o.nowSec);
  const line: LaneLine = { id, kind, series, lo, hi, last, ...r, before, delta, gross, buy: (gross + delta) / 2, sell: (gross - delta) / 2, quiet: o.quietFlag && quiet((a, b) => series.gross(a, b), o.now) };
  if (coins) line.coins = figures(coins, o.winStart, o.nowSec);
  return line;
}

/**
 * Everything the column draws, worked out from the flow book: the families ranked over the ranking window (held steady by the ranker),
 * a line per lane, and the two aggregate lines. No canvas and no DOM, so it is tested alone.
 */
export function buildModel({ flow, ids, kindOf, t0, t1, columns, now, settings, ranker, coins = false }: ModelInput): CvdModel {
  const nowSec = Math.floor(now / 1000), rankSec = Math.round(RANK_MS[settings.rank] / 1000), winStart = nowSec - rankSec + 1;
  const t0Sec = Math.floor(t0 / 1000), t1Sec = Math.max(t0Sec + 1, Math.ceil(t1 / 1000));
  // The aggregate lines also count an instrument that has only older minutes (see aggregateFamilies).
  const { withFlow, olderOnly, families, aggregate: aggregated } = aggregateFamilies(flow, ids, kindOf);
  const common = { t0Sec, t1Sec, columns, winStart, nowSec, now, rebase: settings.rebase, quietFlag: settings.quietFlag };

  const grossOf = (family: Family, kind: Kind): number => { const lane = family.lanes.find(l => l.kind === kind); return lane ? flow.get(lane.id)!.gross(winStart, nowSec) : 0; };
  const inputs: RankInput[] = families.map(family => ({
    family, spot: grossOf(family, 'spot'), perp: grossOf(family, 'perp'),
    quiet: settings.quietFlag && quiet((a, b) => family.lanes.reduce((sum, lane) => sum + flow.get(lane.id)!.gross(a, b), 0), now),
  }));
  const top = settings.top > 0 ? settings.top : null;
  const everyone = rankAll(inputs), fresh = pickTop(everyone, { top, pin: settings.pinned });
  const held = ranker.apply(now, fresh, everyone);
  // The ranking (and the share and quiet flag beside it) is the dollars'; a row's figure of what it traded is written in coins in coin mode.
  const rows: FamilyRow[] = held.map((r, i) => {
    const lanes = [...r.family.lanes].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'spot' ? -1 : 1)).map(lane => laneLine(lane.id, lane.kind, flow.get(lane.id)!, flow.track(lane.id, coins)!, common, coins ? flow.coinsOf(lane.id) : undefined));
    const row: FamilyRow = { key: r.family.key, rank: i + 1, share: r.share, gross: r.gross, quiet: r.quiet, lanes };
    if (coins) row.coins = { gross: lanes.reduce((sum, lane) => sum + (lane.coins?.gross ?? 0), 0) };
    return row;
  });
  const volumeFamilies = everyone.length;

  const aggregate = (kind: Kind): LaneLine | null => {
    const ids = aggregated.flatMap(f => f.lanes.filter(l => l.kind === kind)).map(l => l.id), lanes = ids.map(id => flow.get(id)), tracks = ids.map(id => flow.track(id, coins)!);
    if (!ids.length) return null;
    const last = nan(columns), span = t1Sec - t0Sec;
    let delta = 0, gross = 0;
    const bases = tracks.map(s => settings.rebase ? s.cumDelta(t0Sec - 1) : 0), firsts = tracks.map(s => s.first);
    const before = tracks.reduce((sum, s, i) => { const first = firsts[i]; return first !== null && first !== undefined && first <= t0Sec - 1 ? sum + s.cumDelta(t0Sec - 1) : sum; }, 0);
    for (let c = 0; c < columns; c++) {
      // The same slices as FlowSeries.decimate, so the aggregate and the lanes line up column for column.
      const a = t0Sec + Math.floor(span * c / columns), end = Math.max(a + 1, t0Sec + Math.floor(span * (c + 1) / columns)) - 1;
      let sum = 0, any = false;
      tracks.forEach((s, i) => { const first = firsts[i]; if (first !== null && first !== undefined && end >= first) { sum += s.cumDelta(end) - bases[i]!; any = true; } });
      if (any) last[c] = sum;
    }
    for (const s of lanes) if (s) { delta += s.delta(winStart, nowSec); gross += s.gross(winStart, nowSec); }
    const r = range(last);
    const line: LaneLine = { id: '', kind, series: null, lo: last, hi: last, last, ...r, before, delta, gross, buy: (gross + delta) / 2, sell: (gross - delta) / 2, quiet: false };
    if (coins) {
      let cDelta = 0, cGross = 0;
      for (const id of ids) { const s = flow.coinsOf(id); if (s && !s.empty) { cDelta += s.delta(winStart, nowSec); cGross += s.gross(winStart, nowSec); } }
      line.coins = { delta: cDelta, gross: cGross, buy: (cGross + cDelta) / 2, sell: (cGross - cDelta) / 2 };
    }
    return line;
  };
  return { t0, t1, columns, rankSec, nowSec, rows, spot: aggregate('spot'), perp: aggregate('perp'), instruments: withFlow.length + olderOnly.length, hidden: Math.max(0, volumeFamilies - rows.length), counted: families.flatMap(f => f.lanes.map(l => l.id)) };
}
