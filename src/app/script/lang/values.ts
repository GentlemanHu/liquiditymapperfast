/**
 * The values a script handles and what it may do with them. A script never touches a JavaScript object of the page: it gets numbers, texts,
 * true/false, its own arrays and objects (made without a prototype, so `constructor` or `__proto__` lead nowhere), its own functions, and a
 * few named objects (`Math`, `$price`, `options`) whose members are listed here one by one. Reading anything else gives `undefined`; calling
 * anything that is not a function of the script or of this list is an error.
 */

export class ScriptRuntimeError extends Error {
  constructor(readonly code: string, readonly line = 0, readonly col = 0, readonly detail?: string) { super(code); }
}

/** A function the script defined (or an arrow), called by the interpreter. */
export class ScriptFunction {
  constructor(readonly name: string, readonly call: (args: Value[]) => Value) {}
}
/** A function of the language (`sma`, `Math.max`, `rgb`, ...). `named` holds the call's `name = value` arguments; `members` are the listed ones a function has too (`Number.EPSILON`). */
export class NativeFunction {
  constructor(readonly name: string, readonly call: (args: Value[], named: Record<string, Value> | null) => Value, _unused: null = null, readonly members: HostObject | null = null) { void _unused; }
}
/** A named object of the language with a fixed list of members: what it gives for a name, and what it does when one is set. */
export class HostObject {
  constructor(readonly name: string, readonly get: (key: string) => Value, readonly set?: (key: string, value: Value) => boolean, readonly keys?: () => string[]) {}
}
/** A date (`new Date(ms)`), with the readings scripts use. */
export class DateValue { constructor(readonly ms: number) {} }

export type Plain = { [key: string]: Value };
export type Value = number | string | boolean | null | undefined | Value[] | Plain | ScriptFunction | NativeFunction | HostObject | DateValue;

/** The most elements an array, and the most characters a text, may hold: a script that tries more is stopped rather than filling memory. */
export const MAX_ARRAY = 1_000_000, MAX_TEXT = 100_000;

export const plain = (): Plain => Object.create(null) as Plain;
/** A table's own entry for `key`, never one it inherits (`constructor`, `toString`): every lookup by a name a script wrote goes through this. */
export const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
/** A script's own object: made without a prototype (`plain()`), so it is never an object of the page or of the language's machinery. */
export const isPlain = (v: Value): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === null;
export const isCallable = (v: Value): v is ScriptFunction | NativeFunction => v instanceof ScriptFunction || v instanceof NativeFunction;

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

/**
 * A value as text, as JavaScript writes it. An array is its elements joined by commas, however deeply it nests, so the work and the text are
 * bounded: past `MAX_TEXT` characters, or a million elements visited (an array that holds itself, or one shared down many levels), the
 * script is stopped with `too-large`.
 */
export function text(v: Value): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return scalarText(v);
  const budget = { visits: 0, len: 0 };
  const walk = (a: Value[], depth: number): string => {
    if (depth > 200) throw new ScriptRuntimeError('too-deep');
    let out = '';
    for (let k = 0; k < a.length; k++) {
      if (++budget.visits > 1_000_000) throw new ScriptRuntimeError('too-large', 0, 0, 'text');
      if (k) out += ',';
      const x = a[k];
      if (x !== null && x !== undefined) out += Array.isArray(x) ? walk(x, depth + 1) : typeof x === 'string' ? x : scalarText(x);
      if (out.length > MAX_TEXT) throw new ScriptRuntimeError('too-large', 0, 0, 'text');
    }
    return out;
  };
  return walk(v, 0);
}
function scalarText(v: Value): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof DateValue) return Number.isFinite(v.ms) ? new Date(v.ms).toString() : 'Invalid Date';
  if (isCallable(v)) return `function ${v.name}() { [code] }`;
  return '[object Object]';
}
export function num(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return 0;
  if (v === undefined) return NaN;
  if (typeof v === 'string') { const s = v.trim(); return s === '' ? 0 : Number(s); }
  if (v instanceof DateValue) return v.ms;
  if (Array.isArray(v)) return v.length === 0 ? 0 : v.length === 1 ? num(v[0]) : NaN;
  return NaN;
}
export const truthy = (v: Value): boolean => typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : typeof v === 'string' ? v.length > 0 : v !== null && v !== undefined && v !== false;
export function typeOf(v: Value): string {
  if (v === null) return 'object';
  if (isCallable(v)) return 'function';
  const t = typeof v;
  return t === 'object' ? 'object' : t;
}
/** A text a script makes, held to `MAX_TEXT`. */
export function capped(s: string): string {
  if (s.length > MAX_TEXT) throw new ScriptRuntimeError('too-large', 0, 0, 'text');
  return s;
}

/** JavaScript's `+`: text when either side is one, numbers otherwise. */
export function add(a: Value, b: Value): Value {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  const pa = primitive(a), pb = primitive(b);
  if (typeof pa === 'string' || typeof pb === 'string') return capped(text(pa) + text(pb));
  return num(pa) + num(pb);
}
/** JavaScript's conversion of an object to a plain value: a date to its text (or, compared as a number, its time), an array or object to its text. */
const primitive = (v: Value, hint: 'default' | 'number' = 'default'): Value => v instanceof DateValue ? (hint === 'number' ? v.ms : text(v)) : Array.isArray(v) || isPlain(v) ? text(v) : isCallable(v) || v instanceof HostObject ? text(v) : v;
const isObject = (v: Value): boolean => typeof v === 'object' && v !== null;

/** JavaScript's `==` for the values a script has: an object against a plain value is compared as its plain value. */
export function looseEquals(a: Value, b: Value): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (isObject(a) && isObject(b)) return false;
  const pa = isObject(a) ? primitive(a) : a, pb = isObject(b) ? primitive(b) : b;
  const ta = typeof pa, tb = typeof pb;
  if ((ta === 'number' || ta === 'string' || ta === 'boolean') && (tb === 'number' || tb === 'string' || tb === 'boolean')) return ta === tb ? pa === pb : num(pa) === num(pb);
  return false;
}
/** JavaScript's `<`, `>`, `<=`, `>=`: two texts by their characters, anything else as numbers, objects first made plain values. */
export function compare(op: string, a: Value, b: Value): boolean {
  const pa = isObject(a) ? primitive(a, 'number') : a, pb = isObject(b) ? primitive(b, 'number') : b;
  if (typeof pa === 'string' && typeof pb === 'string') return op === '<' ? pa < pb : op === '>' ? pa > pb : op === '<=' ? pa <= pb : pa >= pb;
  const x = num(pa), y = num(pb);
  return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
}

/** A member of a value, as a script reads it (`undefined` for anything not listed). */
export function getMember(obj: Value, key: string, methods: (obj: Value, key: string) => NativeFunction | undefined): Value {
  if (FORBIDDEN.has(key)) return undefined;
  if (obj === null || obj === undefined) throw new ScriptRuntimeError('no-member', 0, 0, key);
  if (obj instanceof HostObject) return obj.get(key);
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length;
    if (/^(0|[1-9]\d*)$/.test(key)) return obj[Number(key)];
    return methods(obj, key);
  }
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length;
    if (/^(0|[1-9]\d*)$/.test(key)) return obj[Number(key)];
    return methods(obj, key);
  }
  if (typeof obj === 'number' || typeof obj === 'boolean' || obj instanceof DateValue) return methods(obj, key);
  if (isCallable(obj)) return key === 'name' ? obj.name : obj instanceof NativeFunction && obj.members ? obj.members.get(key) : undefined;
  // Only a script's own object has members to read; anything else that got here (it should not) reads as nothing.
  return isPlain(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Set a member: on the script's own arrays and objects, and on the named objects that take one (`$price.color`). */
export function setMember(obj: Value, key: string, value: Value, pay: (n: number) => void = () => {}): void {
  if (FORBIDDEN.has(key)) throw new ScriptRuntimeError('no-member', 0, 0, key);
  if (obj instanceof HostObject) { if (!obj.set?.(key, value)) throw new ScriptRuntimeError('read-only', 0, 0, `${obj.name}.${key}`); return; }
  if (Array.isArray(obj)) {
    if (key === 'length') { const n = num(value); if (!(Number.isInteger(n) && n >= 0 && n <= MAX_ARRAY)) throw new ScriptRuntimeError('too-large', 0, 0, 'array'); if (n > obj.length) pay(n - obj.length); obj.length = n; return; }
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new ScriptRuntimeError('read-only', 0, 0, key);
    const i = Number(key); if (i >= MAX_ARRAY) throw new ScriptRuntimeError('too-large', 0, 0, 'array');
    if (i >= obj.length) pay(i + 1 - obj.length);
    obj[i] = value; return;
  }
  if (isPlain(obj)) { obj[key] = value; return; }
  throw new ScriptRuntimeError('read-only', 0, 0, key);
}

/** A key from an index value (`a[i]`, `o['k']`). */
export function keyOf(v: Value): string {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? String(v) : String(v);
  return text(v);
}

/** A copy of a script value as plain data for the page (plot styles): numbers, texts, true/false, arrays and objects of those. */
export function toData(v: Value, depth = 0): import('../records.ts').OptionValue | undefined {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.slice(0, 64).map(x => toData(x, depth + 1) ?? null);
  if (isPlain(v)) {
    const out: Record<string, import('../records.ts').OptionValue> = {};
    for (const [k, x] of Object.entries(v).slice(0, 64)) { const d = toData(x, depth + 1); if (d !== undefined) out[k] = d; }
    return out;
  }
  return undefined;
}

/** A plain value of the page (an option's value) as a script value: its own arrays and objects, so the page's are never handed over. */
export function fromData(v: unknown, depth = 0): Value {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (depth > 4 || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) return v.map(x => fromData(x, depth + 1));
  const out = plain();
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!FORBIDDEN.has(k)) out[k] = fromData(x, depth + 1);
  return out;
}
