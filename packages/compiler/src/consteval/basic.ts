/**
 * The check-time evaluator for literals, constants and simple arithmetic
 * (impl spec milestone 2). Milestone 4 extends it to `const fn` bodies under
 * a step budget; this module stays the leaf evaluator.
 */
import type { DefId, ResolveTables } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import type { ConstValue } from '../types/type.js';

export interface ConstEnv {
  readonly resolve: ResolveTables;
  /** The value of a `const` definition, or null when it is not evaluable. */
  readonly constOf: (def: DefId) => ConstValue | null;
}

/**
 * Evaluates `e` if it is a constant expression (§3.8): a literal, a `const`
 * name, a nullary variant, `Unit`, a parameter usable as an index (yielding a
 * symbolic value), or arithmetic, comparison and boolean operators over
 * constants. Returns null otherwise, including on division by zero.
 * Effects: none.
 */
export function evalBasic(e: A.Expr, env: ConstEnv): ConstValue | null {
  switch (e.kind) {
    case 'IntLit':
      return { k: 'int', v: e.value };
    case 'FloatLit':
      return { k: 'float', v: e.value };
    case 'BoolLit':
      return { k: 'bool', v: e.value };
    case 'TextLit':
      return { k: 'text', v: e.value };
    case 'DurationLit':
      return { k: 'duration', v: e.nanos };
    case 'Name': {
      const r = env.resolve.refs.get(e.id);
      if (r === undefined || r.k !== 'def') return null;
      const d = env.resolve.def(r.def);
      if (d.kind === 'const') return env.constOf(d.id);
      if (d.kind === 'const-param' || d.kind === 'param') return { k: 'sym', def: d.id };
      return null;
    }
    case 'Ctor': {
      if (e.args !== null || e.fields !== null) return null;
      const r = env.resolve.refs.get(e.id);
      if (r === undefined) return null;
      if (r.k === 'unit') return { k: 'unit' };
      if (r.k === 'def' && env.resolve.def(r.def).kind === 'variant') return { k: 'variant', def: r.def };
      return null;
    }
    case 'Unary': {
      const v = evalBasic(e.operand, env);
      if (v === null) return null;
      if (e.op === 'not') return v.k === 'bool' ? { k: 'bool', v: !v.v } : null;
      if (v.k === 'int') return { k: 'int', v: -v.v };
      if (v.k === 'float') return { k: 'float', v: -v.v };
      return null;
    }
    case 'Binary': {
      const l = evalBasic(e.left, env);
      const r = evalBasic(e.right, env);
      if (l === null || r === null) return null;
      return binary(e.op, l, r);
    }
    case 'And':
    case 'Or': {
      let acc = e.kind === 'And';
      for (const o of e.operands) {
        const v = evalBasic(o, env);
        if (v === null || v.k !== 'bool') return null;
        acc = e.kind === 'And' ? acc && v.v : acc || v.v;
      }
      return { k: 'bool', v: acc };
    }
    default:
      return null;
  }
}

function binary(op: A.BinaryOp, l: ConstValue, r: ConstValue): ConstValue | null {
  if (l.k === 'int' && r.k === 'int') {
    switch (op) {
      case '+':
        return { k: 'int', v: l.v + r.v };
      case '-':
        return { k: 'int', v: l.v - r.v };
      case '*':
        return { k: 'int', v: l.v * r.v };
      case '/':
        return r.v === 0n ? null : { k: 'int', v: l.v / r.v };
      case '%':
        return r.v === 0n ? null : { k: 'int', v: l.v % r.v };
      case '==':
        return { k: 'bool', v: l.v === r.v };
      case '!=':
        return { k: 'bool', v: l.v !== r.v };
      case '<':
        return { k: 'bool', v: l.v < r.v };
      case '<=':
        return { k: 'bool', v: l.v <= r.v };
      case '>':
        return { k: 'bool', v: l.v > r.v };
      case '>=':
        return { k: 'bool', v: l.v >= r.v };
      default:
        return null;
    }
  }
  if (l.k === 'float' && r.k === 'float') {
    switch (op) {
      case '+':
        return { k: 'float', v: l.v + r.v };
      case '-':
        return { k: 'float', v: l.v - r.v };
      case '*':
        return { k: 'float', v: l.v * r.v };
      case '/':
        return { k: 'float', v: l.v / r.v };
      case '==':
        return { k: 'bool', v: l.v === r.v };
      case '!=':
        return { k: 'bool', v: l.v !== r.v };
      case '<':
        return { k: 'bool', v: l.v < r.v };
      case '<=':
        return { k: 'bool', v: l.v <= r.v };
      case '>':
        return { k: 'bool', v: l.v > r.v };
      case '>=':
        return { k: 'bool', v: l.v >= r.v };
      default:
        return null;
    }
  }
  if (l.k === 'text' && r.k === 'text') {
    if (op === '++') return { k: 'text', v: l.v + r.v };
    if (op === '==') return { k: 'bool', v: l.v === r.v };
    if (op === '!=') return { k: 'bool', v: l.v !== r.v };
    return null;
  }
  if (l.k === 'bool' && r.k === 'bool') {
    if (op === '==') return { k: 'bool', v: l.v === r.v };
    if (op === '!=') return { k: 'bool', v: l.v !== r.v };
    if (op === 'implies') return { k: 'bool', v: !l.v || r.v };
    return null;
  }
  if (l.k === 'variant' && r.k === 'variant') {
    if (op === '==') return { k: 'bool', v: l.def === r.def };
    if (op === '!=') return { k: 'bool', v: l.def !== r.def };
  }
  return null;
}
