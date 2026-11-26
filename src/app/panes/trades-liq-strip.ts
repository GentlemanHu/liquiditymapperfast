import { el } from '../dom.ts';
import { t } from '../i18n.ts';
import { clockSeconds, price as fmtPrice, usd as fmtUsd } from '../format.ts';
import { venueMark } from '../venue-marks.ts';
import { venueLabel } from '../venues.ts';
import { scaledUsd } from '../coin.ts';
import { replaying } from '../replay/clock.ts';
import { isPhone } from '../device.ts';
import { instrumentShown } from '../cvd/ids.ts';
import { buildLiqRows, liqBarFull, type LiqRow } from '../trades/liquidations.ts';
import { amountText } from '../trades/style.ts';
import { amount, coinText, inCoins, units } from '../units.ts';
import { setText } from './lower-panes.ts';
import type { LiquidationBook } from '../liquidations.ts';
import type { Store } from '../store.ts';

/** How many recent liquidations the pinned strip keeps in view (desktop vs phone). */
const MAX_ROWS_DESKTOP = 4, MAX_ROWS_PHONE = 3;
/** Minimum interval between DOM updates during a rapid liquidation cascade (ms). */
const THROTTLE_MS = 200;

/**
 * Collapsible pinned recent-liquidations strip docked above the Tape when showing Trades or Both (Karl, 2026-11-24).
 * Solves the 100x rate mismatch between regular market orders and liquidations: a scalper watching the full trade tape
 * keeps the latest forced closes pinned in sight without them scrolling off in milliseconds.
 */
export class LiqStrip {
  readonly root = el('div', { class: 'trades-liq-strip', hidden: true });
  #head = el('div', { class: 'tls-head' });
  #titleBtn = el('button', { type: 'button', class: 'tls-title', tip: t('Switch the Tape to Liquidations') });
  #floorBadge = el('span', { class: 'tls-floor' });
  #soundBtn = el('button', { type: 'button', class: 'tls-btn tls-sound' });
  #closeBtn = el('button', { type: 'button', class: 'tls-btn tls-close', textContent: '×', ariaLabel: t('Hide pinned liquidations'), tip: t('Hide pinned liquidations') });
  #list = el('div', { class: 'tls-list' });
  #shown = false;
  #lastKey = '';
  #seenTop = '';
  #timer = 0;
  #lastPaint = 0;

  /** Liquidations book (set by the shell). */
  liquidations: () => LiquidationBook | null = () => null;
  /** Jump the map to a liquidation (set by the shell). */
  onGoTo: (t: number, price: number) => void = () => {};
  /** Switch the Tape to full Liquidations mode (set by the shell). */
  onOpenLiqMode: () => void = () => {};
  /** Toggle liquidation sounds (set by the shell). */
  onToggleSound: () => void = () => {};
  /** Unpin/hide this strip (set by the shell). */
  onClose: () => void = () => {};

  constructor(private store: Store) {
    this.#titleBtn.append(el('span', { class: 'tls-diamond', ariaHidden: 'true', textContent: '◆' }), el('span', { textContent: t('Liquidations') }));
    this.#titleBtn.onclick = () => this.onOpenLiqMode();
    this.#soundBtn.onclick = () => this.onToggleSound();
    this.#closeBtn.onclick = () => this.onClose();
    this.#head.append(this.#titleBtn, this.#floorBadge, el('span', { class: 'tls-spacer' }), this.#soundBtn, this.#closeBtn);
    this.root.append(this.#head, this.#list);
  }

  dispose(): void { window.clearTimeout(this.#timer); }

  setShown(shown: boolean): void {
    this.#shown = shown;
    this.root.hidden = !shown;
    if (!shown) { window.clearTimeout(this.#timer); this.#timer = 0; return; }
    this.refresh(true);
  }

  /** Re-render now or throttled during cascades. */
  refresh(immediate = false): void {
    if (!this.#shown) return;
    const now = performance.now(), wait = THROTTLE_MS - (now - this.#lastPaint);
    if (!immediate && wait > 0) {
      if (!this.#timer) this.#timer = window.setTimeout(() => { this.#timer = 0; this.#render(); }, wait);
      return;
    }
    window.clearTimeout(this.#timer); this.#timer = 0;
    this.#render();
  }

  #render(): void {
    if (!this.#shown) return;
    this.#lastPaint = performance.now();
    const s = this.store.state, tr = s.trades, book = this.liquidations();
    const minUsd = scaledUsd(tr.liqMinUsd);
    setText(this.#floorBadge, `≥ $${fmtUsd(minUsd)}`);
    const soundOn = s.sounds.on && s.sounds.liquidations.on;
    this.#soundBtn.classList.toggle('active', soundOn);
    setText(this.#soundBtn, soundOn ? t('Sound on') : t('Sound off'));
    this.#soundBtn.dataset.tip = soundOn ? t('Mute liquidation sounds') : t('Enable liquidation sounds');
    const maxRows = isPhone() ? MAX_ROWS_PHONE : MAX_ROWS_DESKTOP;
    const rows: LiqRow[] = book ? buildLiqRows(book.items, { minUsd, side: tr.side, shown: instrumentShown(s) }, tr.group, undefined, inCoins()).slice(0, maxRows) : [];
    const key = `${rows.map(r => `${r.key}:${r.count}:${Math.round(r.usd)}`).join('|')}|${minUsd}|${document.documentElement.lang}|${units()}`;
    if (key === this.#lastKey) return;
    const topKey = rows[0]?.key ?? '';
    const isFresh = this.#seenTop !== '' && topKey !== '' && topKey !== this.#seenTop;
    this.#seenTop = topKey;
    this.#lastKey = key;
    if (!rows.length) {
      this.#list.replaceChildren(el('div', { class: 'tls-empty', textContent: t('Waiting for liquidations') }));
      return;
    }
    const full = scaledUsd(liqBarFull(tr.liqMinUsd));
    const nodes = rows.map((row, idx) => {
      const short = row.side === 'short';
      const pct = Math.max(2, Math.min(100, Math.round(100 * Math.sqrt(row.usd / Math.max(1, full)))));
      // The row's size in the page's units (units.ts: its coins, each liquidation over its reported price); the bar stays on the dollars.
      const coins = inCoins(), size = coins ? amount(row.coins) : amountText(row.usd);
      const tip = `${short ? t('SHORTS LIQUIDATED') : t('LONGS LIQUIDATED')} ${size} · ${venueLabel(row.id)} · ${fmtPrice(row.price)}${row.kind === 'bankruptcy' && Math.abs(row.reported - row.price) > 1e-9 * row.price ? ` (${t('Bankruptcy price')}: ${fmtPrice(row.reported)})` : ''}`;
      const elRow = el('div', { class: `tls-row ${short ? 'tls-buy' : 'tls-sell'}${isFresh && idx === 0 ? ' tls-fresh' : ''}`, tip });
      elRow.style.setProperty('--bar-pct', `${pct}%`);
      const countEl = row.count > 1 ? el('span', { class: 'tls-count', textContent: `×${row.count}` }) : null;
      elRow.append(
        el('span', { class: 'tls-time', textContent: clockSeconds(row.t) }),
        venueMark(row.id, 13),
        el('span', { class: 'tls-glyph', ariaHidden: 'true', textContent: '◆' }),
        el('span', { class: 'tls-price', textContent: fmtPrice(row.price) }),
        el('span', { class: 'tls-bar-wrap' }, el('span', { class: 'tls-bar' })),
        ...(countEl ? [countEl] : []),
        el('span', { class: 'tls-usd', textContent: coins ? coinText(row.coins) : amountText(row.usd) }),
      );
      elRow.addEventListener('pointerenter', e => {
        if (e.pointerType === 'touch' || replaying()) return;
        this.store.set({ hover: { t: row.t, price: row.price, y: 0, source: 'trades' } });
      });
      elRow.addEventListener('pointerleave', e => {
        if (e.pointerType === 'touch') return;
        if (this.store.state.hover?.source === 'trades') this.store.set({ hover: null });
      });
      elRow.onclick = () => { if (!replaying() && !isPhone()) this.onGoTo(row.t, row.price); };
      return elRow;
    });
    this.#list.replaceChildren(...nodes);
  }
}
