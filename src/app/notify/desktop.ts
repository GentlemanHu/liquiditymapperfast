import type { Outcome } from './channels.ts';
import type { Outgoing } from './delivery.ts';

/**
 * A pop-up on this computer: the browser's notification, which the system shows (Windows' corner, macOS' Notification Centre) whether or not
 * the page is in front. Shown in front too: a person looking at another window of the same screen still wants it. One per alert (`tag`: the
 * alert's key), so a bell that goes off again replaces its pop-up instead of stacking. A click brings the page forward.
 *
 * Android's browsers throw when a page makes one without a service worker (and the page has none on purpose, install.ts), and an iPhone's
 * only for an installed page: there it is "not here", and the phone is reached through the phone channels instead.
 */

type Permission = 'granted' | 'denied' | 'default' | 'unsupported';
/**
 * Android's browsers offer the constructor and throw when it is used: known from the start (a capability, not a layout: the one place a
 * device's name decides), so the switch is never shown on there and off at the first alert.
 */
let refused = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** Whether pop-ups can be shown here, and what the browser was told. */
export function desktopPermission(): Permission {
  if (refused || typeof Notification !== 'function') return 'unsupported';
  return Notification.permission;
}

/** Ask the browser (it must follow a click): what it answered. */
export async function askDesktop(): Promise<Permission> {
  if (desktopPermission() === 'unsupported') return 'unsupported';
  try { return await Notification.requestPermission(); } catch { return desktopPermission(); }
}

/** Show `m`; `m.sticky` keeps it on screen until it is closed (a bell's), where the system allows that. */
export function popUp(m: Outgoing): Outcome {
  if (desktopPermission() !== 'granted') return { ok: false, problem: 'refused' };
  try {
    // `renotify`: a bell that goes off again replaces its pop-up and still says so (sound, a flash), rather than swapping it in silently.
    const options: NotificationOptions & { renotify?: boolean } = { body: m.body, tag: m.key, icon: './icons/icon-192.png', requireInteraction: m.sticky === true, renotify: true };
    const n = new Notification(m.title, options);
    n.onclick = () => { try { window.focus(); } catch { /* the browser would not */ } n.close(); };
    return { ok: true };
  } catch {
    // A browser that offers the constructor and throws (Android) never shows one: said as "not here" from now on.
    refused = true;
    return { ok: false, problem: 'refused' };
  }
}
