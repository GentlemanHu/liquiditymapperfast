/**
 * One tooltip for the whole page. An element carries its explanation in `data-tip` (set with `setTip`, or `tip:` in `el()`); a single
 * delegated listener shows it after a short hover or at once on keyboard focus. The native `title` attribute is not used anywhere,
 * so the browser's own tooltip never competes with this one, and the text can change while it is open.
 *
 * A finger has no hover, so on a touch screen the tip comes from a long press: hold an element for a moment and its explanation appears
 * above it (above, so the hand does not cover it), and the click that would follow the lift is swallowed so that reading about a button
 * never presses it. Moving the finger first (to scroll, say) cancels it; the next touch anywhere closes the tip.
 */

const SHOW_DELAY_MS = 380, FOLLOW_MS = 600, GAP = 8, MARGIN = 8;
const LONG_PRESS_MS = 450, PRESS_SLOP = 10, TOUCH_VISIBLE_MS = 6000;

export function setTip(node: HTMLElement, text: string | null | undefined): void {
  if (text) node.dataset.tip = text; else delete node.dataset.tip;
}

/** Where a tooltip of `size` goes for an anchor `rect`: centred below it, or above when there is no room, kept inside the viewport. */
export function placeTip(rect: { left: number; right: number; top: number; bottom: number }, size: { w: number; h: number }, viewport: { w: number; h: number }, prefer: 'below' | 'above' = 'below'): { left: number; top: number; above: boolean } {
  const fitsAbove = rect.top - GAP - size.h >= MARGIN;
  const above = prefer === 'above' ? fitsAbove : rect.bottom + GAP + size.h > viewport.h - MARGIN && fitsAbove;
  const top = above ? rect.top - GAP - size.h : Math.min(rect.bottom + GAP, viewport.h - MARGIN - size.h);
  const centre = (rect.left + rect.right) / 2 - size.w / 2;
  return { left: Math.max(MARGIN, Math.min(centre, viewport.w - MARGIN - size.w)), top: Math.max(MARGIN, top), above };
}

/**
 * The element a mouse or pen just pressed keeps its tip shut until the pointer moves on to another element (Karl, 2026-11-22: the Depth
 * pane's Source dropdown sometimes left its tip over the open list). A press hides the tip, but the press also focuses the control, which
 * Chrome counts as visible focus on a dropdown, and a native list takes the pointer away without a leave and gives it back over the same
 * control, where the tip would follow at once: either brought the tip back over the open list. While the pressed element's own list or
 * panel is open (`open`: a native dropdown's list as `:open` says, Chrome 157 does; a list or panel the page draws, whose anchor menu.ts
 * and ui.ts mark `.open`), the guard holds wherever the pointer goes and whatever key is pressed, since Chrome still sends the page pointer
 * events while a native list is open (seen in headless) and the rows of a list the page draws carry no tip; other elements' tips may show.
 */
export class PressGuard<T> {
  #pressed: T | null = null;
  constructor(private readonly open: (node: T) => boolean = () => false) {}
  /** A mouse or pen went down on `node` (the element under it that carries a tip, or null). */
  press(node: T | null): void { this.#pressed = node; }
  /**
   * The pointer is over `node` (null: an element without a tip): whether its tip may show. Over the pressed element, never; elsewhere the
   * guard ends, unless the pressed element's list is still open.
   */
  over(node: T | null): boolean {
    const pressed = this.#pressed;
    if (pressed !== null && node === pressed) return false;
    if (pressed !== null && this.open(pressed)) return node !== null;
    this.#pressed = null; return node !== null;
  }
  /** `node` took focus: whether its tip may show (not when the press gave it the focus). */
  focus(node: T | null): boolean { return node !== null && node !== this.#pressed; }
  /** A key went down: focus from the keyboard shows tips again, the pressed control's too, once its list is closed. */
  key(): void { const pressed = this.#pressed; if (pressed !== null && this.open(pressed)) return; this.#pressed = null; }
}

/** Start listening on `doc`; returns how to stop (for tests and hot reload). */
export function installTips(doc: Document = document): () => void {
  const box = doc.createElement('div');
  box.className = 'tip'; box.setAttribute('role', 'tooltip');
  // The popover API puts the tooltip in the top layer, above modal dialogs (the guide, the venue picker); without it a plain fixed box is used.
  const canPopover = typeof box.showPopover === 'function';
  if (canPopover) box.popover = 'manual';
  doc.body.append(box);
  let current: HTMLElement | null = null, timer = 0, watcher: MutationObserver | null = null, visible = false, lastShown = 0;
  /** A long press in progress, the element a finger is holding a tip for, the touch tip's own hide timer, and the click after a long press that is to be swallowed. */
  let press: { node: HTMLElement; x: number; y: number; id: number } | null = null, held: HTMLElement | null = null, touchTip = false, touchHide = 0;
  let swallowed: { node: HTMLElement; until: number } | null = null;
  // A press hides the tip, and a mouse's or pen's keeps its element's shut until the pointer moves on (PressGuard), and while the element's
  // own list or panel is open, wherever the pointer goes: a native dropdown's (the element, or one inside it), or one the page draws (its
  // anchor marked `.open` by menu.ts or ui.ts, on the element or inside it).
  const listShown = (select: HTMLSelectElement): boolean => {
    // Where the browser cannot say (no `:open`), a dropdown that has the focus may have its list open: its tip waits for a press or a key.
    try { return select.matches(':open'); } catch { return select === doc.activeElement; }
  };
  const guard = new PressGuard<HTMLElement>(node => {
    if (node.classList.contains('open') || node.querySelector('.open') !== null) return true;
    const select = node instanceof HTMLSelectElement ? node : node.querySelector('select');
    return select !== null && listShown(select);
  });

  const place = (): void => {
    if (!current) return;
    box.style.left = '0px'; box.style.top = '0px';
    const rect = current.getBoundingClientRect(), size = { w: box.offsetWidth, h: box.offsetHeight };
    const at = placeTip(rect, size, { w: doc.documentElement.clientWidth, h: doc.documentElement.clientHeight }, touchTip ? 'above' : 'below');
    box.style.left = `${Math.round(at.left)}px`; box.style.top = `${Math.round(at.top)}px`;
  };
  const hide = (): void => {
    window.clearTimeout(timer); timer = 0; window.clearTimeout(touchHide); touchHide = 0; touchTip = false; watcher?.disconnect(); watcher = null; current = null;
    if (!visible) return;
    visible = false; lastShown = Date.now(); box.classList.remove('on');
    if (canPopover && box.matches(':popover-open')) box.hidePopover();
  };
  const show = (node: HTMLElement): void => {
    const text = node.dataset.tip; if (!text) return;
    current = node; box.textContent = text;
    if (canPopover && !box.matches(':popover-open')) box.showPopover();
    box.classList.add('on'); visible = true; place();
    watcher?.disconnect();
    // The text may change while it is open (a venue chip's reach, a status): follow it.
    watcher = new MutationObserver(() => { if (current !== node) return; const next = node.dataset.tip; if (next) { box.textContent = next; place(); } else hide(); });
    watcher.observe(node, { attributes: true, attributeFilter: ['data-tip'] });
  };
  const target = (event: Event): HTMLElement | null => (event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null);

  const cancelPress = (): void => { if (press) { window.clearTimeout(press.id); press = null; } };
  const pressDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    const node = target(event); cancelPress();
    if (!node) return;
    const id = window.setTimeout(() => {
      const long = press; press = null;
      if (!long) return;
      hide(); touchTip = true; held = long.node; show(long.node);
      touchHide = window.setTimeout(hide, TOUCH_VISIBLE_MS);
    }, LONG_PRESS_MS);
    press = { node, x: event.clientX, y: event.clientY, id };
  };
  const pressMove = (event: PointerEvent): void => { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP) cancelPress(); };
  /** The finger that held a tip lifted: the click some browsers still send for it must not press the button the tip was about. */
  const lifted = (event: PointerEvent): void => {
    cancelPress();
    if (event.pointerType === 'touch' && held) swallowed = { node: held, until: Date.now() + 700 };
    held = null;
  };
  const swallow = (event: MouseEvent): void => {
    const s = swallowed; swallowed = null;
    if (s && Date.now() < s.until && event.target instanceof Node && s.node.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  // The tip a finger opened stays when focus moves (the browser moves it when it sends that click); the next touch closes it.
  const blurred = (): void => { if (!touchTip) hide(); };

  const over = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    // Every element the pointer enters is told to the guard, those without a tip too (moving on to the map ends it).
    const node = target(event), allowed = guard.over(node);
    if (node === current) return;
    hide();
    if (!node || !allowed) return;
    // Once a tooltip has been seen, the next one follows at once, as when a toolbar is being scanned.
    if (Date.now() - lastShown < FOLLOW_MS) show(node); else timer = window.setTimeout(() => show(node), SHOW_DELAY_MS);
  };
  const focus = (event: FocusEvent): void => {
    const node = target(event);
    if (node && guard.focus(node) && event.target instanceof Element && event.target.matches(':focus-visible')) { hide(); show(node); }
  };
  // A finger always "leaves" when it lifts, which would close a tip it had just opened.
  const leave = (event: PointerEvent): void => { if (event.pointerType !== 'touch' && !event.relatedTarget) hide(); };
  const stop = (): void => hide();
  const down = (event: PointerEvent): void => {
    hide();
    // A press on a row of a list the page draws (menu.ts) leaves the guard on the control the list belongs to: closing the list gives that
    // control the focus again.
    if (event.target instanceof Element && event.target.closest('.menu')) return;
    guard.press(event.pointerType !== 'touch' ? target(event) : null);
  };
  // Escape puts the tip away; so does a key on a dropdown (Space, Alt+Down or F4 open its list, the arrows change it).
  const key = (event: KeyboardEvent): void => {
    guard.key();
    if (event.key === 'Escape' || (event.target instanceof Element && event.target.tagName === 'SELECT')) hide();
  };
  // A value changed (a choice in a dropdown, a box ticked): whatever tip is up goes.
  const changed = (): void => hide();

  doc.addEventListener('pointerover', over, true);
  doc.addEventListener('pointerleave', leave, true);
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('change', changed, true);
  doc.addEventListener('pointerdown', pressDown, true); doc.addEventListener('pointermove', pressMove, true);
  doc.addEventListener('pointerup', lifted, true); doc.addEventListener('pointercancel', lifted, true); doc.addEventListener('click', swallow, true);
  doc.addEventListener('wheel', stop, { capture: true, passive: true });
  doc.addEventListener('focusin', focus, true);
  doc.addEventListener('focusout', blurred, true);
  doc.addEventListener('keydown', key, true);
  window.addEventListener('blur', stop);
  return () => {
    hide();
    doc.removeEventListener('pointerover', over, true); doc.removeEventListener('pointerleave', leave, true); doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('change', changed, true);
    doc.removeEventListener('pointerdown', pressDown, true); doc.removeEventListener('pointermove', pressMove, true); doc.removeEventListener('pointerup', lifted, true);
    doc.removeEventListener('pointercancel', lifted, true); doc.removeEventListener('click', swallow, true); cancelPress();
    doc.removeEventListener('wheel', stop, true); doc.removeEventListener('focusin', focus, true); doc.removeEventListener('focusout', blurred, true); doc.removeEventListener('keydown', key, true);
    window.removeEventListener('blur', stop); box.remove();
  };
}
