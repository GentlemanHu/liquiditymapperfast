import { usd, clock, price as fmtPrice } from '../format.ts';
import type { InfoLine } from '../infobox.ts';
import { venueLabel } from '../venues.ts';
import { t, tn } from '../i18n.ts';
// Types alone from the Sizes model: it reads the size bands, whose module reads this one (no import cycle at run time).
import type { SizeRow } from './sizes.ts';
import { scaledUsd } from '../coin.ts';
import { amount, signedAmount } from '../units.ts';
import type { Kind } from '../scope.ts';
import { laneFigures, type CvdModel, type FamilyRow, type LaneLine } from './model.ts';
import { laneNet } from './hero.ts';

/**
 * A signed dollar figure for a label: +$12.3M, −$4.1M, $0 (always dollars: other panes write dollar figures with it). The column's own
 * labels write the page's units (units.ts): a lane's line and, on a model built in coins, its figures' coins (`laneFigures`).
 */
export const signedUsd = (value: number): string => !Number.isFinite(value) ? '–' : value === 0 ? '$0' : `${value < 0 ? '−' : '+'}$${usd(Math.abs(value))}`;
export const plainUsd = (value: number): string => Number.isFinite(value) ? `$${usd(value)}` : '–';
/** A size in the page's units with its unit, '–' for none: `plainUsd` in dollars, "13.2 BTC" in coins (units.ts `amount`). */
export const plainAmount = (value: number): string => Number.isFinite(value) ? amount(value) : '–';

/** One line of a row's label: its text, which colour it takes, and a coloured dot ahead of it (the lane's line colour). */
/** `mark`: the exchange whose mark goes before the text (the row's name line). */
/** `buy` and `sell`: a figure of buying less selling in the colour of its sign (the dot beside it keeps the lane's own colour). */
export interface LabelLine { text: string; tone: 'text' | 'muted' | 'buy' | 'sell'; bold?: boolean; dot?: Kind; mark?: string;
  /** A short line in the text colour ahead of the text (the legend of the price drawn over the flow). */
  swatch?: 'price' }

/** A delta's tone: the buy colour above zero, the sell colour below (never the plain text: in Terminal that is the buy colour; Karl, 2026-11-22). */
export const leanTone = (v: number): LabelLine['tone'] => v > 0 ? 'buy' : v < 0 ? 'sell' : 'text';
const leanColor = (v: number | undefined): InfoLine['color'] => v === undefined || !Number.isFinite(v) || v === 0 ? 'text' : v > 0 ? 'below' : 'above';

/** The ranking window as a short name: "1H". */
export const windowName = (rankSec: number): string => rankSec >= 86_400 ? `${Math.round(rankSec / 86_400)}D` : rankSec >= 3_600 ? `${Math.round(rankSec / 3_600)}H` : `${Math.round(rankSec / 60)}M`;

const letter = (kind: Kind): string => kind === 'spot' ? t('S') : t('P');

/**
 * What goes beside a row, in lines that fit `height` px at 12 px a line: the rank and the exchange, then each lane's delta over the
 * ranking window with a dot in the lane's colour, then the exchange's share of all volume and whether it has gone quiet. A short row
 * folds the two lanes onto one line.
 */
export function rowLabel(row: FamilyRow, window: string, height: number, showQuiet: boolean): LabelLine[] {
  const head: LabelLine = { text: `#${row.rank} ${venueLabel(row.key).toUpperCase()}${showQuiet && row.quiet ? ' !5m' : ''}`, tone: 'text', bold: true, mark: row.key };
  return foldLabel(head, row.lanes, row.share, row.coins?.gross ?? row.gross, height);
}

/**
 * A row's label in the Sizes view, as an exchange's is in the Flow view: the band's sizes, each kind's net over the ranking window with a dot
 * in its line's colour, and the band's share of the volume of all six bands with what it traded, folded the same way into a short row.
 */
export function sizeRowLabel(row: SizeRow, height: number): LabelLine[] {
  const head: LabelLine = { text: row.label, tone: 'text', bold: true };
  // A row with no line (its bars not read yet, or none for the window) says its sizes alone: "0% · $0" would say nothing traded.
  return row.lanes.length ? foldLabel(head, row.lanes, row.share, row.coins?.gross ?? row.gross, height) : [head];
}

/**
 * A row's head, its lanes' nets and its share with what it traded (`traded`), in lines that fit `height` px at 12 px a line (the two lanes on
 * one line in a short row). In the page's units: a lane's coins on a model built in coins (`laneFigures`), `traded` as the caller gives it.
 */
function foldLabel(head: LabelLine, laneLines: readonly LaneLine[], shareOf: number, traded: number, height: number): LabelLine[] {
  const lines = Math.max(2, Math.floor((height - 6) / 12));
  const lanes = laneLines.map(l => { const delta = laneFigures(l).delta; return { text: `${letter(l.kind)} ${signedAmount(delta)}`, tone: leanTone(delta), dot: l.kind }; });
  const share: LabelLine = { text: `${Math.round(shareOf * 100)}% · ${plainAmount(traded)}`, tone: 'muted' };
  if (lines >= 2 + lanes.length) return [head, ...lanes, share];
  if (lines >= 3 && lanes.length === 2) return [head, { text: lanes.map(l => l.text).join('  '), tone: 'text' }, share];
  if (lines >= 3) return [head, ...lanes, share].slice(0, lines);
  return [head, lanes.length === 1 ? lanes[0]! : { text: lanes.map(l => l.text).join(' '), tone: 'text' }];
}

/**
 * The label of the aggregate row: every exchange together, and each kind's delta over the window. With the Spot or Perp filter on it says
 * which kind these are and how many exchanges the filter leaves out, so a short list is not mistaken for a missing one.
 */
export function aggregateLabel(model: CvdModel, height: number, filter?: { kind: Kind; hidden: number }): LabelLine[] {
  const name = windowName(model.rankSec);
  const head: LabelLine = { text: !filter ? t('ALL VENUES') : filter.kind === 'spot' ? t('ALL SPOT VENUES') : t('ALL PERP VENUES'), tone: 'text', bold: true };
  const lanes: LabelLine[] = ([['spot', model.spot], ['perp', model.perp]] as const).flatMap(([kind, line]) => line ? [{ text: `${letter(kind)} ${signedAmount(laneFigures(line).delta)}`, tone: leanTone(laneFigures(line).delta), dot: kind }] : []);
  const total = (model.spot ? laneFigures(model.spot).delta : 0) + (model.perp ? laneFigures(model.perp).delta : 0), foot: LabelLine = { text: `Δ${name} ${signedAmount(total)}`, tone: leanTone(total) };
  const hidden: LabelLine[] = filter && filter.hidden > 0 ? [{ text: t('{n} filtered out', { n: filter.hidden }), tone: 'muted' }] : [];
  return height >= 80 ? [head, ...lanes, foot, ...hidden].slice(0, Math.max(3, Math.floor((height - 6) / 12))) : [head, ...lanes].slice(0, Math.max(2, Math.floor((height - 6) / 12)));
}

/**
 * The legend of the phone's chart: every exchange together, each kind's net over the window the chart draws (where its line ends, so the
 * figure agrees with the line beside it), both together, how many exchanges the Spot or Perp filter leaves out, and the price's line with the
 * newest price. `span` is the window's short name ("1h").
 */
export function heroLabel(model: CvdModel, span: string, rebase: boolean, price: number, filter?: { kind: Kind; hidden: number }): LabelLine[] {
  const head: LabelLine = { text: !filter ? t('ALL VENUES') : filter.kind === 'spot' ? t('ALL SPOT VENUES') : t('ALL PERP VENUES'), tone: 'text', bold: true };
  const nets = ([['spot', model.spot], ['perp', model.perp]] as const).map(([kind, line]) => [kind, laneNet(line, rebase)] as const);
  const lanes: LabelLine[] = nets.flatMap(([kind, net]) => net === null ? [] : [{ text: `${letter(kind)} ${signedAmount(net)}`, tone: leanTone(net), dot: kind }]);
  const total = nets.reduce((sum, [, net]) => sum + (net ?? 0), 0);
  const foot: LabelLine[] = lanes.length ? [{ text: `Δ${span.toUpperCase()} ${signedAmount(total)}`, tone: leanTone(total) }] : [];
  const hidden: LabelLine[] = filter && filter.hidden > 0 ? [{ text: t('{n} filtered out', { n: filter.hidden }), tone: 'muted' }] : [];
  const line: LabelLine[] = Number.isFinite(price) ? [{ text: fmtPrice(price), tone: 'text', swatch: 'price' }] : [];
  return [head, ...lanes, ...foot, ...hidden, ...line];
}

const lanePhrase = (kind: Kind): string => kind === 'spot' ? t('Spot') : t('Perp');

/**
 * The box under the pointer on a venue row: what each lane's running delta stands at there, then the lane's figures over the ranking
 * window (net, buy against sell) and the exchange's share. Pure, so a test reads the words.
 */
export function rowHover(row: FamilyRow, column: number, timeMs: number, window: string): InfoLine[] {
  const out: InfoLine[] = [{ text: `${venueLabel(row.key)} · #${row.rank}`, bold: true }, { text: clock(timeMs, true), color: 'muted' }];
  for (const lane of row.lanes) {
    const v = lane.last[column];
    out.push({ label: t('{kind} CVD here', { kind: lanePhrase(lane.kind) }), text: v !== undefined && Number.isFinite(v) ? signedAmount(v) : '–', color: leanColor(v), rule: out.length === 2 });
  }
  for (const lane of row.lanes) {
    const f = laneFigures(lane);
    out.push({ label: t('{kind} net, {window}', { kind: lanePhrase(lane.kind), window }), text: signedAmount(f.delta), color: leanColor(f.delta), rule: lane === row.lanes[0] });
    out.push({ label: t('{kind} buys / sells', { kind: lanePhrase(lane.kind) }), text: `${plainAmount(f.buy)} / ${plainAmount(f.sell)}` });
  }
  out.push({ label: t('Share of all volume'), text: `${(row.share * 100).toFixed(row.share < 0.1 ? 1 : 0)}%`, rule: true });
  if (row.quiet) out.push({ text: t('No trades in the last five completed minutes.'), color: 'muted', wrap: true });
  return out;
}

/**
 * The box under the pointer on a row of the Sizes view: what each kind's running delta of orders of that size stands at there (from the left
 * edge), each kind's net and buys against sells over the ranking window, the band's share of the volume, the bars it is read from, and how
 * many of them hold no order sizes (where the lines break).
 */
export function sizeRowHover(row: SizeRow, column: number, timeMs: number, window: string, tfMs: number): InfoLine[] {
  const out: InfoLine[] = [{ text: t('Orders {band}', { band: row.label }), bold: true }, { text: clock(timeMs, true), color: 'muted' }];
  for (const lane of row.lanes) {
    const v = lane.last[column];
    out.push({ label: t('{kind} CVD here', { kind: lanePhrase(lane.kind) }), text: v !== undefined && Number.isFinite(v) ? signedAmount(v) : '–', color: leanColor(v), rule: out.length === 2 });
  }
  for (const lane of row.lanes) {
    const f = laneFigures(lane);
    out.push({ label: t('{kind} net, {window}', { kind: lanePhrase(lane.kind), window }), text: signedAmount(f.delta), color: leanColor(f.delta), rule: lane === row.lanes[0] });
    out.push({ label: t('{kind} buys / sells', { kind: lanePhrase(lane.kind) }), text: `${plainAmount(f.buy)} / ${plainAmount(f.sell)}` });
  }
  if (row.lanes.length) out.push({ label: t('Share of all volume'), text: `${(row.share * 100).toFixed(row.share < 0.1 ? 1 : 0)}%`, rule: true });
  out.push({ text: tn(Math.round(tfMs / 60_000), 'Read from bars of {n} minute: order sizes are kept a minute at a time.', 'Read from bars of {n} minutes: order sizes are kept a minute at a time.'), color: 'muted', wrap: true });
  if (row.unknown > 0) out.push({ text: tn(row.unknown, '{n} bar here holds no order sizes: the lines break there.', '{n} bars here hold no order sizes: the lines break there.'), color: 'muted', wrap: true });
  return out;
}

/**
 * The box on the aggregate row. When spot and perpetual markets are moving opposite ways by a wide margin it says so: that is the
 * pattern worth a second look (one kind of market is being hit while the other is being lifted).
 */
export function aggregateHover(model: CvdModel, column: number, timeMs: number, window: string): InfoLine[] {
  const out: InfoLine[] = [{ text: t('All venues'), bold: true }, { text: clock(timeMs, true), color: 'muted' }];
  const lines: [Kind, LaneLine | null][] = [['spot', model.spot], ['perp', model.perp]];
  for (const [kind, line] of lines) {
    if (!line) continue;
    const v = line.last[column];
    out.push({ label: t('{kind} CVD here', { kind: lanePhrase(kind) }), text: v !== undefined && Number.isFinite(v) ? signedAmount(v) : '–', color: leanColor(v), rule: out.length === 2 });
  }
  for (const [kind, line] of lines) {
    if (!line) continue;
    const f = laneFigures(line);
    out.push({ label: t('{kind} net, {window}', { kind: lanePhrase(kind), window }), text: signedAmount(f.delta), color: leanColor(f.delta), rule: out.at(-1)?.label?.includes('here') === true });
    out.push({ label: t('{kind} buys / sells', { kind: lanePhrase(kind) }), text: `${plainAmount(f.buy)} / ${plainAmount(f.sell)}` });
  }
  // Judged on the dollars in either units (the lanes' own figures).
  const note = divergence(model);
  if (note) out.push({ text: note, wrap: true, rule: true });
  if (model.hidden > 0) out.push({ text: t('{n} more venues have traded but are not shown.', { n: model.hidden }), color: 'muted', wrap: true });
  return out;
}

/** Spot and perpetual moving apart over the ranking window: both sides big and of opposite sign. Null when they do not. */
export function divergence(model: CvdModel, minUsd = scaledUsd(2_000_000)): string | null {
  const spot = model.spot?.delta ?? 0, perp = model.perp?.delta ?? 0;
  if (Math.abs(spot) < minUsd || Math.abs(perp) < minUsd || Math.sign(spot) === Math.sign(perp)) return null;
  return spot > 0 ? t('Spot is being bought while perpetuals are being sold.') : t('Spot is being sold while perpetuals are being bought.');
}
