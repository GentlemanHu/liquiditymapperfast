/**
 * The script language's words: a text cut into tokens, each with where it starts (line and column, from 1) and whether a line break came
 * before it (the parser ends a statement there when nothing can continue it, as JavaScript does). Nothing is evaluated here.
 */

export type TokenKind = 'num' | 'str' | 'id' | 'op' | 'eof';
export interface Token { kind: TokenKind; text: string; value: number | string; line: number; col: number; at: number; nl: boolean }

/** What went wrong, as a code the panel words, and where. */
export interface ScriptError { code: string; line: number; col: number; detail?: string }
export class ScriptSyntaxError extends Error {
  constructor(readonly info: ScriptError) { super(info.code); }
}

/** Operators, longest first so `===` is read before `==` and `=`. */
const OPS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', '^', '?', ':', ',', ';', '.', '(', ')', '[', ']', '{', '}'];

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdPart = (c: string): boolean => /[\w$]/.test(c);

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, lineStart = 0, nl = false;
  const fail = (code: string, at = i, detail?: string): never => { throw new ScriptSyntaxError({ code, line, col: at - lineStart + 1, ...(detail ? { detail } : {}) }); };
  const push = (kind: TokenKind, start: number, value: number | string): void => {
    out.push({ kind, text: text.slice(start, i), value, line, col: start - lineStart + 1, at: start, nl }); nl = false;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\n') { i++; line++; lineStart = i; nl = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const start = i; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') { line++; lineStart = i + 1; nl = true; } i++; }
      if (i >= text.length) fail('unterminated-comment', start);
      i += 2; continue;
    }
    const start = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let value: number;
      if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) {
        i += 2; while (/[0-9a-fA-F_]/.test(text[i] ?? '')) i++;
        value = parseInt(text.slice(start + 2, i).replace(/_/g, ''), 16);
      } else {
        while (/[0-9_]/.test(text[i] ?? '')) i++;
        if (text[i] === '.') { i++; while (/[0-9_]/.test(text[i] ?? '')) i++; }
        if (/[eE]/.test(text[i] ?? '') && /[0-9+-]/.test(text[i + 1] ?? '')) { i += 2; while (/[0-9]/.test(text[i] ?? '')) i++; }
        value = Number(text.slice(start, i).replace(/_/g, ''));
      }
      if (!Number.isFinite(value) || isIdStart(text[i] ?? '')) fail('bad-number', start);
      push('num', start, value); continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++; let value = '';
      while (i < text.length && text[i] !== c) {
        let ch = text[i]!;
        if (ch === '\n' && c !== '`') fail('unterminated-string', start);
        if (ch === '\\') {
          i++; const e = text[i] ?? '';
          ch = e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
          if (e === '\n') { line++; lineStart = i + 1; ch = ''; }
        } else if (ch === '\n') { line++; lineStart = i + 1; }
        else if (c === '`' && ch === '$' && text[i + 1] === '{') fail('unsupported', i, 'template');
        value += ch; i++;
      }
      if (i >= text.length) fail('unterminated-string', start);
      i++; push('str', start, value); continue;
    }
    if (isIdStart(c)) { while (i < text.length && isIdPart(text[i]!)) i++; push('id', start, text.slice(start, i)); continue; }
    // A colour written as `#rrggbb` (`default=#2e9bff`) is a text, as the scripts' language reads such a value.
    if (c === '#') {
      const m = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w$])/.exec(text.slice(i, i + 10));
      if (m) { i += m[0].length; push('str', start, m[0]); continue; }
    }
    let op = OPS.find(o => text.startsWith(o, i));
    if (!op) fail('unexpected-char', i, c);
    // `a?.5:b` is a condition and a number, as in JavaScript, not an optional member.
    if (op === '?.' && /[0-9]/.test(text[i + 2] ?? '')) op = '?';
    i += op!.length; push('op', start, op!);
  }
  out.push({ kind: 'eof', text: '', value: '', line, col: i - lineStart + 1, at: i, nl: true });
  return out;
}
