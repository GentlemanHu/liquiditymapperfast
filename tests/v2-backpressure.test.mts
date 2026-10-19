import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_DROP_BYTES, SNAPSHOT_SKIP_BYTES, sendVerdict } from '../src/server/v2/backpressure.mts';

test('the marks are the ones the page was tuned against: skip snapshots from 4 MB, drop a client past 16 MB', () => {
  assert.equal(SNAPSHOT_SKIP_BYTES, 4_000_000); assert.equal(CLIENT_DROP_BYTES, 16_000_000);
});

test('a client that is not behind is sent everything', () => {
  for (const kind of ['snapshot', 'event'] as const) assert.equal(sendVerdict(kind, 0), 'send');
  assert.equal(sendVerdict('snapshot', SNAPSHOT_SKIP_BYTES - 1), 'send');
});

test('a snapshot (the books\' levels, replaced by the next) is the only frame skipped for a client that is behind', () => {
  assert.equal(sendVerdict('snapshot', SNAPSHOT_SKIP_BYTES), 'skip');
  assert.equal(sendVerdict('snapshot', CLIENT_DROP_BYTES), 'skip');
  assert.equal(sendVerdict('event', SNAPSHOT_SKIP_BYTES), 'send');
  assert.equal(sendVerdict('event', CLIENT_DROP_BYTES), 'send', 'right up to the mark at which the client is dropped');
});

test('an event is never skipped while a snapshot is still sent: the trade dust batch is 1 KB beside a 430 KB levels frame', () => {
  // The dust was skipped at 2 MB with the levels sent to 4 MB: the small frame went first and left the hole.
  for (let buffered = 0; buffered <= 2 * CLIENT_DROP_BYTES; buffered += 50_000) {
    if (sendVerdict('snapshot', buffered) === 'send') assert.equal(sendVerdict('event', buffered), 'send', `at ${buffered} bytes`);
  }
  assert.ok(SNAPSHOT_SKIP_BYTES < CLIENT_DROP_BYTES, 'snapshots stop before the client is dropped');
  // And an event is sent at every size up to the drop mark, whatever the snapshots do there.
  for (let buffered = 0; buffered <= CLIENT_DROP_BYTES; buffered += 50_000) assert.equal(sendVerdict('event', buffered), 'send', `at ${buffered} bytes`);
});

test('a client further behind than the drop mark is dropped, whatever the frame', () => {
  for (const kind of ['snapshot', 'event'] as const) assert.equal(sendVerdict(kind, CLIENT_DROP_BYTES + 1), 'drop');
});
