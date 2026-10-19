import test from 'node:test';
import assert from 'node:assert/strict';
import { LabelBoard } from '../src/app/labels.ts';

test('the names at the lines\' right ends share one board: a name that would cover a kept one is left out, whoever drew the first', () => {
  const board = new LabelBoard();
  const pocAndPreviousLow = { x0: 300, x1: 360, y0: 93, y1: 107 };
  assert.equal(board.claim(pocAndPreviousLow), true, 'the Volume profile\'s name is first');
  assert.equal(board.claim({ x0: 310, x1: 375, y0: 93, y1: 107 }), false, 'a previous low at the same price: left out');
  assert.equal(board.claim({ x0: 250, x1: 320, y0: 100, y1: 114 }), false, 'a name just below, overlapping its corner');
  assert.equal(board.claim({ x0: 300, x1: 360, y0: 107, y1: 121 }), true, 'boxes that only touch do not cover each other');
  assert.equal(board.claim({ x0: 100, x1: 160, y0: 93, y1: 107 }), true, 'the same height further left is clear');
  assert.equal(board.claim({ x0: 300, x1: 360, y0: 150, y1: 164 }), true, 'another price');
  board.clear();
  assert.equal(board.claim(pocAndPreviousLow), true, 'a new frame starts empty');
});
