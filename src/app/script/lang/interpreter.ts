import type { Expr, Pos, Stmt } from './parser.ts';
import { numberSites } from './walk.ts';
import { DateValue, NativeFunction, ScriptFunction, ScriptRuntimeError, own, add, compare, getMember, isCallable, keyOf, looseEquals, num, plain, setMember, text, truthy, typeOf, MAX_ARRAY, MAX_TEXT, type Value } from './values.ts';

/**
 * Walks a parsed script. It knows the language (scopes, operators, control flow, functions, the step budget) and nothing about candles: a
 * `Host` answers the names a script reads that it did not declare itself, and decides what a call to one of the language's functions does
 * (a call is given its place in the text, so a function that keeps state, `sma`, keeps one per place). Every statement, loop turn and call
 * spends a step; a script that runs out of steps is stopped with `budget`, which is how a loop that never ends is caught.
 */

export interface Host {
  /** The value of a name the script did not declare (an input, `Math`, a function of the language); `undefined` with `known` false when there is none. */
  global(name: string): { known: boolean; value: Value };
  /** Called for a call whose callee is a function of the language (`NativeFunction`), with the call's place in the text. */
  callNative?(fn: NativeFunction, args: Value[], named: Record<string, Value> | null, site: number, node: Extract<Expr, { k: 'call' }>): Value;
  /** A name the script assigns without declaring it (`x = 1` at the top): kept from candle to candle. */
  persistent?(name: string): { get(): Value; set(v: Value): void } | null;
  /** `name[n]` on a name the host keeps the history of: the value `n` candles ago; null when the host does not keep that name's history. */
  history?(name: string, back: number): { value: Value } | null;
  /** Wraps the whole of a call, its arguments included (`source(expr)` reads `expr` over its own markets). */
  aroundCall?(node: Extract<Expr, { k: 'call' }>, run: () => Value): Value;
  /** `new Date(...)`, `new Array(n)`. */
  construct?(name: string, args: Value[]): Value;
  /** Whether a call to the language's function `fn` at `site` needs its named arguments read (a plot reads them once, `source` never). */
  wantsNamed?(fn: NativeFunction, site: number): boolean;
}

class Scope {
  readonly vars = new Map<string, { v: Value; konst: boolean }>();
  constructor(readonly parent: Scope | null) {}
  find(name: string): { v: Value; konst: boolean } | undefined {
    for (let s: Scope | null = this; s; s = s.parent) { const b = s.vars.get(name); if (b) return b; }
    return undefined;
  }
}

/** Thrown to unwind a `break`, `continue` or `return`. */
class Jump { constructor(readonly kind: 'break' | 'continue' | 'return', readonly value: Value = undefined) {} }

export interface Budget { steps: number; left: number; deadline: number; now: () => number }

/**
 * Spend steps for what a script makes, so memory is bounded with time: an element of an array is a step, sixteen characters of a text are one.
 * A loop that makes large things runs out of steps long before it fills memory.
 */
export function charge(b: Budget, steps: number): void {
  if (!(steps > 0)) return;
  b.left -= steps; b.steps += steps;
  if (b.left < 0) throw new ScriptRuntimeError('budget');
}
/** A text a method made: held to `MAX_TEXT` and paid for. */
function madeText(b: Budget, s: string): string {
  if (s.length > MAX_TEXT) throw new ScriptRuntimeError('too-large', 0, 0, 'text');
  charge(b, s.length >> 4);
  return s;
}


const METHOD_STRING = new Set(['slice', 'substring', 'substr', 'toUpperCase', 'toLowerCase', 'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd', 'charAt', 'charCodeAt', 'split', 'concat', 'padStart', 'padEnd', 'toString', 'replace', 'replaceAll', 'at']);
const METHOD_NUMBER = new Set(['toFixed', 'toPrecision', 'toString', 'toLocaleString']);

export class Interpreter {
  readonly sites: Map<Expr, number>;
  readonly globalScope = new Scope(null);
  #fnScope: Scope;
  #depth = 0;

  constructor(readonly program: readonly Stmt[], readonly host: Host, readonly budget: Budget) {
    this.sites = numberSites(program);
    this.#fnScope = this.globalScope;
  }

  /** Spend steps; stop the script when none are left or its time is up. */
  #spend(p: Pos, n = 1): void {
    const b = this.budget;
    b.left -= n; b.steps += n;
    if (b.left < 0) throw new ScriptRuntimeError('budget', p.line, p.col);
    if ((b.steps & 0xffff) === 0 && b.now() > b.deadline) throw new ScriptRuntimeError('too-slow', p.line, p.col);
  }

  /** Run the whole script once (one candle), in a scope of its own: `var`s start again each candle, the host keeps what persists. */
  runOnce(): void {
    const scope = new Scope(this.globalScope);
    this.#hoist(this.program, scope);
    try { for (const s of this.program) this.exec(s, scope); }
    catch (e) { if (e instanceof Jump) { if (e.kind !== 'return') throw new ScriptRuntimeError('bad-jump'); return; } throw e; }
  }

  /** Functions declared in `body` exist before its first line, and every `var` of it (in its blocks too, not in its functions) is undefined until set. */
  #hoist(body: readonly Stmt[], scope: Scope): void {
    const vars = (s: Stmt): void => {
      switch (s.k) {
        case 'decl': if (s.kind === 'var') for (const d of s.items) if (!scope.vars.has(d.name)) scope.vars.set(d.name, { v: undefined, konst: false }); return;
        case 'if': vars(s.yes); if (s.no) vars(s.no); return;
        case 'for': if (s.init) vars(s.init); vars(s.body); return;
        case 'while': case 'dowhile': vars(s.body); return;
        case 'block': s.body.forEach(vars); return;
        default: return;
      }
    };
    for (const s of body) {
      if (s.k === 'func') scope.vars.set(s.name, { v: this.#makeFn(s.name, s.params, s.body, scope, s.p), konst: false });
      else vars(s);
    }
  }

  #makeFn(name: string, params: readonly string[], body: readonly Stmt[], closure: Scope, p: Pos): ScriptFunction {
    return new ScriptFunction(name || 'anonymous', args => {
      this.#spend(p);
      if (++this.#depth > 200) { this.#depth = 0; throw new ScriptRuntimeError('too-deep', p.line, p.col); }
      const scope = new Scope(closure);
      params.forEach((n, i) => scope.vars.set(n, { v: args[i], konst: false }));
      const before = this.#fnScope; this.#fnScope = scope;
      this.#hoist(body, scope);
      try { for (const s of body) this.exec(s, scope); return undefined; }
      catch (e) { if (e instanceof Jump && e.kind === 'return') return e.value; if (e instanceof Jump) throw new ScriptRuntimeError('bad-jump', p.line, p.col); throw e; }
      finally { this.#fnScope = before; this.#depth--; }
    });
  }

  exec(s: Stmt, scope: Scope): void {
    this.#spend(s.p);
    switch (s.k) {
      case 'empty': case 'func': return;
      case 'expr': this.eval(s.e, scope); return;
      case 'decl':
        for (const d of s.items) {
          const v = d.init ? this.eval(d.init, scope) : undefined;
          // A `var` with no value names the binding and leaves what it holds (`var x;` after `x = 5` is still 5).
          if (s.kind === 'var') { const b = this.#varBinding(d.name, scope); if (d.init) b.v = v; }
          else { if (scope.vars.has(d.name) && s.kind !== 'let') throw new ScriptRuntimeError('redeclared', d.p.line, d.p.col, d.name); scope.vars.set(d.name, { v, konst: s.kind === 'const' }); }
        }
        return;
      case 'if': if (truthy(this.eval(s.test, scope))) this.exec(s.yes, new Scope(scope)); else if (s.no) this.exec(s.no, new Scope(scope)); return;
      case 'block': { const inner = new Scope(scope); this.#hoistFunctions(s.body, inner); for (const x of s.body) this.exec(x, inner); return; }
      case 'while':
        while (truthy(this.eval(s.test, scope))) {
          this.#spend(s.p);
          try { this.exec(s.body, new Scope(scope)); }
          catch (e) { if (e instanceof Jump && e.kind === 'break') break; if (e instanceof Jump && e.kind === 'continue') continue; throw e; }
        }
        return;
      case 'for': {
        let loop = new Scope(scope);
        if (s.init) this.exec(s.init, loop);
        // `let`/`const` in the header: each turn has its own copy of them (a function made in a turn keeps that turn's value), as in JavaScript.
        const own = s.init?.k === 'decl' && s.init.kind !== 'var' ? s.init.items.map(d => d.name) : [];
        const turn = (): void => { if (!own.length) return; const next = new Scope(scope); for (const n of own) { const b = loop.vars.get(n); if (b) next.vars.set(n, { v: b.v, konst: b.konst }); } loop = next; };
        turn();
        for (;;) {
          if (s.test && !truthy(this.eval(s.test, loop))) break;
          this.#spend(s.p);
          try { this.exec(s.body, new Scope(loop)); }
          catch (e) { if (e instanceof Jump && e.kind === 'break') break; if (!(e instanceof Jump && e.kind === 'continue')) throw e; }
          turn();
          if (s.update) this.eval(s.update, loop);
        }
        return;
      }
      case 'dowhile':
        for (;;) {
          this.#spend(s.p);
          try { this.exec(s.body, new Scope(scope)); }
          catch (e) { if (e instanceof Jump && e.kind === 'break') break; if (!(e instanceof Jump && e.kind === 'continue')) throw e; }
          if (!truthy(this.eval(s.test, scope))) break;
        }
        return;
      case 'break': case 'continue': throw new Jump(s.k);
      case 'return': throw new Jump('return', s.e ? this.eval(s.e, scope) : undefined);
    }
  }

  #hoistFunctions(body: readonly Stmt[], scope: Scope): void {
    for (const s of body) if (s.k === 'func') scope.vars.set(s.name, { v: this.#makeFn(s.name, s.params, s.body, scope, s.p), konst: false });
  }

  /** The binding a `var` writes: the nearest function's (or the candle's) scope, as JavaScript hoists it. */
  #varBinding(name: string, scope: Scope): { v: Value; konst: boolean } {
    for (let sc: Scope | null = scope; sc; sc = sc.parent) {
      const b = sc.vars.get(name);
      if (b) return b;
      if (sc === this.#fnScope || sc.parent === this.globalScope) { const nb = { v: undefined as Value, konst: false }; sc.vars.set(name, nb); return nb; }
    }
    const nb = { v: undefined as Value, konst: false }; scope.vars.set(name, nb); return nb;
  }

  #read(name: string, scope: Scope, p: Pos): Value {
    const b = scope.find(name);
    if (b) return b.v;
    const kept = this.host.persistent?.(name);
    if (kept) return kept.get();
    const g = this.host.global(name);
    if (g.known) return g.value;
    throw new ScriptRuntimeError('unknown-name', p.line, p.col, name);
  }

  #write(name: string, v: Value, scope: Scope, p: Pos): void {
    const b = scope.find(name);
    if (b) { if (b.konst) throw new ScriptRuntimeError('const', p.line, p.col, name); b.v = v; return; }
    const kept = this.host.persistent?.(name);
    if (kept) { kept.set(v); return; }
    throw new ScriptRuntimeError('read-only', p.line, p.col, name);
  }

  eval(e: Expr, scope: Scope): Value {
    switch (e.k) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'id':
        if (e.name === 'true') return true;
        if (e.name === 'false') return false;
        if (e.name === 'null') return null;
        return this.#read(e.name, scope, e.p);
      case 'arr': {
        if (e.items.length > MAX_ARRAY) throw new ScriptRuntimeError('too-large', e.p.line, e.p.col, 'array');
        charge(this.budget, e.items.length);
        return e.items.map(x => this.eval(x, scope));
      }
      case 'obj': { const o = plain(); for (const p of e.props) { if (p.key === '__proto__') continue; o[p.key] = this.eval(p.value, scope); } return o; }
      case 'un': {
        if (e.op === 'typeof') { if (e.arg.k === 'id' && !scope.find(e.arg.name) && !this.host.persistent?.(e.arg.name) && !this.host.global(e.arg.name).known) return 'undefined'; return typeOf(this.eval(e.arg, scope)); }
        const v = this.eval(e.arg, scope);
        return e.op === '!' ? !truthy(v) : e.op === '-' ? -num(v) : e.op === '+' ? num(v) : ~num(v);
      }
      case 'upd': {
        const ref = this.#ref(e.target, scope);
        const old = num(ref.get()), next = e.op === '++' ? old + 1 : old - 1;
        ref.set(next);
        return e.prefix ? next : old;
      }
      case 'bin': return this.#binary(e.op, this.eval(e.a, scope), this.eval(e.b, scope), e.p);
      case 'logic': {
        const a = this.eval(e.a, scope);
        if (e.op === '&&') return truthy(a) ? this.eval(e.b, scope) : a;
        if (e.op === '||') return truthy(a) ? a : this.eval(e.b, scope);
        return a === null || a === undefined ? this.eval(e.b, scope) : a;
      }
      case 'cond': return truthy(this.eval(e.test, scope)) ? this.eval(e.yes, scope) : this.eval(e.no, scope);
      case 'assign': {
        const ref = this.#ref(e.target, scope);
        if (e.op === '=') { const v = this.eval(e.value, scope); ref.set(v); return v; }
        const cur = ref.get();
        if (e.op === '&&=') { if (!truthy(cur)) return cur; const v = this.eval(e.value, scope); ref.set(v); return v; }
        if (e.op === '||=') { if (truthy(cur)) return cur; const v = this.eval(e.value, scope); ref.set(v); return v; }
        if (e.op === '??=') { if (cur !== null && cur !== undefined) return cur; const v = this.eval(e.value, scope); ref.set(v); return v; }
        const v = this.#binary(e.op.slice(0, -1), cur, this.eval(e.value, scope), e.p);
        ref.set(v);
        return v;
      }
      case 'member': {
        const obj = this.eval(e.obj, scope);
        if (e.optional && (obj === null || obj === undefined)) return undefined;
        return this.#member(obj, e.name, e.p);
      }
      case 'index': {
        if (e.obj.k === 'id' && !scope.find(e.obj.name) && this.host.history) {
          const back = this.eval(e.index, scope);
          const h = typeof back === 'number' ? this.host.history(e.obj.name, back) : null;
          if (h) return h.value;
        }
        const obj = this.eval(e.obj, scope);
        if (e.optional && (obj === null || obj === undefined)) return undefined;
        return this.#member(obj, keyOf(this.eval(e.index, scope)), e.p);
      }
      case 'call': return this.host.aroundCall ? this.host.aroundCall(e, () => this.#call(e, scope)) : this.#call(e, scope);
      case 'fn': return this.#makeFn('', e.params, e.body, scope, e.p);
      case 'new': {
        const args = e.args.map(x => this.eval(x, scope));
        this.#spend(e.p);
        if (!this.host.construct) throw new ScriptRuntimeError('unsupported', e.p.line, e.p.col, 'new');
        try { return this.host.construct(e.name, args); }
        catch (err) { if (err instanceof ScriptRuntimeError && !err.line) throw new ScriptRuntimeError(err.code, e.p.line, e.p.col, err.detail); throw err; }
      }
      case 'seq': { let v: Value; for (const x of e.items) v = this.eval(x, scope); return v; }
    }
  }

  #member(obj: Value, key: string, p: Pos): Value {
    try { return getMember(obj, key, (o, k) => this.#method(o, k, p)); }
    catch (err) { if (err instanceof ScriptRuntimeError && !err.line) throw new ScriptRuntimeError(err.code, p.line, p.col, err.detail); throw err; }
  }

  /** What an assignment writes to: a name, or an object and a key worked out once (`a[i++]++` moves `i` once). */
  #ref(target: Expr, scope: Scope): { get(): Value; set(v: Value): void } {
    const at = (err: unknown): never => { if (err instanceof ScriptRuntimeError && !err.line) throw new ScriptRuntimeError(err.code, target.p.line, target.p.col, err.detail); throw err; };
    const pay = (n: number): void => charge(this.budget, n);
    if (target.k === 'id') return { get: () => this.#read(target.name, scope, target.p), set: v => this.#write(target.name, v, scope, target.p) };
    if (target.k === 'member' || target.k === 'index') {
      const obj = this.eval(target.obj, scope);
      const key = target.k === 'member' ? target.name : keyOf(this.eval(target.index, scope));
      return { get: () => this.#member(obj, key, target.p), set: v => { try { setMember(obj, key, v, pay); } catch (err) { at(err); } } };
    }
    throw new ScriptRuntimeError('bad-assignment', target.p.line, target.p.col);
  }

  #binary(op: string, a: Value, b: Value, p: Pos): Value {
    switch (op) {
      case '+': { const r = add(a, b); if (typeof r === 'string' && r.length > 64) { try { charge(this.budget, r.length >> 4); } catch (err) { if (err instanceof ScriptRuntimeError) throw new ScriptRuntimeError(err.code, p.line, p.col); throw err; } } return r; }
      case '-': return num(a) - num(b);
      case '*': return num(a) * num(b);
      case '/': return num(a) / num(b);
      case '%': return num(a) % num(b);
      case '**': return num(a) ** num(b);
      case '==': return looseEquals(a, b);
      case '!=': return !looseEquals(a, b);
      case '===': return a === b || (typeof a === 'number' && typeof b === 'number' && a === b);
      case '!==': return !(a === b);
      case '<': case '>': case '<=': case '>=': return compare(op, a, b);
      case '&': return num(a) & num(b);
      case '|': return num(a) | num(b);
      case '^': return num(a) ^ num(b);
      case '<<': return num(a) << num(b);
      case '>>': return num(a) >> num(b);
      case '>>>': return num(a) >>> num(b);
    }
    throw new ScriptRuntimeError('unsupported', p.line, p.col, op);
  }

  /** Call a function value: the script's own, or one of the language's (through the host, so state is kept per place). */
  invoke(fn: Value, args: Value[], named: Record<string, Value> | null, p: Pos, site = -1, node?: Extract<Expr, { k: 'call' }>): Value {
    if (fn instanceof ScriptFunction) return fn.call(args);
    if (fn instanceof NativeFunction) {
      this.#spend(p);
      try { return node && this.host.callNative ? this.host.callNative(fn, args, named, site, node) : fn.call(args, named); }
      catch (err) { if (err instanceof ScriptRuntimeError && !err.line) throw new ScriptRuntimeError(err.code, p.line, p.col, err.detail); throw err; }
    }
    throw new ScriptRuntimeError('not-callable', p.line, p.col);
  }

  /** The language's function a call names, per call: looked up once, since nothing the script does changes what such a name is. */
  readonly #natives = new Map<Expr, NativeFunction>();

  #call(e: Extract<Expr, { k: 'call' }>, scope: Scope): Value {
    let fn: Value;
    if (e.callee.k === 'member') {
      const obj = this.eval(e.callee.obj, scope);
      if (e.callee.optional && (obj === null || obj === undefined)) return undefined;
      fn = this.#member(obj, e.callee.name, e.p);
    } else if (e.callee.k === 'id') {
      const name = e.callee.name, cached = this.#natives.get(e);
      if (cached && !scope.find(name)) fn = cached;
      else {
        fn = this.eval(e.callee, scope);
        if (fn instanceof NativeFunction && !scope.find(name) && !this.host.persistent?.(name)) this.#natives.set(e, fn);
      }
    } else fn = this.eval(e.callee, scope);
    if (!isCallable(fn)) throw new ScriptRuntimeError('not-callable', e.p.line, e.p.col, e.callee.k === 'id' ? e.callee.name : e.callee.k === 'member' ? e.callee.name : undefined);
    const args = e.args.map(a => this.eval(a, scope));
    const site = this.sites.get(e) ?? -1;
    let named: Record<string, Value> | null = null;
    if (e.named.length && (!(fn instanceof NativeFunction) || !this.host.wantsNamed || this.host.wantsNamed(fn, site))) {
      named = Object.create(null) as Record<string, Value>;
      // A named value is read as a value; a plain word (`title=PERP`, `type=spot`) or a text the script cannot read as one (`id=nr1-all`)
      // is that text itself.
      for (const n of e.named) {
        if (n.value.k === 'id' && !this.#knows(n.value.name, scope)) { named[n.name] = n.value.name; continue; }
        try { named[n.name] = this.eval(n.value, scope); }
        catch (err) { if (err instanceof ScriptRuntimeError && err.code === 'unknown-name' && n.raw) named[n.name] = n.raw; else throw err; }
      }
    }
    return this.invoke(fn, args, named, e.p, site, e);
  }

  #knows(name: string, scope: Scope): boolean {
    return name === 'true' || name === 'false' || name === 'null' || !!scope.find(name) || !!this.host.persistent?.(name) || this.host.global(name).known;
  }

  /** The methods of texts, numbers, arrays and dates a script may call. */
  #method(obj: Value, key: string, p: Pos): NativeFunction | undefined {
    if (typeof obj === 'string') {
      if (!METHOD_STRING.has(key)) return undefined;
      return new NativeFunction(key, args => {
        const a = args.map(x => typeof x === 'number' || typeof x === 'string' ? x : x === undefined ? undefined : text(x));
        if ((key === 'padStart' || key === 'padEnd') && num(a[0] as Value) > 10_000) throw new ScriptRuntimeError('too-large', p.line, p.col, 'text');
        if (key === 'split') { const parts = (obj.split(String(a[0] ?? ''), a[1] === undefined ? undefined : Math.min(num(a[1] as Value), MAX_ARRAY)) as Value[]).slice(0, MAX_ARRAY); charge(this.budget, parts.length); return parts; }
        // Plain texts only: a pattern or a function never reaches the real `replace`.
        if (key === 'replace' || key === 'replaceAll') return madeText(this.budget, obj[key](String(a[0] ?? ''), String(a[1] ?? '')));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = (String.prototype as unknown as Record<string, (...x: unknown[]) => unknown>)[key]!.apply(obj, a);
        return typeof r === 'string' ? madeText(this.budget, r) : typeof r === 'number' || typeof r === 'boolean' ? r : undefined;
      });
    }
    if (typeof obj === 'number') {
      if (!METHOD_NUMBER.has(key)) return undefined;
      return new NativeFunction(key, args => {
        const d = args[0] === undefined ? undefined : Math.max(0, Math.min(key === 'toString' ? 36 : 100, Math.trunc(num(args[0]))));
        if (key === 'toFixed') return obj.toFixed(d ?? 0);
        if (key === 'toPrecision') return d === undefined ? String(obj) : obj.toPrecision(Math.max(1, d));
        if (key === 'toString') return d === undefined || d < 2 ? String(obj) : obj.toString(d);
        return obj.toLocaleString('en-US');
      });
    }
    if (Array.isArray(obj)) return this.#arrayMethod(obj, key, p);
    if (obj instanceof DateValue) return dateMethod(obj.ms, key);
    return undefined;
  }

  #arrayMethod(arr: Value[], key: string, p: Pos): NativeFunction | undefined {
    const call = (fn: Value, args: Value[]): Value => this.invoke(fn, args, null, p);
    const grow = (n: number): void => { if (arr.length + n > MAX_ARRAY) throw new ScriptRuntimeError('too-large', p.line, p.col, 'array'); charge(this.budget, n); };
    const methods: Record<string, (args: Value[]) => Value> = {
      push: args => { grow(args.length); return arr.push(...args); },
      pop: () => arr.pop(), shift: () => arr.shift(),
      unshift: args => { grow(args.length); return arr.unshift(...args); },
      slice: args => { charge(this.budget, arr.length); return arr.slice(args[0] === undefined ? undefined : num(args[0]), args[1] === undefined ? undefined : num(args[1])); },
      splice: args => { grow(Math.max(0, args.length - 2)); return arr.splice(num(args[0]), args[1] === undefined ? arr.length : num(args[1]), ...args.slice(2)); },
      concat: args => {
        const parts = args.map(a => Array.isArray(a) ? a : [a]), total = parts.reduce((t, a) => t + a.length, arr.length);
        if (total > MAX_ARRAY) throw new ScriptRuntimeError('too-large', p.line, p.col, 'array');
        charge(this.budget, total);
        return arr.concat(...parts);
      },
      indexOf: args => arr.indexOf(args[0]), lastIndexOf: args => arr.lastIndexOf(args[0]), includes: args => arr.includes(args[0]),
      join: args => { charge(this.budget, arr.length); return madeText(this.budget, arr.map(x => x === null || x === undefined ? '' : text(x)).join(args[0] === undefined ? ',' : text(args[0]))); },
      reverse: () => arr.reverse(),
      fill: args => arr.fill(args[0], args[1] === undefined ? undefined : num(args[1]), args[2] === undefined ? undefined : num(args[2])),
      at: args => arr.at(num(args[0])),
      sort: args => { const f = args[0]; this.#spend(p, arr.length); return f === undefined ? arr.sort((a, b) => text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0) : arr.sort((a, b) => num(call(f, [a, b]))); },
      map: args => { charge(this.budget, arr.length); return arr.map((x, i) => call(args[0], [x, i, arr])); },
      filter: args => { charge(this.budget, arr.length); return arr.filter((x, i) => truthy(call(args[0], [x, i, arr]))); },
      forEach: args => { arr.forEach((x, i) => { call(args[0], [x, i, arr]); }); return undefined; },
      find: args => arr.find((x, i) => truthy(call(args[0], [x, i, arr]))),
      findIndex: args => arr.findIndex((x, i) => truthy(call(args[0], [x, i, arr]))),
      some: args => arr.some((x, i) => truthy(call(args[0], [x, i, arr]))),
      every: args => arr.every((x, i) => truthy(call(args[0], [x, i, arr]))),
      reduce: args => args.length > 1 ? arr.reduce((acc, x, i) => call(args[0], [acc, x, i, arr]), args[1]) : arr.reduce((acc, x, i) => call(args[0], [acc, x, i, arr])),
    };
    const m = own(methods, key);
    return m ? new NativeFunction(key, args => m(args)) : undefined;
  }
}

/** The readings of a date a script may call (UTC and local, as JavaScript gives them). */
export function dateMethod(ms: number, key: string): NativeFunction | undefined {
  const d = new Date(ms);
  const ok = Number.isFinite(ms);
  const table: Record<string, () => Value> = {
    getTime: () => ms, valueOf: () => ms,
    toISOString: () => ok ? d.toISOString() : 'Invalid Date',
    toString: () => ok ? d.toString() : 'Invalid Date',
    toUTCString: () => ok ? d.toUTCString() : 'Invalid Date',
    getUTCFullYear: () => d.getUTCFullYear(), getUTCMonth: () => d.getUTCMonth(), getUTCDate: () => d.getUTCDate(), getUTCDay: () => d.getUTCDay(),
    getUTCHours: () => d.getUTCHours(), getUTCMinutes: () => d.getUTCMinutes(), getUTCSeconds: () => d.getUTCSeconds(),
    getFullYear: () => d.getFullYear(), getMonth: () => d.getMonth(), getDate: () => d.getDate(), getDay: () => d.getDay(),
    getHours: () => d.getHours(), getMinutes: () => d.getMinutes(), getSeconds: () => d.getSeconds(),
  };
  const f = own(table, key);
  return f ? new NativeFunction(key, () => f()) : undefined;
}
