import test from 'node:test';
import assert from 'node:assert/strict';
import { CUE_LOOKS, HEAT_KINDS, LADDER_CUES_DEFAULT, SENSES, SENSE_SCALE_USD, readLadderCues } from '../src/app/panes/ladder-cue-settings.ts';
import { LAYOUT_KEYS, initialState, readSettings } from '../src/app/store.ts';

test('a page that saved no cue settings gets them on, and every choice it saved is kept', () => {
  assert.deepEqual(readLadderCues(undefined), LADDER_CUES_DEFAULT);
  assert.deepEqual(readLadderCues({}), LADDER_CUES_DEFAULT);
  assert.equal(LADDER_CUES_DEFAULT.look, 'wash'); assert.equal(LADDER_CUES_DEFAULT.heat, 'added'); assert.equal(LADDER_CUES_DEFAULT.contact, true); assert.equal(LADDER_CUES_DEFAULT.sense, 'normal');
  for (const look of CUE_LOOKS) for (const heat of HEAT_KINDS) for (const contact of [true, false]) for (const sense of SENSES) assert.deepEqual(readLadderCues({ look, heat, contact, sense }), { look, heat, contact, sense });
  assert.deepEqual(readLadderCues({ look: 'off', heat: 'off', contact: false, sense: 'calm' }), { look: 'off', heat: 'off', contact: false, sense: 'calm' }, 'an explicit Off is a choice and stays');
});

test('a value that is not one of the choices gets the default, field by field', () => {
  assert.deepEqual(readLadderCues({ look: 'glow', heat: 'added' }), { look: 'wash', heat: 'added', contact: true, sense: 'normal' });
  assert.deepEqual(readLadderCues({ look: 'rim', heat: 7, contact: 'yes', sense: 'loud' }), { look: 'rim', heat: 'added', contact: true, sense: 'normal' });
  for (const junk of [null, 5, 'wash', [], true]) assert.deepEqual(readLadderCues(junk), LADDER_CUES_DEFAULT);
});

test('the cue settings travel with saved pages and layouts, and a layout from before them reads as the defaults', () => {
  assert.ok((LAYOUT_KEYS as readonly string[]).includes('ladderCues'));
  const state = initialState();
  assert.deepEqual(state.ladderCues, LADDER_CUES_DEFAULT);
  assert.deepEqual(readSettings({ ladderCues: { look: 'deposit', heat: 'activity', contact: false, sense: 'lively' } }).ladderCues, { look: 'deposit', heat: 'activity', contact: false, sense: 'lively' });
  assert.deepEqual(readSettings({}).ladderCues, LADDER_CUES_DEFAULT);
  assert.deepEqual(readSettings({ ladderCues: 'nonsense' }).ladderCues, LADDER_CUES_DEFAULT);
});

test('a calmer setting needs a larger change to be as strong, and every size is for the coin on screen', () => {
  assert.ok(SENSE_SCALE_USD.calm > SENSE_SCALE_USD.normal && SENSE_SCALE_USD.normal > SENSE_SCALE_USD.lively && SENSE_SCALE_USD.lively > 0);
});
