import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SECTIONS, readingMinutes, wordsIn } from '../src/app/guide/content.ts';
import { parseInline, plain } from '../src/app/guide/markup.ts';
import { SCENES, fitLines, fitSize, mirrorVerdict, phraseEdges } from '../src/app/guide/figures.ts';
import { setGuideWords } from '../src/app/guide/words.ts';
import { HELP } from '../src/app/help.ts';
import { BALANCED_RATIO } from '../src/app/mirror.ts';
import { LANGUAGES } from '../src/app/i18n.ts';
import { appRoot } from '../scripts/i18n-keys.mts';

/**
 * A canvas that measures text at a fixed width per character of the font's size (a CJK or Hangul character a whole em, any other 0.55 em)
 * and keeps what is written, with the size it was written at: enough to see which lines a picture fits to its room.
 */
function measuringCanvas(): { g: CanvasRenderingContext2D; texts: { text: string; x: number; y: number; width: number; size: number }[] } {
  let font = '10px sans-serif';
  const size = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  const width = (s: string): number => [...s].reduce((sum, c) => sum + (c >= 'ᄀ' ? 1 : 0.55), 0) * size();
  const texts: { text: string; x: number; y: number; width: number; size: number }[] = [];
  const g = new Proxy({}, {
    get: (_, key) => key === 'measureText' ? (s: string) => ({ width: width(s) })
      : key === 'fillText' ? (s: string, x: number, y: number) => { texts.push({ text: s, x, y, width: width(s), size: size() }); }
        : key === 'font' ? font : () => undefined,
    set: (_, key, value) => { if (key === 'font') font = String(value); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { g, texts };
}

test('the Mirror picture says what the profile box says: the heavier side by its price side, about even, only one side', () => {
  const th = { ask: 'ask', bid: 'bid', text: 'text', muted: 'muted' };
  assert.deepEqual(mirrorVerdict(14e6, 10e6, th), { text: 'Asks 1.40× the bids', color: 'ask' });
  assert.deepEqual(mirrorVerdict(10e6, 25e6, th), { text: 'Bids 2.50× the asks', color: 'bid' });
  assert.deepEqual(mirrorVerdict(10.1e6, 10e6, th), { text: 'Bids and asks about even', color: 'text' }, 'under the balance: in no side\'s colour');
  assert.equal(mirrorVerdict(10e6 * BALANCED_RATIO, 10e6, th).color, 'ask', 'at the balance a side leads');
  assert.deepEqual(mirrorVerdict(0, 4.9e6, th), { text: 'Only bids', color: 'bid' }, 'never a ratio over an empty band (it printed "Bids have 4919206.22x more")');
  assert.deepEqual(mirrorVerdict(4.9e6, 0, th), { text: 'Only asks', color: 'ask' });
  assert.deepEqual(mirrorVerdict(0, 0, th), { text: 'No bids or asks', color: 'muted' });
});

test('a picture\'s line keeps to its room: one line, a little smaller, two lines at a space or a phrase\'s edge, then smaller', () => {
  const { g } = measuringCanvas();
  assert.deepEqual(fitLines(g, 'Asks 1.40× the bids', 200, 10), { lines: ['Asks 1.40× the bids'], size: 10 }, 'it fits');
  assert.deepEqual(fitLines(g, 'Asks 1.40× the bids', 100, 10), { lines: ['Asks 1.40× the bids'], size: 9.5 }, 'a little smaller, on one line');
  assert.deepEqual(fitLines(g, 'Asks 1.40× so groß wie die Bids', 120, 10), { lines: ['Asks 1.40× so', 'groß wie die Bids'], size: 10 }, 'two lines, the wider as narrow as can be');
  assert.deepEqual(fitLines(g, 'Asks 1.40× so groß wie die Bids', 80, 10), { lines: ['Asks 1.40× so', 'groß wie die Bids'], size: 8.5 }, 'two smaller lines');
  assert.deepEqual(fitLines(g, '既无买盘也无卖盘', 50, 10).lines, ['既无买盘', '也无卖盘'], 'Chinese, before its conjunction');
  assert.deepEqual(fitLines(g, '買い板と売り板はほぼ同じ', 90, 10).lines, ['買い板と', '売り板はほぼ同じ'], 'Japanese, after its particle, never inside 売り板');
  assert.deepEqual(fitLines(g, '買い板のみ', 30, 10), { lines: ['買い板のみ'], size: 8 }, 'no phrase edge: one smaller line, not 買い / 板のみ');
  assert.deepEqual(phraseEdges('プロファイルまたはオーダーブックで'), [9], 'after または');
  assert.equal(fitSize(g, 'abc', 100, 10), 10);
  assert.equal(fitSize(g, 'x'.repeat(50), 100, 10), 8, 'never below the smallest size');
});

test('the Mirror picture keeps every word of its box inside it on a phone, in every language', () => {
  const dir = path.join(appRoot, 'guide', 'i18n'), th = { bg: '#fff', panel: '#fff', text: '#000', muted: '#777', line: '#ddd', bid: '#00f', ask: '#f60', ui: '#26f', dark: false, lut: new Uint8Array(1024) };
  try {
    for (const { code } of LANGUAGES) {
      setGuideWords(code === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')) as Record<string, string>);
      for (const w of [341, 600]) for (const u of [0, 0.1, 0.12, 0.3, 0.55]) {
        const { g, texts } = measuringCanvas();
        SCENES.mirror.draw(g, w, 300, u, th, null);
        // The box's lines (40 to 190 px down) keep 12 px inside its right edge; the key and its hint under the box keep inside the picture.
        const bx = 8 + Math.round(w * 0.46) + 22, mine = texts.filter(t => t.x >= bx + 2), box = mine.filter(t => t.y > 40 && t.y < 190);
        assert.ok(box.length >= 5 && mine.length > box.length, `${code} ${w}px: the box's lines and the hint under it`);
        for (const t of mine) {
          const right = t.y < 190 ? w - 10 - 12 : w - 4;
          assert.ok(t.x + t.width <= right + 0.5 || t.size <= 8, `${code} ${w}px u=${u}: "${t.text}" runs ${Math.round(t.x + t.width - right)} px past its room at ${t.size}px`);
        }
      }
    }
  } finally { setGuideWords({}); }
});

// The guide may grow with the page: there is no upper limit (it was sixteen minutes, 2026-10-20, and every feature since had to trim something to fit).
// What keeps it from bloating is what each paragraph teaches, which a test cannot judge (content.ts says so where it is written).
test('the guide is long enough to teach the page', () => {
  const words = SECTIONS.reduce((sum, s) => sum + wordsIn(s), 0), minutes = readingMinutes();
  assert.ok(words >= 2200, `${words} words`);
  assert.ok(minutes >= 10, `${minutes} minutes`);
});

test('sections have unique ids and every figure and help link points at something that exists', () => {
  const ids = SECTIONS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique section ids');
  for (const id of ids) assert.match(id, /^[a-z-]+$/);
  for (const [name, topic] of Object.entries(HELP)) assert.ok(ids.includes(topic.guide), `the help for ${name} points at the section ${topic.guide}`);
  for (const section of SECTIONS) for (const block of section.blocks) if (block.t === 'fig') assert.ok(block.id in SCENES, `figure ${block.id} exists`);
  assert.deepEqual(Object.keys(SCENES).sort(), [...new Set(SECTIONS.flatMap(s => s.blocks.flatMap(b => (b.t === 'fig' ? [b.id] : []))))].sort(), 'every scene is used');
});

test('the contents list is in groups: the first section starts one, and no group is named twice', () => {
  assert.ok(SECTIONS[0]!.part, 'the first section begins a group');
  const parts = SECTIONS.flatMap(s => (s.part ? [s.part] : []));
  assert.equal(new Set(parts).size, parts.length, 'a group heading is used once');
  assert.ok(parts.length >= 5 && parts.length <= 9, `${parts.length} groups`);
  for (const section of SECTIONS) assert.ok(section.blocks.some(b => b.t === 'p' || b.t === 'list'), `${section.id} has text to show under its title in a search result`);
});

test('a feature with a "?" panel goes to the section of its own (it once pointed at a section that never mentioned it)', () => {
  const have = new Set(SECTIONS.map(s => s.id));
  const wanted: Record<string, string> = { vwap: 'vwap', keyLevels: 'key-levels', range: 'range', script: 'scripts', scriptPane: 'scripts', funding: 'funding', fundingPane: 'funding', ls: 'ls', lsPane: 'ls', delta: 'delta', deltaPane: 'delta', replay: 'goto', stats: 'bar-stats', sounds: 'sounds', depth: 'depth', depthPane: 'depth', oi: 'open-interest', oiPane: 'open-interest', lt: 'lt', ltPane: 'lt', candlePane: 'phones', tpo: 'tpo' };
  for (const [topic, id] of Object.entries(wanted)) {
    assert.ok(have.has(id), `a section ${id}`);
    assert.equal(HELP[topic as keyof typeof HELP].guide, id, `the "?" of ${topic} goes to ${id}`);
  }
});

test('the guide says what the user asked it to say', () => {
  const text = SECTIONS.map(s => plain(JSON.stringify(s))).join(' ').toLowerCase();
  assert.match(text, /no history to download/);
  assert.match(text, /recorded/);
  assert.match(text, /dashed line marks the moment the recording began/);
  assert.match(text, /24 hours/);
  assert.match(text, /mirror only shows while you hover/);
  assert.match(text, /unavailable from your location/);
  assert.match(text, /not advice/);
});

test('inline markup turns into parts and never into markup', () => {
  assert.deepEqual(parseInline('a **b** `c` [[Esc]] *d* e'), [
    { kind: 'text', text: 'a ' }, { kind: 'b', text: 'b' }, { kind: 'text', text: ' ' }, { kind: 'code', text: 'c' }, { kind: 'text', text: ' ' },
    { kind: 'kbd', text: 'Esc' }, { kind: 'text', text: ' ' }, { kind: 'i', text: 'd' }, { kind: 'text', text: ' e' },
  ]);
  assert.equal(plain('<b>x</b> **y**'), '<b>x</b> y', 'angle brackets stay text');
  assert.equal(plain('no markup'), 'no markup');
});
