/**
 * How long the page's own requests to its source have been done (2026-11-22). The Flow history's warm-up (`HeatPane.#warmStep`) waits for
 * the page's own loads to drain before it asks for anything, so it never slows a start or a switch: on the page's own server a start's
 * requests waited 6 to 14 s for each other. The server's routes are counted through `fetch` in net.ts and server-source.ts, from a request's
 * start to its answer's headers (on the page's own server the body follows at once); the page's own engine through its worker calls
 * (browser-source.ts), from the call to its answer. Live data comes over sockets and worker messages, which are not requests.
 */
let inFlight = 0, quietSince = 0;

/** Count `work` as one request of the page's own until it settles. */
export function track<T>(work: Promise<T>): Promise<T> {
  inFlight++;
  const done = (): void => { inFlight = Math.max(0, inFlight - 1); if (!inFlight) quietSince = performance.now(); };
  return work.then(value => { done(); return value; }, (error: unknown) => { done(); throw error; });
}

/** `fetch`, counted. */
export const trackedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => track(fetch(input, init));

/** Milliseconds since the last of the page's own requests settled; 0 while one is out. */
export function quietMs(now = performance.now()): number { return inFlight > 0 ? 0 : now - quietSince; }

/** For tests: nothing out, quiet since the clock's start. */
export function resetQuiet(): void { inFlight = 0; quietSince = 0; }
