import type { InfoLine } from '../infobox.ts';
import { price as fmtPrice, usd } from '../format.ts';
import { t, tn } from '../i18n.ts';
import { rowEventAt, type CueEvent, type RowEvent } from './book-cues.ts';

/** The events a venue's cells raised, grouped by the publication that raised them (the events of one `pub` together, in the order given: newest publication first). */
export function byPublication(events: readonly CueEvent[]): CueEvent[][] {
  const out: CueEvent[][] = [];
  for (const e of events) { const last = out[out.length - 1]; if (last && last[0]!.pub === e.pub) last.push(e); else out.push([e]); }
  return out;
}

/**
 * The change a price row's light was made from, by the row's own index: the events of the newest publication that changed this row, shared over it and
 * added up as the cue's were (`rowEventAt`), so the figure the pointer reads is the figure the cell was lit with. Publications are tried from the newest
 * back: a newer one that changed only a neighbouring row of the same bin does not erase this row's last change. Null when none changed it.
 */
export function latestRowChange(publications: readonly (readonly CueEvent[])[], row: number, step: number, scale: number): RowEvent | null {
  for (const events of publications) { const r = rowEventAt(events, row, step, scale); if (r && r.usd !== 0) return r; }
  return null;
}

/** What is known about one price level of the order book, to say what the pointer is on. */
export interface LevelFacts {
  /** The level's price span: from `low` up one `step`. */
  low: number;
  step: number;
  /** The price the book is centred on. */
  mark: number;
  /** An ask (a seller waiting above the price) or a bid (a buyer waiting below). */
  ask: boolean;
  /** Everything resting at this level, USD. */
  size: number;
  /** The running total from the mark out to and including this level, USD. */
  cumulative: number;
  /** Each venue's part of the level, any order (venues with nothing there left out); `id`, the book's instrument, gives its line the venue's mark. */
  venues: readonly { name: string; usd: number; id?: string }[];
  /** A book that belongs to one venue says which. */
  title?: string;
  /** What the level gained (+) or lost (−) over the pull/stack window, and whether the price traded there meanwhile. */
  pull?: { usd: number; touched: boolean; window: string };
  /** The venues' latest observed changes here (newest first), what the cues lit: `ChangeFact`. */
  changes?: readonly ChangeFact[];
  /** What the heat strip says of the cell the pointer is on. */
  heat?: HeatFact;
}

/**
 * One venue's latest observed change of its displayed depth at a level: its size (signed USD), how long ago, and how it read; `traded` is the USD of
 * market orders that reached the row on that venue around the same time (`tradedInRow`), absent when the tape does not say.
 */
export interface ChangeFact { name: string; id?: string; usd: number; ageMs: number; removed: boolean; pair: boolean; traded?: number }
/** The shares (0 to 1) of a cell the heat strip is drawn from; `kind` says which one it shows. */
export interface HeatFact { kind: 'added' | 'activity'; fresh: number; unknown: number; activity: number }

const signedUsd = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`;
/** How long ago, as a person reads it: "just now", "4 s ago", "2 min ago". */
export function agoText(ms: number): string {
  return ms < 1_000 ? t('just now') : ms < 60_000 ? t('{n} s ago', { n: Math.round(ms / 1_000) }) : t('{n} min ago', { n: Math.round(ms / 60_000) });
}

/**
 * What the cues say of a level or a cell, in words: the latest changes (at most `limit`, each venue's with its mark) and what they are, and the
 * heat strip's share. The change is the depth a venue showed, compared between two of its own snapshots: said once, so that nobody reads an
 * order, a cancel or a trade into it.
 */
export function cueLines(f: Pick<LevelFacts, 'ask' | 'changes' | 'heat'>, limit = 3): InfoLine[] {
  const lines: InfoLine[] = [];
  const changes = (f.changes ?? []).slice(0, limit);
  const tradedText = (c: ChangeFact): string => c.traded === undefined ? '' : ` · ${c.traded > 0 ? t('{usd} traded', { usd: `$${usd(c.traded)}` }) : t('none traded')}`;
  changes.forEach((c, i) => lines.push({ label: i === 0 ? t('Last change') : '', text: `${signedUsd(c.usd)}${c.removed ? ` · ${t('emptied')}` : ''} · ${agoText(c.ageMs)}${tradedText(c)}`, color: f.ask ? 'above' : 'below', rule: i === 0, ...(c.id ? { mark: c.id } : {}) }));
  // Two opposite changes of about one size next to each other are said as that: nothing in the book says whether it is one order moving, a row's edge crossed, or two.
  if (changes.some(c => c.pair)) lines.push({ text: t('A change nearby went the other way, by about the same size.'), color: 'muted', wrap: true });
  if (f.heat && f.heat.fresh + f.heat.unknown + f.heat.activity > 0) {
    const h = f.heat, pct = (v: number): string => `${Math.round(v * 100)}%`;
    lines.push(h.kind === 'added' ? { label: t('Recent adds'), text: pct(h.fresh), rule: !changes.length } : { label: t('Recent change'), text: pct(h.activity), rule: !changes.length });
    if (h.unknown > 0.5) lines.push({ text: t('Not known yet: the first snapshot has no history.'), color: 'muted', wrap: true });
  }
  if (changes.length) lines.push({ text: t('The depth this venue showed, compared between two of its own snapshots: not an order, and not known to be cancelled or traded.'), color: 'muted', wrap: true });
  if (changes.some(c => c.traded !== undefined)) lines.push({ text: t('Traded: market orders that reached this row on that venue around the same time. The book does not say how much of the change they account for.'), color: 'muted', wrap: true });
  return lines;
}

/** How far a level is from the mark: "+0.42% · 36 bp", negative below it. */
export function distanceText(price: number, mark: number): string {
  const d = price - mark, pct = d / mark * 100, bp = Math.abs(d / mark * 1e4);
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  return `${sign}${Math.abs(pct) < 1 ? Math.abs(pct).toFixed(2) : Math.abs(pct).toFixed(1)}% · ${bp < 10 ? bp.toFixed(1) : Math.round(bp)} bp`;
}

const span = (f: Pick<LevelFacts, 'low' | 'step'>): string => `${fmtPrice(f.low, f.step)} – ${fmtPrice(f.low + f.step, f.step)}`;
const side = (f: Pick<LevelFacts, 'ask'>): InfoLine => ({ label: t('Side'), text: f.ask ? t('Ask: sellers waiting') : t('Bid: buyers waiting'), color: f.ask ? 'above' : 'below' });

/**
 * The popup for a whole level (the block of bars at one price, all venues together or one venue's book), with its venues largest first: the
 * first `limit` of them (the Compact book, with room for every piece in its bar, names them all).
 */
export function levelLines(f: LevelFacts, limit = 4): InfoLine[] {
  const lines: InfoLine[] = [
    { text: f.title ?? t('Order book level'), bold: true },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(f.size)}`, bold: true },
    { label: t('From the mark'), text: `$${usd(f.cumulative)}` },
    { label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) },
  ];
  if (f.pull) {
    const v = f.pull.usd;
    lines.push({ label: t('Pull/stack, {window}', { window: f.pull.window }), text: `${v > 0 ? '+' : v < 0 ? '−' : ''}$${usd(Math.abs(v))}`, color: f.pull.touched ? 'muted' : f.ask ? 'above' : 'below' });
    if (f.pull.touched) lines.push({ text: t('The price traded here in the window: a fill takes liquidity away just as a pull does.'), color: 'muted' });
  }
  if (f.venues.length > 1) {
    const sorted = [...f.venues].sort((a, b) => b.usd - a.usd), total = sorted.reduce((sum, v) => sum + v.usd, 0);
    sorted.slice(0, limit).forEach((v, i) => lines.push({ label: v.name, text: `$${usd(v.usd)} · ${total > 0 ? Math.round(v.usd / total * 100) : 0}%`, rule: i === 0, ...(v.id ? { mark: v.id } : {}) }));
    if (sorted.length > limit) lines.push({ text: t('+{n} more venues', { n: sorted.length - limit }), color: 'muted' });
  }
  lines.push(...cueLines(f));
  return lines;
}

/**
 * The popup for a row's gutter, where the signed mark is: the latest changes there, venue by venue. It is asked of a row whose level may have
 * emptied (the mark of a cell that went to nothing has no bar to point at), so it needs no size.
 */
export function gutterLines(f: Pick<LevelFacts, 'low' | 'step' | 'mark' | 'ask' | 'changes' | 'title'>): InfoLine[] {
  return [{ text: f.title ?? t('Order book level'), bold: true }, { label: t('Price'), text: span(f) }, side(f), { label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) }, ...cueLines(f, 5)];
}

/** The popup for one venue's part of a level (a coloured cell in a venue's column, or its piece of the bar). */
export function venueCellLines(f: LevelFacts, venue: { name: string; usd: number; id?: string }): InfoLine[] {
  const ranked = [...f.venues].sort((a, b) => b.usd - a.usd), rank = 1 + ranked.filter(v => v.usd > venue.usd).length;
  const lines: InfoLine[] = [
    { text: venue.name, bold: true, ...(venue.id ? { mark: venue.id } : {}) },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(venue.usd)}`, bold: true },
    { label: t('Share of level'), text: `${f.size > 0 ? Math.round(venue.usd / f.size * 100) : 0}%` },
  ];
  if (f.venues.length > 1) lines.push({ label: t('Rank at this price'), text: t('{rank} of {total}', { rank, total: f.venues.length }) });
  lines.push({ label: t('Distance'), text: distanceText(f.low + f.step / 2, f.mark) });
  lines.push(...cueLines(f));
  lines.push({ label: t('All venues here'), text: `$${usd(f.size)}`, rule: true });
  return lines;
}

/**
 * The popup for the smaller venues' piece at the end of a Compact bar: each of them with its part of the level, so nothing too narrow to draw
 * is out of reach.
 */
export function smallerVenuesLines(f: LevelFacts, venues: readonly { name: string; usd: number; id?: string }[]): InfoLine[] {
  const usdSum = venues.reduce((sum, v) => sum + v.usd, 0);
  const lines: InfoLine[] = [
    { text: tn(venues.length, '{n} smaller venue', '{n} smaller venues'), bold: true },
    { label: t('Price'), text: span(f) },
    side(f),
    { label: t('Size'), text: `$${usd(usdSum)}`, bold: true },
    { label: t('Share of level'), text: `${f.size > 0 ? Math.round(usdSum / f.size * 100) : 0}%` },
  ];
  venues.slice(0, 10).forEach((v, i) => lines.push({ label: v.name, text: `$${usd(v.usd)} · ${f.size > 0 ? Math.round(v.usd / f.size * 100) : 0}%`, rule: i === 0, ...(v.id ? { mark: v.id } : {}) }));
  if (venues.length > 10) lines.push({ text: t('+{n} more venues', { n: venues.length - 10 }), color: 'muted' });
  lines.push(...cueLines(f));
  return lines;
}
