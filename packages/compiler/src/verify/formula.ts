/**
 * Formulas for the verifier (impl spec §7.1) and their SMT-LIB 2 rendering.
 *
 * Sorts are `Int` (Onus Int and Duration), `Bool`, and uninterpreted sorts
 * for everything else (Text, records, unions, opaque types, type parameters).
 * Records and unions are not lowered to datatypes: field access is an
 * uninterpreted projection and a variant test compares an uninterpreted
 * tag, which keeps every problem in the fragment z3 decides quickly.
 */

export type Sort = { readonly k: 'Int' } | { readonly k: 'Bool' } | { readonly k: 'sort'; readonly name: string };

export const INT: Sort = { k: 'Int' };
export const BOOL: Sort = { k: 'Bool' };

export type Formula =
  | { readonly k: 'int'; readonly v: bigint }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'var'; readonly name: string; readonly sort: Sort }
  /** An operator or uninterpreted function application. */
  | { readonly k: 'app'; readonly fn: string; readonly args: readonly Formula[]; readonly sort: Sort }
  | { readonly k: 'quant'; readonly quant: 'forall' | 'exists'; readonly vars: readonly { readonly name: string; readonly sort: Sort }[]; readonly body: Formula }
  | { readonly k: 'ite'; readonly cond: Formula; readonly then: Formula; readonly else: Formula; readonly sort: Sort };

export function sortEquals(a: Sort, b: Sort): boolean {
  return a.k === b.k && (a.k !== 'sort' || b.k !== 'sort' || a.name === b.name);
}

export function sortOf(f: Formula): Sort {
  switch (f.k) {
    case 'int':
      return INT;
    case 'bool':
      return BOOL;
    case 'var':
    case 'app':
    case 'ite':
      return f.sort;
    case 'quant':
      return BOOL;
  }
}

export function int(v: bigint | number): Formula {
  return { k: 'int', v: typeof v === 'bigint' ? v : BigInt(v) };
}
export const TRUE: Formula = { k: 'bool', v: true };
export const FALSE: Formula = { k: 'bool', v: false };

export function variable(name: string, sort: Sort): Formula {
  return { k: 'var', name, sort };
}

export function app(fn: string, args: readonly Formula[], sort: Sort): Formula {
  return { k: 'app', fn, args, sort };
}

export function and(...xs: Formula[]): Formula {
  const flat = xs.filter((x) => !(x.k === 'bool' && x.v));
  if (flat.some((x) => x.k === 'bool' && !x.v)) return FALSE;
  if (flat.length === 0) return TRUE;
  if (flat.length === 1) return flat[0] ?? TRUE;
  return app('and', flat, BOOL);
}

export function or(...xs: Formula[]): Formula {
  const flat = xs.filter((x) => !(x.k === 'bool' && !x.v));
  if (flat.some((x) => x.k === 'bool' && x.v)) return TRUE;
  if (flat.length === 0) return FALSE;
  if (flat.length === 1) return flat[0] ?? FALSE;
  return app('or', flat, BOOL);
}

export function not(x: Formula): Formula {
  if (x.k === 'bool') return x.v ? FALSE : TRUE;
  return app('not', [x], BOOL);
}

export function implies(a: Formula, b: Formula): Formula {
  return app('=>', [a, b], BOOL);
}

export function eq(a: Formula, b: Formula): Formula {
  return app('=', [a, b], BOOL);
}

/** Whether the formula contains multiplication of two non-constant terms, division or remainder. */
export function isNonlinear(f: Formula): boolean {
  switch (f.k) {
    case 'int':
    case 'bool':
    case 'var':
      return false;
    case 'app': {
      if (f.fn === 'div' || f.fn === 'mod') return true;
      if (f.fn === '*' && f.args.filter((a) => a.k !== 'int').length > 1) return true;
      return f.args.some(isNonlinear);
    }
    case 'quant':
      return isNonlinear(f.body);
    case 'ite':
      return isNonlinear(f.cond) || isNonlinear(f.then) || isNonlinear(f.else);
  }
}

/** Free variables of a formula, by name. */
export function freeVars(f: Formula, out = new Map<string, Sort>(), bound = new Set<string>()): Map<string, Sort> {
  switch (f.k) {
    case 'int':
    case 'bool':
      return out;
    case 'var':
      if (!bound.has(f.name)) out.set(f.name, f.sort);
      return out;
    case 'app':
      for (const a of f.args) freeVars(a, out, bound);
      return out;
    case 'quant': {
      const inner = new Set(bound);
      for (const v of f.vars) inner.add(v.name);
      return freeVars(f.body, out, inner);
    }
    case 'ite':
      freeVars(f.cond, out, bound);
      freeVars(f.then, out, bound);
      freeVars(f.else, out, bound);
      return out;
  }
}

export function sortText(s: Sort): string {
  return s.k === 'sort' ? s.name : s.k;
}

/** SMT-LIB 2 text of a formula. Effects: none. */
export function smt(f: Formula): string {
  switch (f.k) {
    case 'int':
      return f.v < 0n ? `(- ${-f.v})` : f.v.toString();
    case 'bool':
      return f.v ? 'true' : 'false';
    case 'var':
      return f.name;
    case 'app':
      return f.args.length === 0 ? f.fn : `(${f.fn} ${f.args.map(smt).join(' ')})`;
    case 'quant':
      return `(${f.quant} (${f.vars.map((v) => `(${v.name} ${sortText(v.sort)})`).join(' ')}) ${smt(f.body)})`;
    case 'ite':
      return `(ite ${smt(f.cond)} ${smt(f.then)} ${smt(f.else)})`;
  }
}
