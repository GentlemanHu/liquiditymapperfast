import test from 'node:test';
import assert from 'node:assert/strict';
import { PressGuard, placeTip } from '../src/app/tip.ts';
import { HELP } from '../src/app/help.ts';

const viewport = { w: 1000, h: 700 };

test('a tooltip sits centred under its anchor', () => {
  const at = placeTip({ left: 400, right: 460, top: 40, bottom: 66 }, { w: 200, h: 60 }, viewport);
  assert.equal(at.above, false);
  assert.equal(at.top, 74);
  assert.equal(at.left, 330);
});

test('it flips above when there is no room below, and stays inside the window', () => {
  const low = placeTip({ left: 400, right: 460, top: 650, bottom: 676 }, { w: 200, h: 60 }, viewport);
  assert.equal(low.above, true);
  assert.equal(low.top, 650 - 8 - 60);
  const edge = placeTip({ left: 960, right: 1000, top: 10, bottom: 30 }, { w: 300, h: 40 }, viewport);
  assert.equal(edge.left, 1000 - 8 - 300, 'kept off the right edge');
  const corner = placeTip({ left: 0, right: 20, top: 10, bottom: 30 }, { w: 300, h: 40 }, viewport);
  assert.equal(corner.left, 8, 'kept off the left edge');
});

test('every help topic says what it is and points at a guide section', () => {
  for (const [id, topic] of Object.entries(HELP)) {
    assert.ok(topic.tip.length > 30, `${id} has a real tooltip`);
    assert.ok(topic.tip.length < 420, `${id} tooltip stays short`);
    assert.ok(/^[a-z-]+$/.test(topic.guide), `${id} names a guide section`);
  }
  assert.match(HELP.mirror.tip, /Nothing changes until you hover/, "Mirror's help says the box only shows while you hover");
});

// Karl, 2026-11-22: the Depth pane's Source dropdown sometimes left its tip over the open list. The control a mouse or pen pressed keeps its
// tip shut until the pointer moves on (tip.ts PressGuard): the press focuses it, and the open list hands the pointer back over the same
// control, and either showed the tip again.
test('the control just pressed shows no tip, on the pointer coming back over it or on the focus the press gave it, until the pointer moves on', () => {
  const guard = new PressGuard<string>();
  assert.equal(guard.over('source'), true, 'before any press, a tip may show');
  guard.press('source');
  assert.equal(guard.focus('source'), false, 'the focus the press gave it');
  assert.equal(guard.over('source'), false, 'the pointer back over it from the open list');
  assert.equal(guard.over('source'), false, 'and again');
  assert.equal(guard.focus('bars'), true, 'focus on another control shows its tip');
  assert.equal(guard.over('bars'), true, 'the pointer over another control: its tip, and the guard ends');
  assert.equal(guard.over('source'), true, 'so coming back to the dropdown later shows its tip again');
  guard.press('source');
  assert.equal(guard.over(null), false, 'over the map, which has no tip: none, and the guard ends');
  assert.equal(guard.over('source'), true, 'so hovering the dropdown again shows its tip');
  guard.press('source'); guard.key();
  assert.equal(guard.focus('source'), true, 'a key pressed: keyboard focus shows tips again');
  guard.press('source'); guard.press(null);
  assert.equal(guard.over('source'), true, 'a later press on something without a tip ends the guard');
});

test('while the pressed control\x27s own list is open, the guard holds wherever the pointer goes; other controls still show their tips', () => {
  let open = true;
  const guard = new PressGuard<string>(node => node === 'source' && open);
  guard.press('source');
  assert.equal(guard.over(null), false, 'over a row of the list the page draws (no tip)');
  assert.equal(guard.over('source'), false, 'back over the dropdown with its list open: no tip over the list');
  assert.equal(guard.over('bars'), true, 'another control may show its tip');
  assert.equal(guard.over('source'), false, 'and the dropdown still shows none');
  guard.key();
  assert.equal(guard.over('source'), false, 'a key while its list is open (the arrows in it) does not end the guard');
  open = false;
  assert.equal(guard.over(null), false, 'the list closed, over the map: the guard ends');
  assert.equal(guard.over('source'), true);
  guard.press('source'); open = true; guard.key(); open = false; guard.key();
  assert.equal(guard.focus('source'), true, 'a key once its list is closed ends it');
});

