/**
 * Constant discharge: an obligation whose predicate and inputs are all
 * constants (a `Viewport` built from literals, a call with literal
 * arguments) is decided by evaluating it, which also covers floats
 * (§18.1: "the Viewport refinements at construction in main: proved
 * (constants)").
 */
import { BudgetExceeded, EvalPanic, Evaluator, NotConst, type Env } from '../consteval/eval.js';
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import type * as A from '../syntax/ast.js';
import { walk } from '../syntax/walk.js';

/**
 * True when the obligation's predicate evaluates to true under constant
 * inputs, false when it evaluates to false, null when it is not constant.
 * Effects: none beyond evaluation.
 */
export function constDischarge(ctx: Context, o: Obligation): boolean | null {
  if (o.source === null) return null;
  const source = ctx.resolve.node(o.source);
  const ev = new Evaluator(ctx, { constOf: (d) => ctx.consteval.constValues.get(d) ?? null }, 100_000);
  try {
    if (o.kind === 'refinement') {
      const value = ctx.resolve.node(o.at);
      if (!isExpr(value) || !isExpr(source)) return null;
      const env: Env = new Map();
      // A field refinement may mention sibling fields: bind them to the constructor's other values.
      const parent = enclosingCtor(ctx, value);
      if (parent !== null) {
        const owner = ctx.resolve.refs.get(parent.id);
        const ownerDef = owner !== undefined && owner.k === 'def' ? owner.def : null;
        const inits = [...(parent.args ?? []).map((a) => ({ name: a.name.text, value: a.value })), ...(parent.fields ?? []).map((f) => ({ name: f.name.text, value: f.value }))];
        for (const init of inits) {
          const field = ownerDef === null ? undefined : (ctx.types.fields.get(ownerDef) ?? []).find((f) => f.name === init.name);
          if (field !== undefined) env.set(field.def, ev.evalExpr(init.value, new Map()));
        }
      }
      const it = ev.evalExpr(value, new Map());
      const itDef = itBinding(ctx, source);
      const verdict = evalWithIt(ev, source, env, it, itDef);
      return verdict;
    }
    if (o.kind === 'requires') {
      const call = ctx.resolve.node(o.at);
      if (call.kind !== 'Call' || source.kind !== 'Contract') return null;
      const res = ctx.resolve.refs.get(call.callee.id);
      if (res === undefined || !(res.k === 'def' || res.k === 'companion')) return null;
      const sig = ctx.types.signatures.get(res.k === 'def' ? res.def : res.fn);
      if (sig === undefined) return null;
      const env: Env = new Map();
      for (let i = 0; i < sig.params.length; i++) {
        const p = sig.params[i];
        const pd = sig.paramDefs[i];
        const a = call.args.find((x) => x.name.text === p?.name);
        if (pd === undefined || a === undefined) return null;
        env.set(pd, ev.evalExpr(a.value, new Map()));
      }
      const v = ev.evalExpr(source.expr, env);
      return v.k === 'bool' ? v.v : null;
    }
    return null;
  } catch (err) {
    if (err instanceof NotConst || err instanceof EvalPanic || err instanceof BudgetExceeded) return null;
    throw err;
  }
}

/** Evaluates a refinement predicate with `it` bound: the evaluator has no `it`, so the predicate is evaluated with a substituted environment. */
function evalWithIt(ev: Evaluator, pred: A.Expr, env: Env, it: import('../consteval/values.js').Value, itDef: null): boolean | null {
  void itDef;
  // The evaluator cannot bind `it` directly; walk the predicate replacing `It` by evaluating manually.
  const v = evalPred(ev, pred, env, it);
  return v === null ? null : v;
}

function evalPred(ev: Evaluator, e: A.Expr, env: Env, it: import('../consteval/values.js').Value): boolean | null {
  const bool = (x: A.Expr): boolean | null => {
    const v = evalValue(ev, x, env, it);
    return v !== null && v.k === 'bool' ? v.v : null;
  };
  switch (e.kind) {
    case 'And': {
      for (const o of e.operands) {
        const b = bool(o);
        if (b === null) return null;
        if (!b) return false;
      }
      return true;
    }
    case 'Or': {
      for (const o of e.operands) {
        const b = bool(o);
        if (b === null) return null;
        if (b) return true;
      }
      return false;
    }
    default:
      return bool(e);
  }
}

/** Evaluates `e` where `It` denotes `it`, by evaluating operands and comparing. Supports comparisons and boolean structure. */
function evalValue(ev: Evaluator, e: A.Expr, env: Env, it: import('../consteval/values.js').Value): import('../consteval/values.js').Value | null {
  if (e.kind === 'It') return it;
  if (e.kind === 'Binary') {
    const l = evalValue(ev, e.left, env, it);
    const r = evalValue(ev, e.right, env, it);
    if (l === null || r === null) return null;
    return compare(e.op, l, r);
  }
  if (e.kind === 'Unary' && e.op === 'not') {
    const v = evalValue(ev, e.operand, env, it);
    return v !== null && v.k === 'bool' ? { k: 'bool', v: !v.v } : null;
  }
  if (e.kind === 'And' || e.kind === 'Or') {
    const b = evalPred(ev, e, env, it);
    return b === null ? null : { k: 'bool', v: b };
  }
  let mentionsIt = false;
  walk(e, (n) => {
    if (n.kind === 'It') mentionsIt = true;
    return !mentionsIt;
  });
  if (mentionsIt) return null;
  return ev.evalExpr(e, env);
}

type Value = import('../consteval/values.js').Value;

function compare(op: A.BinaryOp, l: Value, r: Value): Value | null {
  const num = (v: Value): number | null => (v.k === 'int' || v.k === 'float' || v.k === 'duration' ? v.v : null);
  const a = num(l);
  const b = num(r);
  switch (op) {
    case '==':
      return { k: 'bool', v: JSON.stringify(l) === JSON.stringify(r) };
    case '!=':
      return { k: 'bool', v: JSON.stringify(l) !== JSON.stringify(r) };
    case '<':
      return a === null || b === null ? null : { k: 'bool', v: a < b };
    case '<=':
      return a === null || b === null ? null : { k: 'bool', v: a <= b };
    case '>':
      return a === null || b === null ? null : { k: 'bool', v: a > b };
    case '>=':
      return a === null || b === null ? null : { k: 'bool', v: a >= b };
    case '+':
      return a === null || b === null ? null : { k: l.k === 'float' ? 'float' : 'int', v: a + b };
    case '-':
      return a === null || b === null ? null : { k: l.k === 'float' ? 'float' : 'int', v: a - b };
    case '*':
      return a === null || b === null ? null : { k: l.k === 'float' ? 'float' : 'int', v: a * b };
    default:
      return null;
  }
}

function itBinding(ctx: Context, source: A.Expr): null {
  void ctx;
  void source;
  return null;
}

function enclosingCtor(ctx: Context, value: A.Expr): A.Ctor | null {
  let found: A.Ctor | null = null;
  for (const m of ctx.resolve.modules) {
    walk(m.module, (n) => {
      if (found !== null) return false;
      if (n.kind === 'Ctor') {
        for (const a of n.args ?? []) if (a.value === value) found = n;
        for (const f of n.fields ?? []) if (f.value === value) found = n;
      }
      return found === null;
    });
    if (found !== null) break;
  }
  return found;
}

function isExpr(n: A.Node): n is A.Expr {
  return ['IntLit', 'FloatLit', 'TextLit', 'BoolLit', 'DurationLit', 'Name', 'It', 'ResultRef', 'Ctor', 'RecordUpdate', 'ListLit', 'Try', 'Recover', 'Old', 'Quantifier', 'Closure', 'Fake', 'FieldAccess', 'Call', 'Unary', 'Binary', 'And', 'Or', 'Is'].includes(n.kind);
}
