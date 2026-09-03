/**
 * The check-time evaluator (language spec §3.8, §3.8.1; impl spec milestone 4).
 *
 * Evaluates constant expressions, `const fn` bodies and pure function bodies
 * over `Value`s under a step budget. It never runs anything with an effect
 * beyond `alloc`, never calls an intrinsic the runtime does not implement,
 * and never sees a runtime binding: any such reference raises `NotConst`,
 * which callers treat as "not evaluable at check time" rather than an error.
 * A contract that fails while evaluating is `EvalPanic` (the obligation was
 * not proved); running out of budget is `BudgetExceeded`.
 */
import { Panic } from '@onus/runtime';
import type { Context } from '../context.js';
import type { Def, DefId, ResolveTables, TypeOwner } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import type { Signature, TypeTables } from '../types/tables.js';
import { stripRefinements, substitute, typeToString, type Type, type TypeArg } from '../types/type.js';
import { callImpl, hasImpl, stdType, type Conversion } from './intrinsics.js';
import { bool, int, ofConst, text, UNIT, valueEquals, type Value } from './values.js';

export class NotConst extends Error {
  constructor(
    readonly reason: string,
    readonly span: Span | null,
  ) {
    super(reason);
  }
}

export class EvalPanic extends Error {
  constructor(
    readonly detail: string,
    readonly span: Span | null,
  ) {
    super(detail);
  }
}

export class BudgetExceeded extends Error {
  constructor(readonly fn: string) {
    super(`budget exceeded in ${fn}`);
  }
}

/** Unwinds a `return` (or a failed `try`) to the enclosing call. */
class ReturnSignal {
  constructor(readonly value: Value) {}
}

export type Env = Map<DefId, Value>;

export interface EvalHost {
  /** The value of a `const` definition, or null when it is not evaluable. */
  constOf(def: DefId): Value | null;
}

interface Frame {
  readonly name: string;
  readonly ret: Type | null;
}

export const DEFAULT_STEP_BUDGET = 1_000_000;

export class Evaluator {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private readonly conv: Conversion;
  private steps = 0;
  private readonly frames: Frame[] = [];
  /** The most recent `ConstError` constructed, for E0700 (§3.8.1). */
  lastConstError: Value | null = null;

  constructor(
    ctx: Context,
    private readonly host: EvalHost,
    private readonly budget: number = DEFAULT_STEP_BUDGET,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
    this.conv = { resolve: ctx.resolve, types: ctx.types };
  }

  /** Starts a fresh evaluation: resets the budget and the last ConstError. Effects: mutates evaluator state. */
  reset(): void {
    this.steps = 0;
    this.lastConstError = null;
    this.frames.length = 0;
  }

  private step(): void {
    this.steps += 1;
    if (this.steps > this.budget) throw new BudgetExceeded(this.frames[this.frames.length - 1]?.name ?? 'constant expression');
  }

  private def(id: DefId): Def {
    return this.t.def(id);
  }

  private sig(def: Def): Signature {
    const s = this.ty.signatures.get(def.id);
    if (s === undefined) throw new NotConst(`\`${def.name}\` has no signature`, null);
    return s;
  }

  private ownerName(o: TypeOwner): string {
    return o.k === 'prim' ? o.name : this.def(o.def).name;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  evalExpr(e: A.Expr, env: Env): Value {
    this.step();
    switch (e.kind) {
      case 'IntLit':
        return int(this.safeInt(Number(e.value), e.span));
      case 'FloatLit':
        return { k: 'float', v: e.value };
      case 'TextLit':
        return text(e.value);
      case 'BoolLit':
        return bool(e.value);
      case 'DurationLit':
        return { k: 'duration', v: this.safeInt(Number(e.nanos), e.span) };
      case 'Name':
        return this.nameValue(e, env);
      case 'It':
      case 'ResultRef':
      case 'Old':
        throw new NotConst('contract keywords have no value at check time', e.span);
      case 'Ctor':
        return this.ctor(e, env);
      case 'RecordUpdate': {
        const base = this.evalExpr(e.base, env);
        if (base.k !== 'record') throw new NotConst('`with` on a non-record', e.span);
        const fields = new Map(base.fields);
        for (const f of e.fields) fields.set(f.name.text, this.evalExpr(f.value, env));
        return { k: 'record', def: base.def, fields };
      }
      case 'ListLit':
        return { k: 'list', items: e.elems.map((x) => this.evalExpr(x, env)) };
      case 'Try':
        return this.tryExpr(e, env);
      case 'Recover':
        throw new NotConst('`recover` is not evaluated at check time', e.span);
      case 'Quantifier':
        return this.quantifier(e, env);
      case 'Closure':
        throw new NotConst('closures are not values at check time', e.span);
      case 'Fake':
        throw new NotConst('`fake` capabilities exist only in generated tests', e.span);
      case 'FieldAccess':
        return this.fieldAccess(e, env);
      case 'Call':
        return this.call(e, env);
      case 'Unary': {
        const v = this.evalExpr(e.operand, env);
        if (e.op === 'not') {
          if (v.k !== 'bool') throw new EvalPanic('`not` on a non-Bool', e.span);
          return bool(!v.v);
        }
        if (v.k === 'int') return int(this.safeInt(-v.v, e.span));
        if (v.k === 'float') return { k: 'float', v: -v.v };
        if (v.k === 'duration') return { k: 'duration', v: this.safeInt(-v.v, e.span) };
        throw new EvalPanic('unary `-` on a non-number', e.span);
      }
      case 'Binary':
        return this.binary(e, env);
      case 'And': {
        for (const o of e.operands) {
          const v = this.evalExpr(o, env);
          if (v.k !== 'bool') throw new EvalPanic('`and` on a non-Bool', o.span);
          if (!v.v) return bool(false);
        }
        return bool(true);
      }
      case 'Or': {
        for (const o of e.operands) {
          const v = this.evalExpr(o, env);
          if (v.k !== 'bool') throw new EvalPanic('`or` on a non-Bool', o.span);
          if (v.v) return bool(true);
        }
        return bool(false);
      }
      case 'Is': {
        const v = this.evalExpr(e.expr, env);
        return bool(this.matchPattern(e.pattern, v, new Map(env)));
      }
    }
  }

  private safeInt(n: number, span: Span): number {
    if (!Number.isSafeInteger(n)) throw new EvalPanic(`${n} is outside the runtime's safe integer range (±2^53)`, span);
    return n;
  }

  private nameValue(e: A.Name, env: Env): Value {
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') throw new NotConst(`\`${e.name.text}\` is unresolved`, e.span);
    const def = this.def(res.def);
    if (def.kind === 'const') {
      const v = this.host.constOf(def.id);
      if (v === null) throw new NotConst(`\`${def.name}\` is not a constant`, e.span);
      return v;
    }
    if (def.kind === 'fn') throw new NotConst(`\`${def.name}\` is a function value`, e.span);
    const v = env.get(def.id);
    if (v === undefined) throw new NotConst(`\`${def.name}\` is not known at check time`, e.span);
    return v;
  }

  private ctor(e: A.Ctor, env: Env): Value {
    const res = this.t.refs.get(e.id);
    if (res === undefined) throw new NotConst('unresolved constructor', e.span);
    if (res.k === 'unit') return UNIT;
    if (res.k === 'type-value') return { k: 'typeinfo', owner: res.type };
    if (res.k !== 'def') throw new NotConst('unresolved constructor', e.span);
    const def = this.def(res.def);
    const fields = new Map<string, Value>();
    for (const a of e.args ?? []) fields.set(a.name.text, this.evalExpr(a.value, env));
    for (const f of e.fields ?? []) fields.set(f.name.text, this.evalExpr(f.value, env));
    if (def.kind === 'variant') return { k: 'variant', def: def.id, fields };
    const value: Value = { k: 'record', def: def.id, fields };
    if (def.id === stdType(this.t, 'std.check', 'ConstError')) this.lastConstError = value;
    return value;
  }

  private tryExpr(e: A.Try, env: Env): Value {
    const v = this.evalExpr(e.expr, env);
    if (v.k !== 'variant') throw new NotConst('`try` on a non-union', e.span);
    const name = this.def(v.def).name;
    if (name === 'Ok' || name === 'Some') {
      const inner = v.fields.get('value');
      if (inner === undefined) throw new NotConst('malformed Ok/Some', e.span);
      return inner;
    }
    const frame = this.frames[this.frames.length - 1];
    const ret = frame?.ret === undefined || frame.ret === null ? null : stripRefinements(frame.ret);
    if (ret === null || ret.k !== 'union') throw new NotConst('`try` outside a fallible function', e.span);
    const returnsOption = ret.def === stdType(this.t, 'std.option', 'Option');
    if (e.else === null) throw new ReturnSignal(v);
    const errValue = name === 'Err' ? v.fields.get('error') ?? UNIT : UNIT;
    const inner = new Map(env);
    const elseDef = this.t.defOf.get(e.else.id);
    if (elseDef !== undefined) inner.set(elseDef, errValue);
    const converted = this.evalExpr(e.else.expr, inner);
    if (returnsOption) throw new ReturnSignal(this.variantNamed('std.option', 'Option', 'None', new Map()));
    throw new ReturnSignal(this.variantNamed('std.results', 'Result', 'Err', new Map([['error', converted]])));
  }

  private variantNamed(moduleName: string, unionName: string, variantName: string, fields: Map<string, Value>): Value {
    const union = stdType(this.t, moduleName, unionName);
    const variant = union === null ? undefined : (this.ty.variants.get(union) ?? []).find((v) => this.def(v).name === variantName);
    if (variant === undefined) throw new NotConst(`${unionName}.${variantName} is not available`, null);
    return { k: 'variant', def: variant, fields };
  }

  private quantifier(e: A.Quantifier, env: Env): Value {
    const binder = this.t.defOf.get(e.id);
    if (binder === undefined) throw new NotConst('unresolved binder', e.span);
    let domain: Value[];
    if (e.domain === null) {
      domain = [bool(true), bool(false)];
    } else if (e.domain.kind === 'RangeDomain') {
      const lo = this.evalExpr(e.domain.lo, env);
      const hi = this.evalExpr(e.domain.hi, env);
      if (lo.k !== 'int' || hi.k !== 'int') throw new EvalPanic('range bounds must be Int', e.span);
      domain = [];
      for (let i = lo.v; i < hi.v; i++) domain.push(int(i));
    } else {
      const d = this.evalExpr(e.domain.expr, env);
      if (d.k === 'list') domain = [...d.items];
      else if (d.k === 'variant' && (this.def(d.def).name === 'Ok' || this.def(d.def).name === 'Some')) {
        const inner = d.fields.get('value');
        if (inner === undefined || inner.k !== 'list') throw new NotConst('quantifier domain is not a list', e.span);
        domain = [...inner.items];
      } else if (d.k === 'variant') domain = [];
      else throw new NotConst('quantifier domain is not a list', e.span);
    }
    const inner = new Map(env);
    for (const x of domain) {
      this.step();
      inner.set(binder, x);
      if (e.where !== null) {
        const w = this.evalExpr(e.where, inner);
        if (w.k !== 'bool') throw new EvalPanic('`where` must be Bool', e.span);
        if (!w.v) continue;
      }
      const b = this.evalExpr(e.body, inner);
      if (b.k !== 'bool') throw new EvalPanic('quantifier body must be Bool', e.span);
      if (e.quant === 'forall' && !b.v) return bool(false);
      if (e.quant === 'exists' && b.v) return bool(true);
    }
    return bool(e.quant === 'forall');
  }

  private fieldAccess(e: A.FieldAccess, env: Env): Value {
    const res = this.t.refs.get(e.id);
    if (res !== undefined) {
      if (res.k === 'def' && this.def(res.def).kind === 'const') {
        const v = this.host.constOf(res.def);
        if (v === null) throw new NotConst(`\`${this.def(res.def).name}\` is not a constant`, e.span);
        return v;
      }
      if (res.k === 'unit') return UNIT;
      if (res.k === 'type-value') return { k: 'typeinfo', owner: res.type };
      throw new NotConst('a function is not a value at check time', e.span);
    }
    const obj = this.evalExpr(e.object, env);
    if (obj.k !== 'record') throw new NotConst('field access on a non-record', e.span);
    const f = obj.fields.get(e.name.text);
    if (f === undefined) throw new NotConst(`no field \`${e.name.text}\``, e.span);
    return f;
  }

  private binary(e: A.Binary, env: Env): Value {
    const l = this.evalExpr(e.left, env);
    const r = this.evalExpr(e.right, env);
    const op = e.op;
    if (op === '==') return bool(valueEquals(l, r));
    if (op === '!=') return bool(!valueEquals(l, r));
    if (op === 'implies') {
      if (l.k !== 'bool' || r.k !== 'bool') throw new EvalPanic('`implies` on non-Bool', e.span);
      return bool(!l.v || r.v);
    }
    if (op === '++') {
      if (l.k === 'text' && r.k === 'text') return text(l.v + r.v);
      if (l.k === 'list' && r.k === 'list') return { k: 'list', items: [...l.items, ...r.items] };
      throw new EvalPanic('`++` on mismatched operands', e.span);
    }
    if ((l.k === 'int' && r.k === 'int') || (l.k === 'duration' && r.k === 'duration')) {
      const k = l.k;
      switch (op) {
        case '+':
          return { k, v: this.safeInt(l.v + r.v, e.span) };
        case '-':
          return { k, v: this.safeInt(l.v - r.v, e.span) };
        case '*':
          return { k, v: this.safeInt(l.v * r.v, e.span) };
        case '/':
          if (r.v === 0) throw new EvalPanic('division by zero', e.span);
          return { k, v: Math.trunc(l.v / r.v) };
        case '%':
          if (r.v === 0) throw new EvalPanic('remainder by zero', e.span);
          return { k, v: l.v % r.v };
        case '<':
          return bool(l.v < r.v);
        case '<=':
          return bool(l.v <= r.v);
        case '>':
          return bool(l.v > r.v);
        case '>=':
          return bool(l.v >= r.v);
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
        case '%':
          return { k: 'float', v: l.v % r.v };
        case '<':
          return bool(l.v < r.v);
        case '<=':
          return bool(l.v <= r.v);
        case '>':
          return bool(l.v > r.v);
        case '>=':
          return bool(l.v >= r.v);
      }
    }
    throw new EvalPanic(`\`${op}\` on mismatched operands`, e.span);
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private call(e: A.Call, env: Env): Value {
    const res = this.t.refs.get(e.callee.id);
    if (res === undefined || !(res.k === 'def' || res.k === 'companion')) throw new NotConst('only named functions are called at check time', e.callee.span);
    const fnDef = this.def(res.k === 'def' ? res.def : res.fn);
    if (fnDef.kind !== 'fn') throw new NotConst(`\`${fnDef.name}\` is not a function`, e.callee.span);
    const sig = this.sig(fnDef);
    const args = new Map<string, Value>();
    const inoutVars = new Map<string, DefId>();
    for (const a of e.args) {
      args.set(a.name.text, this.evalExpr(a.value, env));
      if (a.inout && a.value.kind === 'Name') {
        const r = this.t.refs.get(a.value.id);
        if (r !== undefined && r.k === 'def') inoutVars.set(a.name.text, r.def);
      }
    }
    const subst = new Map<DefId, TypeArg>();
    const targs = this.ty.instantiations.get(e.id) ?? [];
    sig.tparams.forEach((p, i) => {
      const a = targs[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    const result = this.callFn(fnDef, sig, args, subst, e.span);
    for (const [name, def] of inoutVars) {
      const after = result.inout.get(name);
      if (after !== undefined) env.set(def, after);
    }
    return result.value;
  }

  /**
   * Calls `def` with named arguments and type arguments.
   * Preconditions: `def` is a function with a signature.
   * Effects: mutates evaluator state; may throw NotConst, EvalPanic, BudgetExceeded.
   */
  callFn(def: Def, sig: Signature, args: ReadonlyMap<string, Value>, subst: ReadonlyMap<DefId, TypeArg>, span: Span | null): { value: Value; inout: Map<string, Value> } {
    this.step();
    for (const eff of sig.effects.values()) {
      if (eff.k !== 'prim' || eff.name !== 'alloc') throw new NotConst(`\`${def.name}\` has effects and cannot run at check time`, span);
    }
    const env: Env = new Map();
    for (const p of sig.tparams) {
      if (p.k !== 'const') continue;
      const a = subst.get(p.def);
      const v = a !== undefined && a.k === 'const' ? ofConst(a.value) : null;
      if (v === null) throw new NotConst(`type index \`${this.def(p.def).name}\` of \`${def.name}\` is not known at check time`, span);
      env.set(p.def, v);
    }
    sig.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      const v = args.get(p.name);
      if (pd === undefined || v === undefined) throw new NotConst(`missing argument \`${p.name}\``, span);
      env.set(pd, v);
    });
    this.frames.push({ name: def.name, ret: sig.ret });
    try {
      for (const c of sig.contracts) {
        if (c.clause !== 'requires') continue;
        const ok = this.evalExpr(c.expr, env);
        if (ok.k !== 'bool' || !ok.v) throw new EvalPanic(`\`requires ${printExpr(c.expr)}\` of \`${def.name}\` does not hold`, span);
      }
      if (sig.intrinsic) return { value: this.intrinsic(def, sig, env, subst, span), inout: new Map() };
      const node = this.t.node(def.node);
      if (node.kind !== 'FnDecl' || node.body === null) throw new NotConst(`\`${def.name}\` has no body`, span);
      let value: Value = UNIT;
      try {
        this.execBlock(node.body, env);
      } catch (sig2) {
        if (!(sig2 instanceof ReturnSignal)) throw sig2;
        value = sig2.value;
      }
      const inout = new Map<string, Value>();
      sig.params.forEach((p, i) => {
        const pd = sig.paramDefs[i];
        const v = pd === undefined ? undefined : env.get(pd);
        if (p.inout && v !== undefined) inout.set(p.name, v);
      });
      return { value, inout };
    } finally {
      this.frames.pop();
    }
  }

  private intrinsic(def: Def, sig: Signature, env: Env, subst: ReadonlyMap<DefId, TypeArg>, span: Span | null): Value {
    const qualified = this.t.qualifiedName(def.id);
    if (!sig.constFn || !hasImpl(qualified)) throw new NotConst(`\`${qualified}\` is not evaluated at check time`, span);
    const argValues = sig.paramDefs.map((pd) => env.get(pd) ?? UNIT);
    if (qualified.startsWith('std.typeinfo.')) return this.typeinfoIntrinsic(qualified, argValues, span);
    const ret = substitute(sig.ret, subst);
    try {
      return callImpl(qualified, argValues, ret, this.conv);
    } catch (err) {
      if (err instanceof Panic) throw new EvalPanic(`${err.obligation.kind} \`${err.obligation.text}\` of ${err.obligation.def}: ${err.detail}`, span);
      throw err;
    }
  }

  private typeinfoIntrinsic(qualified: string, args: readonly Value[], span: Span | null): Value {
    const info = args[0];
    if (info === undefined || info.k !== 'typeinfo') throw new NotConst('TypeInfo intrinsic without a type', span);
    if (qualified === 'std.typeinfo.name') return text(this.ownerName(info.owner));
    if (qualified === 'std.typeinfo.fields') {
      const fieldDef = stdType(this.t, 'std.typeinfo', 'Field');
      if (fieldDef === null) throw new NotConst('std.typeinfo.Field is not available', span);
      const items: Value[] = [];
      if (info.owner.k === 'def') {
        for (const f of this.ty.fields.get(info.owner.def) ?? []) {
          items.push({ k: 'record', def: fieldDef, fields: new Map([['name', text(f.name)], ['type_name', text(typeToString(f.type, this.t))]]) });
        }
      }
      return { k: 'list', items };
    }
    throw new NotConst(`\`${qualified}\` is not evaluated at check time`, span);
  }

  // -------------------------------------------------------------------------
  // Statements and patterns
  // -------------------------------------------------------------------------

  execBlock(b: A.Block, env: Env): void {
    for (const s of b.stmts) this.execStmt(s, env);
  }

  execStmt(s: A.Stmt, env: Env): void {
    this.step();
    switch (s.kind) {
      case 'Let':
      case 'Var': {
        const def = this.t.defOf.get(s.id);
        if (def !== undefined) env.set(def, this.evalExpr(s.value, env));
        return;
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        if (res !== undefined && res.k === 'def') env.set(res.def, this.evalExpr(s.value, env));
        return;
      }
      case 'Return':
        throw new ReturnSignal(this.evalExpr(s.value, env));
      case 'If': {
        const c = this.evalExpr(s.cond, env);
        if (c.k !== 'bool') throw new EvalPanic('`if` on a non-Bool', s.cond.span);
        if (c.v) this.execBlock(s.then, env);
        else if (s.else) this.execBlock(s.else, env);
        return;
      }
      case 'Match': {
        const v = this.evalExpr(s.scrutinee, env);
        for (const arm of s.arms) {
          const armEnv = new Map(env);
          if (!this.matchPattern(arm.pattern, v, armEnv)) continue;
          if (arm.guard) {
            const g = this.evalExpr(arm.guard, armEnv);
            if (g.k !== 'bool') throw new EvalPanic('guard on a non-Bool', arm.guard.span);
            if (!g.v) continue;
          }
          if (arm.body.kind === 'Block') this.execBlock(arm.body, armEnv);
          else this.execStmt(arm.body, armEnv);
          // Assignments to enclosing vars inside the arm must be visible afterwards.
          for (const [k, x] of armEnv) if (env.has(k)) env.set(k, x);
          return;
        }
        throw new EvalPanic('no match arm applied', s.span);
      }
      case 'Loop': {
        for (;;) {
          this.step();
          const c = this.evalExpr(s.cond, env);
          if (c.k !== 'bool') throw new EvalPanic('`loop while` on a non-Bool', s.cond.span);
          if (!c.v) return;
          this.execBlock(s.body, env);
        }
      }
      case 'For': {
        const def = this.t.defOf.get(s.id);
        if (def === undefined) return;
        if (s.domain.kind === 'RangeDomain') {
          const lo = this.evalExpr(s.domain.lo, env);
          const hi = this.evalExpr(s.domain.hi, env);
          if (lo.k !== 'int' || hi.k !== 'int') throw new EvalPanic('range bounds must be Int', s.span);
          for (let i = lo.v; i < hi.v; i++) {
            this.step();
            env.set(def, int(i));
            this.execBlock(s.body, env);
          }
        } else {
          const d = this.evalExpr(s.domain.expr, env);
          if (d.k !== 'list') throw new NotConst('`for` over a non-list', s.span);
          for (const x of d.items) {
            this.step();
            env.set(def, x);
            this.execBlock(s.body, env);
          }
        }
        return;
      }
      case 'Assume':
        return;
      case 'ExprStmt':
        this.evalExpr(s.expr, env);
        return;
    }
  }

  /** Matches `v` against `p`, binding into `env`. Effects: mutates `env`. */
  matchPattern(p: A.Pattern, v: Value, env: Env): boolean {
    switch (p.kind) {
      case 'WildcardPat':
        return true;
      case 'BindPat': {
        const def = this.t.defOf.get(p.id);
        if (def !== undefined) env.set(def, v);
        return true;
      }
      case 'LitPat':
        return valueEquals(this.evalExpr(p.literal, env), v);
      case 'VariantPat': {
        const res = this.t.refs.get(p.id);
        if (res === undefined || res.k !== 'def') return false;
        if (v.k !== 'variant' || v.def !== res.def) return false;
        if (p.fields === null) return true;
        const fields = this.ty.fields.get(res.def) ?? [];
        let i = 0;
        for (const pf of p.fields) {
          if (pf.kind === 'PatFieldRest') break;
          const f = fields[i];
          if (f === undefined) return false;
          if (pf.kind === 'PatFieldName') {
            const def = this.t.defOf.get(pf.id);
            const x = v.fields.get(f.name);
            if (def !== undefined && x !== undefined) env.set(def, x);
          }
          i += 1;
        }
        return true;
      }
    }
  }
}
