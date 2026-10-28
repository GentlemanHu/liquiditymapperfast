import { readDoc, type DrawDoc } from './model.ts';

/**
 * Where the drawings are kept: this browser's storage, under a key of their own, apart from the page's settings and the layouts (a drawing
 * belongs to a person's own chart, as a VWAP anchor does). A document written by a newer page is left as it is: this page shows none of it
 * and writes nothing over it. Another tab saving its drawings is picked up here (`onOtherTab`).
 */
export const DRAW_KEY = 'hlm-drawings-v1';

export interface DrawStore {
  /** The drawings, or null when the browser holds a document this page cannot read (a newer version): then nothing is saved. */
  load(): DrawDoc | null;
  /** Whether the document was written; false when the browser refused (full, or storage switched off). */
  save(doc: DrawDoc): boolean;
  /** Another tab of this page wrote the drawings. */
  onOtherTab(listener: () => void): void;
}

/** The browser's own storage (an empty document where it has none or will not say). */
export function browserStore(storage: Storage | null = safeStorage()): DrawStore {
  return {
    load() {
      try { const raw = storage?.getItem(DRAW_KEY); return raw ? readDoc(JSON.parse(raw)) : { version: 1, coins: {} }; }
      catch { return { version: 1, coins: {} }; }
    },
    save(doc) {
      try { storage?.setItem(DRAW_KEY, JSON.stringify(doc)); return storage !== null; } catch { return false; }
    },
    onOtherTab(listener) { window.addEventListener('storage', e => { if (e.key === DRAW_KEY) listener(); }); },
  };
}

function safeStorage(): Storage | null { try { return window.localStorage; } catch { return null; } }
