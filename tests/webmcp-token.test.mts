import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test("the page carries Chrome's WebMCP origin-trial token for its own origin", () => {
  const html = fs.readFileSync('src/app/index.html', 'utf8');
  const token = /<meta http-equiv="origin-trial" content="([A-Za-z0-9+/=]+)">/.exec(html)?.[1];
  assert.ok(token, 'the meta tag is there');
  // A token: a version byte, a 64-byte signature, the payload's length (4 bytes, big-endian), then the payload as JSON.
  const bytes = Buffer.from(token, 'base64'), length = bytes.readUInt32BE(65);
  const payload = JSON.parse(bytes.subarray(69, 69 + length).toString('utf8')) as { origin: string; feature: string; expiry: number };
  assert.equal(payload.feature, 'WebMCP');
  assert.equal(payload.origin, 'https://liquiditymapperfast.github.io:443');
  assert.ok(!('isSubdomain' in payload) && !('isThirdParty' in payload), 'for this origin only');
});
