import type { Expr, Stmt } from './parser.ts';

/** Walks of a parsed script that do not run it: the places of its calls, and the names it declares. */

/** Numbers each call in the text, in order, so the same call is the same site on every candle. */
export function numberSites(stmts: readonly Stmt[]): Map<Expr, number> {
  const sites = new Map<Expr, number>();
  const walkE = (e: Expr | null | undefined): void => {
    if (!e) return;
    switch (e.k) {
      case 'call': sites.set(e, sites.size); walkE(e.callee); e.args.forEach(walkE); e.named.forEach(n => walkE(n.value)); return;
      case 'arr': e.items.forEach(walkE); return;
      case 'obj': e.props.forEach(p => walkE(p.value)); return;
      case 'un': walkE(e.arg); return;
      case 'upd': walkE(e.target); return;
      case 'bin': case 'logic': walkE(e.a); walkE(e.b); return;
      case 'cond': walkE(e.test); walkE(e.yes); walkE(e.no); return;
      case 'assign': walkE(e.target); walkE(e.value); return;
      case 'member': walkE(e.obj); return;
      case 'index': walkE(e.obj); walkE(e.index); return;
      case 'fn': e.body.forEach(walkS); return;
      case 'seq': e.items.forEach(walkE); return;
      case 'new': e.args.forEach(walkE); return;
      default: return;
    }
  };
  const walkS = (s: Stmt): void => {
    switch (s.k) {
      case 'expr': walkE(s.e); return;
      case 'decl': s.items.forEach(d => walkE(d.init)); return;
      case 'if': walkE(s.test); walkS(s.yes); if (s.no) walkS(s.no); return;
      case 'for': if (s.init) walkS(s.init); walkE(s.test); walkE(s.update); walkS(s.body); return;
      case 'while': case 'dowhile': walkE(s.test); walkS(s.body); return;
      case 'block': s.body.forEach(walkS); return;
      case 'return': walkE(s.e); return;
      case 'func': s.body.forEach(walkS); return;
      default: return;
    }
  };
  stmts.forEach(walkS);
  return sites;
}

/** The names a script declares with `var`, `let`, `const` or `function` anywhere, and the parameters of its functions: none of them is kept between candles. */
export function declaredNames(stmts: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  const walkE = (e: Expr | null | undefined): void => {
    if (!e) return;
    if (e.k === 'fn') { e.params.forEach(p => out.add(p)); e.body.forEach(walkS); return; }
    for (const v of Object.values(e)) {
      if (v && typeof v === 'object') { if (Array.isArray(v)) v.forEach(x => { if (x && typeof x === 'object' && 'k' in x) walkE(x as Expr); else if (x && typeof x === 'object' && 'value' in x) walkE((x as { value: Expr }).value); }); else if ('k' in v) walkE(v as Expr); }
    }
  };
  const walkS = (s: Stmt): void => {
    switch (s.k) {
      case 'decl': s.items.forEach(d => { out.add(d.name); walkE(d.init); }); return;
      case 'func': out.add(s.name); s.params.forEach(p => out.add(p)); s.body.forEach(walkS); return;
      case 'expr': walkE(s.e); return;
      case 'if': walkE(s.test); walkS(s.yes); if (s.no) walkS(s.no); return;
      case 'for': if (s.init) walkS(s.init); walkE(s.test); walkE(s.update); walkS(s.body); return;
      case 'while': case 'dowhile': walkE(s.test); walkS(s.body); return;
      case 'block': s.body.forEach(walkS); return;
      case 'return': walkE(s.e); return;
      default: return;
    }
  };
  stmts.forEach(walkS);
  return out;
}
