import { ScriptSyntaxError, tokenize, type Token } from './lexer.ts';

/**
 * The script language's grammar: a small part of JavaScript's (expressions, `var`/`let`/`const`, `if`/`else`, `for`, `while`, blocks, plain
 * functions) with one addition, named arguments in a call (`line(x, color=red)`). A statement ends at a semicolon, or at a line break where the
 * next token could not continue it, as JavaScript reads it. Every node keeps where it starts, so an error points at its line and column.
 */

export interface Pos { line: number; col: number }
export type Expr =
  | { k: 'num'; v: number; p: Pos }
  | { k: 'str'; v: string; p: Pos }
  | { k: 'id'; name: string; p: Pos }
  | { k: 'arr'; items: Expr[]; p: Pos }
  | { k: 'obj'; props: { key: string; value: Expr }[]; p: Pos }
  | { k: 'un'; op: string; arg: Expr; p: Pos }
  | { k: 'upd'; op: '++' | '--'; prefix: boolean; target: Expr; p: Pos }
  | { k: 'bin'; op: string; a: Expr; b: Expr; p: Pos }
  | { k: 'logic'; op: '&&' | '||' | '??'; a: Expr; b: Expr; p: Pos }
  | { k: 'cond'; test: Expr; yes: Expr; no: Expr; p: Pos }
  | { k: 'assign'; op: string; target: Expr; value: Expr; p: Pos }
  | { k: 'member'; obj: Expr; name: string; optional: boolean; p: Pos }
  | { k: 'index'; obj: Expr; index: Expr; optional: boolean; p: Pos }
  | { k: 'call'; callee: Expr; args: Expr[]; named: { name: string; value: Expr; p: Pos; /** Its text as written, for a value that is read as text (`id=nr1-all`). */ raw: string }[]; p: Pos }
  | { k: 'fn'; params: string[]; body: Stmt[]; p: Pos }
  | { k: 'new'; name: string; args: Expr[]; p: Pos }
  | { k: 'seq'; items: Expr[]; p: Pos };
export type Stmt =
  | { k: 'expr'; e: Expr; p: Pos }
  | { k: 'decl'; kind: 'var' | 'let' | 'const'; items: { name: string; init: Expr | null; p: Pos }[]; p: Pos }
  | { k: 'if'; test: Expr; yes: Stmt; no: Stmt | null; p: Pos }
  | { k: 'for'; init: Stmt | null; test: Expr | null; update: Expr | null; body: Stmt; p: Pos }
  | { k: 'while'; test: Expr; body: Stmt; p: Pos }
  | { k: 'dowhile'; body: Stmt; test: Expr; p: Pos }
  | { k: 'block'; body: Stmt[]; p: Pos }
  | { k: 'break' | 'continue'; p: Pos }
  | { k: 'return'; e: Expr | null; p: Pos }
  | { k: 'func'; name: string; params: string[]; body: Stmt[]; p: Pos }
  | { k: 'empty'; p: Pos };

/** Words that cannot name a variable. */
export const RESERVED = new Set(['var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'return', 'function', 'new', 'delete', 'typeof', 'void', 'in', 'of', 'instanceof', 'this', 'class', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'with', 'yield', 'await', 'import', 'export', 'super', 'extends', 'true', 'false', 'null', 'debugger', 'enum']);

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
/** Binary operators by precedence, loosest first (`??` beside `||`, as close as this grammar needs). */
const LEVELS: readonly (readonly string[])[] = [['||', '??'], ['&&'], ['|'], ['^'], ['&'], ['==', '!=', '===', '!=='], ['<', '>', '<=', '>='], ['<<', '>>', '>>>'], ['+', '-'], ['*', '/', '%']];
/** How deeply expressions and blocks may nest: a script nested deeper is refused rather than overflowing the parser's stack. */
const MAX_DEPTH = 200;
/** How long one chain of operators (`a + b + c ...`), members or calls may be: each link is one level deeper in the tree. */
const MAX_CHAIN = 400;

export function parse(text: string): Stmt[] {
  const toks = tokenize(text);
  let i = 0, depth = 0;
  const peek = (o = 0): Token => toks[Math.min(i + o, toks.length - 1)]!;
  const pos = (t: Token = peek()): Pos => ({ line: t.line, col: t.col });
  const fail = (code: string, t: Token = peek(), detail?: string): never => { throw new ScriptSyntaxError({ code, line: t.line, col: t.col, ...(detail !== undefined ? { detail } : t.text ? { detail: t.text } : {}) }); };
  const isOp = (v: string, t: Token = peek()): boolean => t.kind === 'op' && t.value === v;
  const isWord = (v: string, t: Token = peek()): boolean => t.kind === 'id' && t.value === v;
  const eat = (v: string): Token => { if (!isOp(v)) fail(peek().kind === 'eof' ? 'unexpected-end' : 'expected', peek(), v); return toks[i++]!; };
  const enter = (): void => { if (++depth > MAX_DEPTH) fail('too-deep'); };
  const name = (): string => {
    const t = peek();
    if (t.kind !== 'id' || RESERVED.has(t.text)) fail('expected-name');
    i++; return t.text;
  };

  /** The end of a statement: a semicolon, a closing brace or the end (left for the block), or a line break. */
  const end = (): void => {
    if (isOp(';')) { i++; return; }
    if (isOp('}') || peek().kind === 'eof' || peek().nl) return;
    fail('expected-end');
  };

  function statement(): Stmt {
    enter();
    try {
      const t = peek(), p = pos(t);
      if (isOp(';')) { i++; return { k: 'empty', p }; }
      if (isOp('{')) return { k: 'block', body: block(), p };
      if (t.kind === 'id') {
        switch (t.text) {
          case 'var': case 'let': case 'const': { i++; const s = declaration(t.text, p); end(); return s; }
          case 'if': {
            i++; eat('('); const test = expression(); eat(')');
            const yes = statement();
            if (isOp(';') && isWord('else', peek(1))) i++;
            const no = isWord('else') ? (i++, statement()) : null;
            return { k: 'if', test, yes, no, p };
          }
          case 'for': {
            i++; eat('(');
            const init = isOp(';') ? null : isWord('var') || isWord('let') || isWord('const') ? declaration((i++, toks[i - 1]!.text) as 'var', pos()) : { k: 'expr' as const, e: expression(), p: pos() };
            if (isWord('of') || isWord('in')) fail('unsupported', peek(), 'for-in');
            eat(';');
            const test = isOp(';') ? null : expression(); eat(';');
            const update = isOp(')') ? null : expression(); eat(')');
            return { k: 'for', init, test, update, body: statement(), p };
          }
          case 'while': { i++; eat('('); const test = expression(); eat(')'); return { k: 'while', test, body: statement(), p }; }
          case 'do': {
            i++; const body = statement();
            if (!isWord('while')) fail('expected', peek(), 'while');
            i++; eat('('); const test = expression(); eat(')'); end();
            return { k: 'dowhile', body, test, p };
          }
          case 'break': case 'continue': i++; end(); return { k: t.text, p };
          case 'return': { i++; const e = isOp(';') || isOp('}') || peek().kind === 'eof' || peek().nl ? null : expression(); end(); return { k: 'return', e, p }; }
          case 'function': {
            i++; const n = name(); const params = paramList(); const body = block();
            return { k: 'func', name: n, params, body, p };
          }
          case 'switch': case 'try': case 'throw': case 'class': case 'import': case 'export': case 'with': case 'delete': case 'async': case 'await': case 'yield':
            fail('unsupported', t, t.text);
        }
      }
      const e = expression(); end();
      return { k: 'expr', e, p };
    } finally { depth--; }
  }

  function declaration(kind: string, p: Pos): Stmt {
    const items: { name: string; init: Expr | null; p: Pos }[] = [];
    do {
      const at = pos(), n = name();
      items.push({ name: n, init: isOp('=') ? (i++, assignment()) : null, p: at });
    } while (isOp(',') && (i++, true));
    return { k: 'decl', kind: kind as 'var', items, p };
  }

  function block(): Stmt[] {
    eat('{');
    const body: Stmt[] = [];
    while (!isOp('}')) { if (peek().kind === 'eof') fail('unexpected-end'); body.push(statement()); }
    i++; return body;
  }

  function paramList(): string[] {
    eat('(');
    const params: string[] = [];
    while (!isOp(')')) { params.push(name()); if (!isOp(')')) eat(','); }
    i++; return params;
  }

  /** A comma-separated sequence (only where JavaScript allows one: a statement, a `for` header, parentheses). */
  function expression(): Expr {
    const first = assignment();
    if (!isOp(',')) return first;
    const items = [first];
    while (isOp(',')) { i++; items.push(assignment()); }
    return { k: 'seq', items, p: first.p };
  }

  function assignment(): Expr {
    enter();
    try {
      const start = i;
      // An arrow function: `x => ...` or `(a, b) => ...`.
      if (peek().kind === 'id' && isOp('=>', peek(1))) { const p = pos(); const param = name(); i++; return arrowBody([param], p); }
      if (isOp('(')) {
        let j = i + 1, ok = true;
        const params: string[] = [];
        while (!isOp(')', toks[j]!)) { const t = toks[j]!; if (t.kind !== 'id' || RESERVED.has(t.text)) { ok = false; break; } params.push(t.text); j++; if (isOp(',', toks[j]!)) j++; else if (!isOp(')', toks[j]!)) { ok = false; break; } }
        if (ok && isOp('=>', toks[j + 1]!)) { const p = pos(); i = j + 2; return arrowBody(params, p); }
      }
      const left = conditional();
      const t = peek();
      if (t.kind === 'op' && ASSIGN.has(t.text)) {
        if (left.k !== 'id' && left.k !== 'member' && left.k !== 'index') fail('bad-assignment', toks[start]!);
        i++;
        return { k: 'assign', op: t.text, target: left, value: assignment(), p: left.p };
      }
      return left;
    } finally { depth--; }
  }

  function arrowBody(params: string[], p: Pos): Expr {
    if (isOp('{')) return { k: 'fn', params, body: block(), p };
    const e = assignment();
    return { k: 'fn', params, body: [{ k: 'return', e, p: e.p }], p };
  }

  function conditional(): Expr {
    const test = binary(0);
    if (!isOp('?')) return test;
    i++;
    const yes = assignment(); eat(':');
    return { k: 'cond', test, yes, no: assignment(), p: test.p };
  }

  function binary(level: number): Expr {
    if (level >= LEVELS.length) return exponent();
    let left = binary(level + 1);
    for (let links = 0; ; links++) {
      const t = peek();
      if (t.kind !== 'op' || !LEVELS[level]!.includes(t.text)) return left;
      if (links >= MAX_CHAIN) fail('too-deep');
      i++;
      const right = binary(level + 1);
      left = t.text === '&&' || t.text === '||' || t.text === '??' ? { k: 'logic', op: t.text, a: left, b: right, p: left.p } : { k: 'bin', op: t.text, a: left, b: right, p: left.p };
    }
  }

  function exponent(): Expr {
    const base = unary();
    if (!isOp('**')) return base;
    i++;
    enter();
    try { return { k: 'bin', op: '**', a: base, b: exponent(), p: base.p }; } finally { depth--; }
  }

  function unary(): Expr {
    enter();
    try {
      const t = peek(), p = pos(t);
      if (t.kind === 'op' && (t.text === '!' || t.text === '-' || t.text === '+' || t.text === '~')) { i++; return { k: 'un', op: t.text, arg: unary(), p }; }
      if (isWord('typeof')) { i++; return { k: 'un', op: 'typeof', arg: unary(), p }; }
      if (t.kind === 'op' && (t.text === '++' || t.text === '--')) { i++; const target = unary(); return { k: 'upd', op: t.text, prefix: true, target, p }; }
      const e = postfix();
      const n = peek();
      if (n.kind === 'op' && (n.text === '++' || n.text === '--') && !n.nl) { i++; return { k: 'upd', op: n.text, prefix: false, target: e, p: e.p }; }
      return e;
    } finally { depth--; }
  }

  function postfix(): Expr {
    let e = primary();
    for (let links = 0; ; links++) {
      const t = peek();
      if (links > MAX_CHAIN) fail('too-deep');
      if (isOp('.') || isOp('?.')) {
        const optional = t.text === '?.'; i++;
        if (optional && isOp('(')) { e = call(e); continue; }
        if (optional && isOp('[')) { i++; const index = expression(); eat(']'); e = { k: 'index', obj: e, index, optional, p: e.p }; continue; }
        const n = peek();
        if (n.kind !== 'id') fail('expected-name');
        i++; e = { k: 'member', obj: e, name: n.text, optional, p: e.p };
      } else if (isOp('[')) { i++; const index = expression(); eat(']'); e = { k: 'index', obj: e, index, optional: false, p: e.p }; }
      else if (isOp('(')) e = call(e);
      else return e;
    }
  }

  /** A call's arguments: values in order, and `name = value` pairs (a word then a single `=`) taken by name. */
  function call(callee: Expr): Expr {
    const p = pos(); eat('(');
    const args: Expr[] = [], named: { name: string; value: Expr; p: Pos; raw: string }[] = [];
    while (!isOp(')')) {
      if (peek().kind === 'id' && isOp('=', peek(1))) {
        const at = pos(); const n = peek().text; i += 2;
        const from = peek().at, value = assignment(), to = toks[i - 1]!;
        named.push({ name: n, value, p: at, raw: text.slice(from, to.at + to.text.length).trim() });
      }
      else if (isOp('...')) fail('unsupported', peek(), '...');
      else args.push(assignment());
      if (!isOp(')')) eat(',');
    }
    i++;
    return { k: 'call', callee, args, named, p: callee.k === 'id' ? callee.p : p };
  }

  function primary(): Expr {
    const t = peek(), p = pos(t);
    if (t.kind === 'num') { i++; return { k: 'num', v: t.value as number, p }; }
    if (t.kind === 'str') { i++; return { k: 'str', v: t.value as string, p }; }
    if (t.kind === 'id') {
      if (t.text === 'function') { i++; if (peek().kind === 'id') name(); const params = paramList(); return { k: 'fn', params, body: block(), p }; }
      // `new` makes the few things the language can make: a date (`new Date(ms)`) and an array (`new Array(n)`).
      if (t.text === 'new') {
        i++; const c = peek();
        if (c.kind !== 'id' || (c.text !== 'Date' && c.text !== 'Array')) fail('unsupported', t, 'new');
        i++; const args: Expr[] = [];
        if (isOp('(')) { i++; while (!isOp(')')) { args.push(assignment()); if (!isOp(')')) eat(','); } i++; }
        return { k: 'new', name: c.text, args, p };
      }
      if (t.text === 'this' || t.text === 'class' || t.text === 'delete' || t.text === 'await' || t.text === 'yield' || t.text === 'import') fail('unsupported', t, t.text);
      if (RESERVED.has(t.text) && t.text !== 'true' && t.text !== 'false' && t.text !== 'null') fail('unexpected', t);
      i++; return { k: 'id', name: t.text, p };
    }
    if (isOp('(')) { i++; const e = expression(); eat(')'); return e; }
    if (isOp('[')) {
      i++; const items: Expr[] = [];
      while (!isOp(']')) { items.push(assignment()); if (!isOp(']')) eat(','); }
      i++; return { k: 'arr', items, p };
    }
    if (isOp('{')) {
      i++; const props: { key: string; value: Expr }[] = [];
      while (!isOp('}')) {
        const k = peek();
        if (k.kind !== 'id' && k.kind !== 'str' && k.kind !== 'num') fail('expected-name');
        i++;
        const key = String(k.value);
        if (isOp(':')) { i++; props.push({ key, value: assignment() }); }
        else if (k.kind === 'id') props.push({ key, value: { k: 'id', name: key, p: pos(k) } });
        else fail('expected', peek(), ':');
        if (!isOp('}')) eat(',');
      }
      i++; return { k: 'obj', props, p };
    }
    return fail(t.kind === 'eof' ? 'unexpected-end' : 'unexpected', t);
  }

  // A line break ends a statement only where the next token cannot continue it: the operators above read on across it, as in JavaScript.
  const out: Stmt[] = [];
  while (peek().kind !== 'eof') out.push(statement());
  return out;
}
