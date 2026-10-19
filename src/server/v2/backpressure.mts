/**
 * What the live socket may send a client that has `buffered` bytes queued (`WebSocket.bufferedAmount`), by the kind of frame.
 *
 * A snapshot (the books' levels) replaces the one before it, so a client that cannot keep up loses nothing by being skipped: it is the
 * frame that fills the queue (about 430 KB, three or four times a second with 26 venues: 1.5 MB/s, measured 2026-10-19) and the only one
 * worth skipping. An event (the trade dust's batch, prints, flow, absorption, liquidations, ticks, the heartbeat) is a few hundred bytes to a
 * few KB: skipping one saves nothing, and for the trade dust, which the page keeps only from what it was sent, it leaves a hole in the live
 * trades. The trade dust used to be skipped at 2 MB, below the 4 MB at which the levels were, so a client that stalled for a few seconds was still sent
 * the big frames while the small ones were dropped: 19 batches lost over an 8 s stall (probe against the live server, 2026-10-19).
 * A client that is further behind than `CLIENT_DROP_BYTES` is dropped (it reconnects and starts again) rather than buffered without bound.
 */
export const CLIENT_DROP_BYTES = 16_000_000;
/** Snapshots are skipped from this much queued. */
export const SNAPSHOT_SKIP_BYTES = 4_000_000;

export type FrameKind = 'snapshot' | 'event';
export type SendVerdict = 'send' | 'skip' | 'drop';

export function sendVerdict(kind: FrameKind, buffered: number): SendVerdict {
  if (buffered > CLIENT_DROP_BYTES) return 'drop';
  return kind === 'snapshot' && buffered >= SNAPSHOT_SKIP_BYTES ? 'skip' : 'send';
}
