import type { Answer, Request } from './channels.ts';

/**
 * The page's side of send.worker.ts: a request in, its answer out. The worker starts with the first request (most pages never send one), and
 * one that fails is started again at the next.
 *
 * A request's clock (`PAGE_TIMEOUT_MS`, the worker's own time limit and some) starts only once the worker has said it is ready and has the
 * request: a worker's script can take long to arrive (a page served from this computer holds every connection of its address with history at
 * its start), and a request counted from before would be called lost while the worker still sends it, and a second try would send it twice.
 * A worker that never says it is ready fails what waits after `START_TIMEOUT_MS`. Either way every request is answered, so nothing waits for
 * ever and the calls held stay few.
 */

const PAGE_TIMEOUT_MS = 20_000, START_TIMEOUT_MS = 60_000;

interface Call { req: Request; resolve: (answer: Answer) => void; timer: ReturnType<typeof setTimeout> | null }

export class Transport {
  #worker: Worker | null = null;
  #ready = false;
  #next = 0;
  readonly #calls = new Map<number, Call>();
  #startTimer: ReturnType<typeof setTimeout> | null = null;

  request(req: Request): Promise<Answer> {
    const worker = this.#start();
    if (!worker) return Promise.resolve({ status: 0, text: '', error: 'refused' });
    return new Promise(resolve => {
      const id = ++this.#next, call: Call = { req, resolve, timer: null };
      this.#calls.set(id, call);
      if (this.#ready) this.#post(worker, id, call);
    });
  }

  /** Hand a request to the ready worker and start its clock. */
  #post(worker: Worker, id: number, call: Call): void {
    call.timer = setTimeout(() => this.#answer(id, { status: 0, text: '', error: 'timeout' }), PAGE_TIMEOUT_MS);
    worker.postMessage({ id, req: call.req });
  }

  #answer(id: number, answer: Answer): void {
    const call = this.#calls.get(id); if (!call) return;
    this.#calls.delete(id);
    if (call.timer) clearTimeout(call.timer);
    call.resolve(answer);
  }

  /** Everything still out is answered as lost, and the next request starts a new worker. */
  #fail(worker: Worker): void {
    for (const id of [...this.#calls.keys()]) this.#answer(id, { status: 0, text: '', error: 'network' });
    try { worker.terminate(); } catch { /* already gone */ }
    if (this.#startTimer) { clearTimeout(this.#startTimer); this.#startTimer = null; }
    if (this.#worker === worker) { this.#worker = null; this.#ready = false; }
  }

  #start(): Worker | null {
    if (this.#worker) return this.#worker;
    try {
      const worker = new Worker(new URL('./send.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ ready?: boolean; id?: number; answer?: Answer }>) => {
        const data = event.data;
        if (data?.ready === true) {
          if (this.#worker !== worker || this.#ready) return;
          this.#ready = true;
          if (this.#startTimer) { clearTimeout(this.#startTimer); this.#startTimer = null; }
          for (const [id, call] of this.#calls) if (!call.timer) this.#post(worker, id, call);
          return;
        }
        if (typeof data?.id === 'number' && data.answer) this.#answer(data.id, data.answer);
      };
      // A worker already replaced may still fire an error queued before it was ended: it must not fail the new one's requests.
      worker.onerror = () => { if (this.#worker === worker) this.#fail(worker); else { try { worker.terminate(); } catch { /* already gone */ } } };
      this.#worker = worker; this.#ready = false;
      this.#startTimer = setTimeout(() => { this.#startTimer = null; if (this.#worker === worker && !this.#ready) this.#fail(worker); }, START_TIMEOUT_MS);
      return worker;
    } catch { return null; }
  }
}
