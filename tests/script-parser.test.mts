import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, ScriptSyntaxError } from '../src/app/script/lang/lexer.ts';
import { parse, type Expr, type Stmt } from '../src/app/script/lang/parser.ts';

const errorOf = (text: string): { code: string; line: number; col: number } => {
  try { parse(text); } catch (e) { if (e instanceof ScriptSyntaxError) return e.info; throw e; }
  assert.fail(`no error in ${JSON.stringify(text)}`);
};
const exprOf = (text: string): Expr => { const s = parse(text)[0]!; assert.equal(s.k, 'expr'); return (s as Extract<Stmt, { k: 'expr' }>).e; };

test('the tokens of a script, with where each starts and whether a line break came before it', () => {
  const toks = tokenize('a = 1.5e3 // note\n  b = "x\\n" + .5 /* c\n d */ c');
  assert.deepEqual(toks.map(t => t.text), ['a', '=', '1.5e3', 'b', '=', '"x\\n"', '+', '.5', 'c', '']);
  assert.equal(toks[2]!.value, 1500);
  assert.equal(toks[5]!.value, 'x\n');
  assert.deepEqual([toks[3]!.line, toks[3]!.col, toks[3]!.nl], [2, 3, true]);
  assert.equal(toks[8]!.nl, true, 'a block comment over a line break counts as one');
  assert.equal(tokenize('a?.5:b').map(t => t.text).join(' '), 'a ? .5 : b ');
  assert.equal(tokenize('0x1F')[0]!.value, 31);
});

test('statements end at a line break unless the next line continues them, as JavaScript reads them', () => {
  const two = parse('a = b\nc = d');
  assert.equal(two.length, 2);
  const one = parse('a = b\n  + c\n  * d');
  assert.equal(one.length, 1);
  const e = (one[0] as Extract<Stmt, { k: 'expr' }>).e;
  assert.ok(e.k === 'assign' && e.value.k === 'bin' && e.value.op === '+' && e.value.b.k === 'bin' && e.value.b.op === '*');
  assert.equal(parse('x = c ?\n 1 :\n 2').length, 1);
  assert.equal(parse('f(a,\n b,\n c)\ng()').length, 2);
  assert.equal(parse('a++\nb').length, 2, 'a ++ after a line break belongs to the next line');
  assert.deepEqual(parse('if (a) { b = 1 } else { b = 2 }; c = 3').map(s => s.k), ['if', 'empty', 'expr']);
  assert.equal(parse('if (a) b = 1; else b = 2').length, 1);
});

test('named arguments, object literals and plain words as values', () => {
  const call = exprOf('cloudarea(lo, hi, positiveColor=options.c, title=PERP)');
  assert.ok(call.k === 'call');
  assert.equal(call.args.length, 2);
  assert.deepEqual(call.named.map(n => n.name), ['positiveColor', 'title']);
  assert.ok(call.named[1]!.value.k === 'id' && call.named[1]!.value.name === 'PERP');
  const eq = exprOf('f(a == b)');
  assert.ok(eq.k === 'call' && eq.args.length === 1 && eq.named.length === 0, 'a comparison is not a named argument');
  const obj = exprOf('histogram({ time: time, value: vbuy + vsell, color })');
  assert.ok(obj.k === 'call' && obj.args[0]!.k === 'obj');
  assert.deepEqual((obj.args[0] as Extract<Expr, { k: 'obj' }>).props.map(p => p.key), ['time', 'value', 'color']);
});

test('the operators bind as in JavaScript', () => {
  const e = exprOf('a || b && c == d + e * f ** g ** h');
  assert.ok(e.k === 'logic' && e.op === '||' && e.b.k === 'logic' && e.b.op === '&&');
  const pow = exprOf('2 ** 3 ** 2');
  assert.ok(pow.k === 'bin' && pow.b.k === 'bin', 'exponent is right-associative');
  const neg = exprOf('-a.b[1](2)');
  assert.ok(neg.k === 'un' && neg.arg.k === 'call' && neg.arg.callee.k === 'index');
  const t = exprOf('x >= 94 ? p : x >= 90 ? q : r');
  assert.ok(t.k === 'cond' && t.no.k === 'cond');
});

test('declarations, loops, functions and arrows', () => {
  const s = parse('var a = 1, b\nfor (let i = 0; i < 3; i++) { if (i === 1) continue; a += i }\nfunction sq(x) { return x * x }\nconst f = (p, q) => p + q\nwhile (a > 0) a--');
  assert.deepEqual(s.map(x => x.k), ['decl', 'for', 'func', 'decl', 'while']);
  const arrow = (s[3] as Extract<Stmt, { k: 'decl' }>).items[0]!.init!;
  assert.ok(arrow.k === 'fn' && arrow.params.join() === 'p,q');
});

test('errors say what and where', () => {
  assert.deepEqual(errorOf('a = (1 +\n'), { code: 'unexpected-end', line: 2, col: 1 });
  assert.equal(errorOf('a = 1 b').code, 'expected-end');
  assert.deepEqual([errorOf('x = "open').code, errorOf('x = "open').col], ['unterminated-string', 5]);
  assert.equal(errorOf('x = #').code, 'unexpected-char');
  assert.equal(errorOf('1 = 2').code, 'bad-assignment');
  assert.equal(errorOf('new Foo()').code, 'unsupported');
  assert.equal(errorOf('x = `a ${b}`').code, 'unsupported');
  assert.equal(errorOf('var if = 2').code, 'expected-name');
  assert.equal(errorOf('x = ' + '('.repeat(500) + '1' + ')'.repeat(500)).code, 'too-deep');
});
