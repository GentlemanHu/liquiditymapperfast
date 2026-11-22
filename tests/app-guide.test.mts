import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SECTIONS, readingMinutes, wordsIn } from '../src/app/guide/content.ts';
import { parseInline, plain } from '../src/app/guide/markup.ts';
import { SCENES, fitLines, fitSize, mirrorVerdict, phraseEdges } from '../src/app/guide/figures.ts';
import { setGuideWords, tg } from '../src/app/guide/words.ts';
import { HELP } from '../src/app/help.ts';
import { depthBandVerdict } from '../src/app/hover-rows.ts';
import { BALANCED_RATIO } from '../src/app/mirror.ts';
import { LANGUAGES } from '../src/app/i18n.ts';
import { appRoot } from '../scripts/i18n-keys.mts';

type Written = { text: string; x: number; y: number; width: number; size: number; color: string };
/**
 * A canvas that measures text at a fixed width per character of the font's size, a little wider than the page's sans-serif (a character
 * from U+1100 up, Hangul or CJK, a whole em, except the punctuation of U+2000-U+206F; any other half an em; bold 8 % wider), and keeps what
 * is written, with its size and colour: enough to see how a picture fits its words to its room.
 */
function measuringCanvas(): { g: CanvasRenderingContext2D; texts: Written[] } {
  let font = '400 10px sans-serif', fill = '';
  const weight = (): number => Number(/^(\d+)\s/.exec(font)?.[1] ?? 400), size = (): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  const em = (c: string): number => { const p = c.codePointAt(0)!; return p >= 0x1100 && !(p >= 0x2000 && p <= 0x206f) ? 1 : 0.5; };
  const width = (s: string): number => [...s].reduce((sum, c) => sum + em(c), 0) * size() * (weight() >= 600 ? 1.08 : 1);
  const texts: Written[] = [];
  const g = new Proxy({}, {
    get: (_, key) => key === 'measureText' ? (s: string) => ({ width: width(s) })
      : key === 'fillText' ? (s: string, x: number, y: number) => { texts.push({ text: s, x, y, width: width(s), size: size(), color: fill }); }
        : key === 'font' ? font : () => undefined,
    set: (_, key, value) => { if (key === 'font') font = String(value); if (key === 'fillStyle') fill = String(value); return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { g, texts };
}
const theme = { bg: '#fff', panel: '#fff', text: '#000', muted: '#777', line: '#ddd', bid: '#00f', ask: '#f60', ui: '#26f', dark: false, lut: new Uint8Array(1024) };

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

test('the Mirror picture and the profile box agree on every pair of bands, with the colour each draws it in', () => {
  const th = { ask: 'ask', bid: 'bid', text: 'text', muted: 'muted' }, ink: Record<string, string> = { above: 'ask', below: 'bid', muted: 'muted' };
  const amounts = [0, -1, NaN, Infinity, 1, 4.9e6, 10e6, 10.1e6, 10.2e6, 14e6, 25e6, 1e13];
  for (const asks of amounts) for (const bids of amounts) {
    const box = depthBandVerdict(bids, asks, '1%'), picture = mirrorVerdict(asks, bids, th), where = `asks ${asks}, bids ${bids}`;
    assert.equal(picture.text.toLowerCase(), box.text.replace('Within ≈±1%: ', '').toLowerCase(), where);
    assert.equal(picture.color, box.color ? ink[box.color] : 'text', `${where}: colour`);
  }
});

test('a picture\'s line keeps to its room: one line, a little smaller, two lines at a space or a phrase\'s edge, then smaller', () => {
  const { g } = measuringCanvas();
  assert.deepEqual(fitLines(g, 'Asks 1.40× the bids', 200, 10), { lines: ['Asks 1.40× the bids'], size: 10, fits: true }, 'it fits');
  assert.deepEqual(fitLines(g, 'Asks 1.40× the bids', 115, 13), { lines: ['Asks 1.40× the bids'], size: 12.1, fits: true }, 'a little smaller, on one line');
  assert.deepEqual(fitLines(g, 'Move outward: the balance changes', 160, 10.5), { lines: ['Move outward: the', 'balance changes'], size: 10.5, fits: true }, 'small words take two lines rather than going under 10 px');
  assert.deepEqual(fitLines(g, 'Asks 1.40× so groß wie die Bids', 100, 10), { lines: ['Asks 1.40× so', 'groß wie die Bids'], size: 10, fits: true }, 'two lines, the wider as narrow as can be');
  assert.deepEqual(fitLines(g, 'Asks 1.40× so groß wie die Bids', 70, 10), { lines: ['Asks 1.40× so', 'groß wie die Bids'], size: 8.2, fits: true }, 'two smaller lines');
  assert.deepEqual(fitLines(g, 'Asks 1.40× so groß wie die Bids', 50, 10), { lines: ['Asks 1.40× so', 'groß wie die Bids'], size: 8, fits: false }, 'never below the smallest size, and says so');
  assert.deepEqual(fitLines(g, '既无买盘也无卖盘', 50, 10).lines, ['既无买盘', '也无卖盘'], 'Chinese, before its conjunction');
  assert.deepEqual(fitLines(g, '買い板と売り板はほぼ同じ', 90, 10).lines, ['買い板と', '売り板はほぼ同じ'], 'Japanese, after its particle, never inside 売り板');
  assert.deepEqual(fitLines(g, '買い板のみ', 42, 10), { lines: ['買い板のみ'], size: 8.4, fits: true }, 'no phrase edge: one smaller line, not 買い / 板のみ');
  assert.deepEqual(fitLines(g, '買い板のみ', 30, 10), { lines: ['買い', '板のみ'], size: 10, fits: true }, 'any character, where even the smallest size cannot hold one line');
  assert.equal(fitSize(g, 'abc', 100, 10), 10);
  assert.equal(fitSize(g, 'x'.repeat(50), 100, 10), 8, 'never below the smallest size');
});

test('a text without spaces breaks at a phrase\'s edge, and not at all where the word breaks have no dictionary', () => {
  assert.deepEqual(phraseEdges('プロファイルまたはオーダーブックで'), [9], 'after または');
  // Breaks without a dictionary: every character its own word.
  const each = { segment: (text: string) => [...text].map(segment => ({ segment })) };
  assert.deepEqual(phraseEdges('プロファイルまたはオーダーブックで', each), [9], 'a run of hiragana is one word: after または, never また / は');
  assert.deepEqual(phraseEdges('買い板と売り板はほぼ同じ', each), [], 'they split 買 / い, so no particle can be told from them');
  assert.deepEqual(phraseEdges('既无买盘也无卖盘', each), [4, 5], 'Chinese function words are single characters anyway');
  assert.deepEqual(phraseEdges('既无买盘也无卖盘', null), [], 'no word breaks at all');
});

test('the Mirror picture says the bands as the profile box would, in its colours', () => {
  const draw = (u: number): Written[] => { const { g, texts } = measuringCanvas(); SCENES.mirror.draw(g, 600, 300, u, theme, null); return texts; };
  const said = (texts: Written[], text: string): Written | undefined => texts.find(t => t.text === text);
  const empty = draw(0); // the pointer at the price: nothing in either band yet
  assert.equal(said(empty, 'No bids or asks')?.color, theme.muted);
  assert.ok(said(empty, 'Asks  $0') && said(empty, 'Bids  $0') && !empty.some(t => t.text.includes('$0k')), 'an empty band is $0');
  assert.equal(said(draw(0.1), 'Only bids')?.color, theme.bid, 'one band empty: no ratio over nothing');
  assert.equal(said(draw(0.55), 'Bids 1.07× the asks')?.color, theme.bid);
});

/** Draw the Mirror picture `w` px wide at moment `u` and check how its box holds its words. */
function checkMirrorBox(where: string, w: number, u: number): void {
  const { g, texts } = measuringCanvas();
  SCENES.mirror.draw(g, w, 300, u, theme, null);
  const bx = texts.find(t => t.y === 58)!.x - 12; // the box's first line, 12 px inside it
  const box = texts.filter(t => t.x >= bx && t.y > 40 && t.y < 190).sort((a, b) => a.y - b.y), under = texts.filter(t => t.x >= bx && t.y >= 190);
  // Inside its room: the box's lines 12 px inside its right edge, the key and its hint inside the picture.
  for (const t of [...box, ...under]) { const right = t.y < 190 ? w - 22 : w - 4; assert.ok(t.x + t.width <= right + 0.5, `${where}: "${t.text}" runs ${Math.round(t.x + t.width - right)} px past its room at ${t.size}px`); }
  // One under another, none over the next, all between the box's top and bottom.
  assert.ok(box.length >= 5, `${where}: the box's lines`);
  for (let i = 1; i < box.length; i++) assert.ok(box[i]!.y - box[i - 1]!.y >= (box[i]!.size + box[i - 1]!.size) / 2, `${where}: "${box[i - 1]!.text}" and "${box[i]!.text}" overlap`);
  assert.ok(box[0]!.y - box[0]!.size / 2 >= 42 && box.at(-1)!.y + box.at(-1)!.size / 2 <= 188, `${where}: a line outside the box`);
  // The key, then where to hover: after the key on its row, or under it.
  const key = under.find(t => t.text === tg('Hover')), hint = under.filter(t => t !== key);
  assert.ok(key && hint.length >= 1, `${where}: the key and its hint`);
  for (const t of hint) assert.ok(t.y > 230 ? t.x >= bx : t.x >= key!.x + key!.width + 12, `${where}: "${t.text}" over the key`);
}
const guidePack = (code: string): Record<string, string> => code === 'en' ? {} : JSON.parse(fs.readFileSync(path.join(appRoot, 'guide', 'i18n', `${code}.json`), 'utf8')) as Record<string, string>;
// 280 is the narrowest the guide draws a picture; 322 a 360 px phone's.
const PHONE_AND_DESK = [280, 322, 341, 600], MOMENTS = [0, 0.1, 0.12, 0.3, 0.55];

test('the Mirror picture fits every word of its box to the box, at every phone width and in every language', () => {
  try {
    for (const { code } of LANGUAGES) {
      setGuideWords(guidePack(code));
      for (const w of PHONE_AND_DESK) for (const u of MOMENTS) checkMirrorBox(`${code} ${w}px u=${u}`, w, u);
    }
  } finally { setGuideWords({}); }
});

test('the Mirror picture fits its Japanese and Chinese in a browser without word breaks too', () => {
  const intl = Intl as { Segmenter?: unknown }, kept = intl.Segmenter;
  try {
    intl.Segmenter = undefined; // Firefox before 125
    for (const code of ['ja', 'zh']) {
      setGuideWords(guidePack(code));
      for (const w of PHONE_AND_DESK) for (const u of MOMENTS) checkMirrorBox(`${code} without word breaks ${w}px u=${u}`, w, u);
    }
  } finally { intl.Segmenter = kept; setGuideWords({}); }
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
