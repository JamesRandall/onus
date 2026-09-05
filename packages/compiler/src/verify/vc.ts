/**
 * Verification conditions (impl spec §7; language spec §3.2.1, §5.1, §12.1).
 *
 * Each function body is walked once in program order with a static
 * single-assignment discipline: every `var` assignment introduces a fresh
 * SMT constant, so facts about earlier values never go stale. Path
 * knowledge follows §3.2.1: `if` conditions and their negations, `match`
 * arms (tag, bindings, guard, and the failure of earlier arms), loop
 * conditions and invariants inside the body, their negation and the
 * invariants after exit, `for` ranges, `try` success, and the declared
 * refinements of every binding. Loops and branch joins forget (`havoc`)
 * the variables they assign.
 *
 * For every obligation created by the contracts pass, the walk records a
 * goal and the facts in scope at its site. Obligations whose expressions
 * cannot be lowered (floats, closures) get no condition and stay `checked`.
 */
import type { Context } from '../context.js';
import type { Obligation, ObligationId } from '../contracts/obligations.js';
import type { Def, DefId, ResolveTables } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { children, isExpr, walk } from '../syntax/walk.js';
import type { TypeTables } from '../types/tables.js';
import { stripRefinements, type Type } from '../types/type.js';
import { and, app, BOOL, eq, implies, INT, int, not, TRUE, type Formula, type Sort } from './formula.js';
import { Lowerer, Unlowerable, type Binding, type Env } from './lower.js';

export interface VC {
  readonly obligation: Obligation;
  readonly lowerer: Lowerer;
  readonly facts: readonly Formula[];
  readonly goal: Formula;
  /** SMT constant name → source name, for counterexamples. */
  readonly names: ReadonlyMap<string, string>;
}

export interface VCs {
  readonly built: Map<ObligationId, VC>;
  /** Why an obligation has no condition. */
  readonly skipped: Map<ObligationId, string>;
}

/** The safe integer range the runtime enforces (impl spec §1). */
const INT_MAX = 2n ** 53n;

/**
 * Builds a condition for every lowerable obligation of `ctx`.
 * Preconditions: the contracts pass ran.
 * Effects: none beyond the returned structure.
 */
/** A contract weakening under which the conditions are rebuilt (§20.4). */
export type Mutation =
  | { readonly k: 'drop-ensures'; readonly fn: DefId; readonly clause: A.NodeId }
  | { readonly k: 'widen-return'; readonly fn: DefId }
  | { readonly k: 'widen-field'; readonly record: DefId; readonly field: string };

export function buildVCs(ctx: Context, mutation: Mutation | null = null): VCs {
  const out: VCs = { built: new Map(), skipped: new Map() };
  const byDef = new Map<DefId, Obligation[]>();
  for (const o of ctx.contracts.obligations) {
    if (o.kind === 'law' || o.kind === 'property') continue;
    const list = byDef.get(o.def) ?? [];
    list.push(o);
    byDef.set(o.def, list);
  }
  for (const [def, obligations] of byDef) {
    const d = ctx.resolve.def(def);
    const node = ctx.resolve.node(d.node);
    const walker = new BodyWalker(ctx, d, obligations, out, mutation);
    try {
      if (node.kind === 'FnDecl' && node.body !== null) walker.fnBody(node);
      else if (node.kind === 'ExampleDecl' || node.kind === 'PropertyDecl' || node.kind === 'Law') walker.assertionBody(node);
      else if (node.kind === 'ConstDecl') walker.constBody(node);
      else if (node.kind === 'VerifyBlock') walker.verifyBody(node);
      else if (node.kind === 'ImplDecl') walker.skipAll('laws are run under generated inputs');
      else walker.skipAll('no body');
    } catch (err) {
      if (!(err instanceof Unlowerable)) throw err;
      walker.skipAll(err.reason);
    }
  }
  return out;
}

class BodyWalker {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private readonly lowerer: Lowerer;
  private env = new Map<DefId, Binding>();
  private facts: Formula[] = [];
  private readonly names = new Map<string, string>();
  private readonly pending: Map<ObligationId, Obligation>;
  private ret: Type | null = null;
  private ensures: readonly A.Contract[] = [];
  private returnCount = 0;

  /** The recursive function's measure at entry (§5.1), or null when it has none or it could not be lowered. */
  private measure0: Formula | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly def: Def,
    obligations: readonly Obligation[],
    private readonly out: VCs,
    mutation: Mutation | null = null,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
    this.lowerer = new Lowerer(ctx, mutation);
    this.pending = new Map(obligations.map((o) => [o.id, o]));
  }

  skipAll(reason: string): void {
    for (const o of this.pending.values()) if (!this.out.built.has(o.id)) this.out.skipped.set(o.id, reason);
  }

  // -------------------------------------------------------------------------
  // Bodies
  // -------------------------------------------------------------------------

  fnBody(f: A.FnDecl): void {
    const sig = this.ty.signatures.get(this.def.id);
    if (sig === undefined || f.body === null) return;
    this.ret = sig.ret;
    this.ensures = f.contracts.filter((c) => c.clause === 'ensures');
    for (const p of sig.tparams) {
      if (p.k !== 'const') continue;
      this.bind(p.def, this.t.def(p.def).name, p.type, null);
    }
    sig.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      if (pd === undefined) return;
      const term = this.bind(pd, p.name, p.type, null);
      this.lowerer.olds.set(pd, term);
      this.representationGoals(this.t.def(pd).node, p.type);
    });
    for (const c of f.contracts) {
      if (c.clause !== 'requires') continue;
      try {
        this.facts.push(this.lowerer.lower(c.expr, this.env));
      } catch (err) {
        if (!(err instanceof Unlowerable)) throw err;
      }
    }
    // The measure of a recursive function, taken at entry (§5.1): non-negative here, and every call in the cycle must go strictly below it.
    for (const c of f.contracts) {
      if (c.clause !== 'decreases') continue;
      try {
        this.measure0 = this.lowerer.lower(c.expr, this.env);
      } catch (err) {
        if (!(err instanceof Unlowerable)) throw err;
      }
      for (const o of this.obligationsAt(c.id, 'decreases')) {
        const m0 = this.measure0;
        if (m0 === null) this.skip(o, 'measure not lowered');
        else this.tryGoal(o, () => app('>=', [m0, int(0)], BOOL));
      }
    }
    this.block(f.body);
    this.skipAll('not reached by the walk');
  }

  assertionBody(node: A.ExampleDecl | A.PropertyDecl | A.Law): void {
    if (node.kind === 'PropertyDecl' || node.kind === 'Law') {
      for (const p of node.params) {
        const pd = this.t.defOf.get(p.id);
        const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
        if (pd !== undefined && type !== undefined) this.bind(pd, p.name.text, type, null);
      }
    }
    this.block(node.body);
    this.skipAll('not reached by the walk');
  }

  /** A `verify` block (§20.2): its capability parameters bound, then its body. */
  verifyBody(node: A.VerifyBlock): void {
    for (const p of node.params) {
      const pd = this.t.defOf.get(p.id);
      const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
      if (pd !== undefined && type !== undefined) this.bind(pd, p.name.text, type, null);
    }
    this.block(node.body);
    this.skipAll('not reached by the walk');
  }

  constBody(node: A.ConstDecl): void {
    this.exprObligations(node.value);
    this.skipAll('not reached by the walk');
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  /** Binds `def` to a fresh constant, equal to `value` when given, and assumes its declared refinements. */
  private bind(def: DefId, name: string, type: Type, value: Formula | null): Formula {
    const sort = this.lowerer.sortOf(type);
    const term = this.lowerer.freshConst(`${name}`, sort);
    if (term.k === 'var') this.names.set(term.name, name);
    if (value !== null) this.facts.push(eq(term, value));
    this.env.set(def, { term, type });
    this.lowerer.typeFacts(term, type, this.env);
    return term;
  }

  /** Forgets the current values of `defs`: fresh constants with only their declared refinements. */
  private havoc(defs: Iterable<DefId>): void {
    for (const d of defs) {
      const b = this.env.get(d);
      if (b === undefined) continue;
      this.bind(d, this.t.def(d).name, b.type, null);
    }
  }

  /** `var`s (and inout parameters) assigned anywhere under `n`. */
  private assigned(n: A.Node): Set<DefId> {
    const out = new Set<DefId>();
    walk(n, (x) => {
      if (x.kind === 'VerifyBlock') return false;
      if (x.kind === 'Assign') {
        const r = this.t.refs.get(x.id);
        if (r !== undefined && r.k === 'def') out.add(r.def);
      }
      if (x.kind === 'Call') {
        for (const a of x.args) {
          if (!a.inout || a.value.kind !== 'Name') continue;
          const r = this.t.refs.get(a.value.id);
          if (r !== undefined && r.k === 'def') out.add(r.def);
        }
      }
      return true;
    });
    return out;
  }

  private lower(e: A.Expr): Formula {
    const f = this.lowerer.lower(e, this.env);
    this.facts.push(...this.lowerer.learned.splice(0));
    return f;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): void {
    for (const s of b.stmts) this.stmt(s);
  }

  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case 'Let':
      case 'Var': {
        const def = this.t.defOf.get(s.id);
        const type = def === undefined ? undefined : this.ty.declTypes.get(def);
        const value = this.exprObligations(s.value);
        if (def !== undefined && type !== undefined) {
          this.flowGoal(s.value, value, type);
          this.bind(def, s.name.text, type, value);
          this.representationGoals(s.id, type);
        }
        return;
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        const value = this.exprObligations(s.value);
        if (res === undefined || res.k !== 'def') return;
        const type = this.ty.declTypes.get(res.def);
        if (type === undefined) return;
        this.flowGoal(s.value, value, type);
        this.bind(res.def, s.name.text, type, value);
        return;
      }
      case 'Return': {
        const value = this.exprObligations(s.value);
        this.returnCount += 1;
        if (this.ret !== null) {
          this.flowGoal(s.value, value, this.ret);
          for (const o of this.obligationsAt(s.id, 'ensures')) {
            const clause = this.ensures.find((c) => c.id === o.source);
            if (clause === undefined) continue;
            this.lowerer.result = value;
            try {
              this.emit(o, this.lowerer.lower(clause.expr, this.env));
            } catch (err) {
              if (!(err instanceof Unlowerable)) throw err;
              this.skip(o, err.reason);
            } finally {
              this.lowerer.result = null;
            }
          }
        }
        return;
      }
      case 'If': {
        const cond = this.exprObligations(s.cond);
        const before = { env: new Map(this.env), facts: [...this.facts] };
        this.facts.push(cond);
        this.block(s.then);
        const thenReturns = blockReturns(s.then);
        const afterThen = { env: new Map(this.env), facts: [...this.facts] };
        this.env = new Map(before.env);
        this.facts = [...before.facts, not(cond)];
        if (s.else) this.block(s.else);
        const afterElse = { env: new Map(this.env), facts: [...this.facts] };
        const elseReturns = s.else !== null && blockReturns(s.else);
        if (thenReturns && !elseReturns) return; // continue on the else path
        if (elseReturns && !thenReturns) {
          this.env = afterThen.env;
          this.facts = afterThen.facts;
          return;
        }
        // Join: what held before still holds; what a branch learned holds under its condition; a
        // variable a branch assigned is fresh, and equal to each branch's value under that condition.
        const assigned = new Set([...this.assigned(s.then), ...(s.else ? this.assigned(s.else) : [])]);
        const thenNew = afterThen.facts.slice(before.facts.length + 1);
        const elseNew = afterElse.facts.slice(before.facts.length + 1);
        this.env = new Map(before.env);
        this.facts = [...before.facts];
        const thenEqs: Formula[] = [];
        const elseEqs: Formula[] = [];
        for (const d of assigned) {
          const b = before.env.get(d);
          if (b === undefined) continue;
          const t1 = afterThen.env.get(d);
          const t2 = afterElse.env.get(d);
          const fresh = this.bind(d, this.t.def(d).name, b.type, null);
          if (t1 !== undefined) thenEqs.push(eq(fresh, t1.term));
          if (t2 !== undefined) elseEqs.push(eq(fresh, t2.term));
        }
        this.facts.push(implies(cond, conj([...thenNew, ...thenEqs])), implies(not(cond), conj([...elseNew, ...elseEqs])));
        return;
      }
      case 'Match':
        this.match(s);
        return;
      case 'Loop':
        this.loop(s);
        return;
      case 'For':
        this.forStmt(s);
        return;
      case 'Assume':
        return;
      case 'ExprStmt': {
        const value = this.exprObligations(s.expr);
        // An assertion of a test body (§5.2): proved when the contracts entail it, and then a fact for the assertions after it.
        const assertions = this.obligationsAt(s.expr.id, 'assertion');
        for (const o of assertions) this.tryGoal(o, () => value);
        if (assertions.length > 0) this.facts.push(value);
        return;
      }
    }
  }

  private match(s: A.Match): void {
    const scrutinee = this.exprObligations(s.scrutinee);
    const st = this.ty.exprTypes.get(s.scrutinee.id) ?? { k: 'error' };
    const before = { env: new Map(this.env), facts: [...this.facts] };
    const earlier: Formula[] = [];
    let allReturn = s.arms.length > 0;
    for (const arm of s.arms) {
      this.env = new Map(before.env);
      this.facts = [...before.facts, ...earlier.map((f) => not(f))];
      let test: Formula;
      try {
        test = this.patternFacts(arm.pattern, scrutinee, st);
      } catch (err) {
        if (!(err instanceof Unlowerable)) throw err;
        test = app('true', [], BOOL);
      }
      this.facts.push(test);
      let guard: Formula | null = null;
      if (arm.guard) {
        guard = this.exprObligations(arm.guard);
        this.facts.push(guard);
      }
      earlier.push(guard === null ? test : and(test, guard));
      if (arm.body.kind === 'Block') this.block(arm.body);
      else this.stmt(arm.body);
      const returns = arm.body.kind === 'Block' ? blockReturns(arm.body) : stmtReturns(arm.body);
      if (!returns) allReturn = false;
    }
    this.env = new Map(before.env);
    this.facts = [...before.facts];
    if (allReturn) {
      this.facts.push(app('false', [], BOOL));
      return;
    }
    this.havoc(this.assigned(s));
  }

  /** Facts a matching pattern establishes, binding its variables. */
  private patternFacts(p: A.Pattern, subject: Formula, type: Type): Formula {
    switch (p.kind) {
      case 'WildcardPat':
        return app('true', [], BOOL);
      case 'BindPat': {
        const def = this.t.defOf.get(p.id);
        if (def !== undefined) this.bind(def, p.name.text, type, subject);
        return app('true', [], BOOL);
      }
      case 'LitPat':
        return eq(subject, this.lower(p.literal));
      case 'VariantPat': {
        const res = this.t.refs.get(p.id);
        if (res === undefined || res.k !== 'def') throw new Unlowerable('unresolved pattern');
        const test = this.lowerer.isVariant(subject, type, res.def);
        if (p.fields !== null) {
          const fields = this.ty.fields.get(res.def) ?? [];
          let i = 0;
          for (const pf of p.fields) {
            if (pf.kind === 'PatFieldRest') break;
            const f = fields[i];
            if (pf.kind === 'PatFieldName' && f !== undefined) {
              const def = this.t.defOf.get(pf.id);
              const ft = this.ty.declTypes.get(def ?? f.def) ?? f.type;
              if (def !== undefined) this.bind(def, pf.name.text, ft, this.lowerer.projectionOf(subject, type, res.def, f.name, ft));
            }
            i += 1;
          }
        }
        return test;
      }
    }
  }

  private loop(s: A.Loop): void {
    const invariants = s.clauses.filter((c) => c.clause === 'invariant');
    const decreases = s.clauses.find((c) => c.clause === 'decreases') ?? null;
    // Entry: the invariants hold before the first iteration.
    for (const inv of invariants) {
      const o = this.obligationsAt(s.id, 'invariant-entry').find((x) => x.source === inv.id);
      if (o !== undefined) this.tryGoal(o, () => this.lower(inv.expr));
    }
    const assigned = this.assigned(s);
    const before = { env: new Map(this.env), facts: [...this.facts] };
    // An arbitrary iteration: the invariants and the condition hold on forgotten state.
    this.havoc(assigned);
    for (const inv of invariants) this.pushFact(inv.expr);
    const cond = this.exprObligations(s.cond);
    this.facts.push(cond);
    let m0: Formula | null = null;
    const dec = decreases === null ? null : (this.obligationsAt(s.id, 'decreases').find((x) => x.source === decreases.id) ?? null);
    if (decreases !== null && dec !== null) {
      const measure = this.exprObligations(decreases.expr);
      m0 = this.lowerer.freshConst('measure', INT);
      this.facts.push(eq(m0, measure));
    }
    this.block(s.body);
    for (const inv of invariants) {
      const o = this.obligationsAt(s.id, 'invariant-step').find((x) => x.source === inv.id);
      if (o !== undefined) this.tryGoal(o, () => this.lower(inv.expr));
    }
    if (decreases !== null && dec !== null && m0 !== null) {
      const measure0 = m0;
      this.tryGoal(dec, () => and(app('>=', [measure0, int(0)], BOOL), app('<', [this.lower(decreases.expr), measure0], BOOL)));
    }
    // Exit: forgotten state again, the condition false, the invariants true.
    this.env = new Map(before.env);
    this.facts = [...before.facts];
    this.havoc(assigned);
    for (const inv of invariants) this.pushFact(inv.expr);
    try {
      this.facts.push(not(this.lower(s.cond)));
    } catch (err) {
      if (!(err instanceof Unlowerable)) throw err;
    }
  }

  private pushFact(e: A.Expr): void {
    try {
      this.facts.push(this.lower(e));
    } catch (err) {
      if (!(err instanceof Unlowerable)) throw err;
    }
  }

  private forStmt(s: A.For): void {
    const def = this.t.defOf.get(s.id);
    const type = def === undefined ? undefined : this.ty.declTypes.get(def);
    if (def === undefined || type === undefined) return;
    const assigned = this.assigned(s.body);
    if (s.domain.kind === 'RangeDomain') {
      const lo = this.exprObligations(s.domain.lo);
      const hi = this.exprObligations(s.domain.hi);
      this.havoc(assigned);
      const x = this.bind(def, s.name.text, type, null);
      this.facts.push(app('<=', [lo, x], BOOL), app('<', [x, hi], BOOL));
    } else {
      const xs = this.exprObligations(s.domain.expr);
      const xsType = this.ty.exprTypes.get(s.domain.expr.id) ?? { k: 'error' };
      this.havoc(assigned);
      try {
        const k = this.lowerer.freshConst('k', INT);
        const elem = this.lowerer.listGet(xs, xsType, k);
        this.facts.push(app('<=', [int(0), k], BOOL), app('<', [k, this.lowerer.listLen(xs, xsType)], BOOL));
        for (const o of this.obligationsAt(s.domain.expr.id, 'refinement')) {
          this.tryGoal(o, () => {
            const kk = this.lowerer.freshConst('kk', INT);
            const inRange = and(app('<=', [int(0), kk], BOOL), app('<', [kk, this.lowerer.listLen(xs, xsType)], BOOL));
            return implies(inRange, this.refinementOf(type, this.lowerer.listGet(xs, xsType, kk)));
          });
        }
        this.bind(def, s.name.text, type, elem);
      } catch (err) {
        if (!(err instanceof Unlowerable)) throw err;
        this.bind(def, s.name.text, type, null);
      }
    }
    this.block(s.body);
    this.havoc(assigned);
    this.env.delete(def);
  }

  // -------------------------------------------------------------------------
  // Expressions and their obligations
  // -------------------------------------------------------------------------

  /**
   * Lowers `e` and emits the conditions of every obligation inside it:
   * callee preconditions, argument and field refinements, and overflow.
   */
  private exprObligations(e: A.Expr): Formula {
    let term: Formula;
    try {
      term = this.lower(e);
    } catch (err) {
      if (!(err instanceof Unlowerable)) throw err;
      walk(e, (n) => {
        for (const o of this.ctx.contracts.at(n.id)) if (this.pending.has(o.id)) this.skip(o, err.reason);
        return true;
      });
      return this.lowerer.freshConst('unlowered', this.safeSort(e));
    }
    this.dischargeUnder(e);
    return term;
  }

  /**
   * Discharges the obligations under `e` after it was lowered. The right
   * operand of `and`, `or` and `implies` is evaluated only when the left
   * decides nothing, so its obligations may assume the left operand (or its
   * negation), as a call after an `if` may assume the condition.
   */
  private dischargeUnder(e: A.Node): void {
    if (e.kind === 'And' || e.kind === 'Or') {
      const saved = this.facts.length;
      for (const operand of e.operands) {
        this.dischargeUnder(operand);
        const term = this.termOf(operand);
        if (term !== null) this.facts.push(e.kind === 'Or' ? not(term) : term);
      }
      this.facts.length = saved;
      return;
    }
    if (e.kind === 'Binary' && e.op === 'implies') {
      this.dischargeUnder(e.left);
      const left = this.termOf(e.left);
      const saved = this.facts.length;
      if (left !== null) this.facts.push(left);
      this.dischargeUnder(e.right);
      this.facts.length = saved;
      this.overflowObligation(e);
      return;
    }
    if (e.kind === 'Closure' || e.kind === 'Quantifier' || e.kind === 'Recover') {
      // Obligations under binders are not discharged in v0.
      walk(e, (m) => {
        if (m !== e) for (const o of this.ctx.contracts.at(m.id)) if (this.pending.has(o.id)) this.skip(o, 'inside a quantifier or closure');
        return true;
      });
      return;
    }
    if (e.kind === 'Call') this.callObligations(e);
    if (e.kind === 'Binary') this.overflowObligation(e);
    if (e.kind === 'Ctor' || e.kind === 'RecordUpdate') this.fieldObligations(e);
    for (const child of children(e)) this.dischargeUnder(child);
  }

  private safeSort(e: A.Expr): Sort {
    try {
      return this.lowerer.sortOf(this.ty.exprTypes.get(e.id) ?? { k: 'error' });
    } catch {
      return INT;
    }
  }

  private termOf(e: A.Expr): Formula | null {
    return this.lowerer.terms.get(e.id) ?? null;
  }

  private callObligations(call: A.Call): void {
    const info = this.lowerer.calls.get(call.id);
    for (const o of this.obligationsAt(call.id, 'decreases')) {
      const clause = o.source === null ? null : this.t.node(o.source);
      const m0 = this.measure0;
      if (info === undefined || clause === null || clause.kind !== 'Contract') {
        this.skip(o, 'call not lowered');
        continue;
      }
      if (m0 === null) {
        this.skip(o, 'measure not lowered');
        continue;
      }
      this.tryGoal(o, () => app('<', [this.lowerer.withSubst(info.subst, () => this.lowerer.lower(clause.expr, info.args)), m0], BOOL));
    }
    for (const o of this.obligationsAt(call.id, 'requires')) {
      const clause = o.source === null ? null : this.t.node(o.source);
      if (info === undefined || clause === null || clause.kind !== 'Contract') {
        this.skip(o, 'call not lowered');
        continue;
      }
      this.tryGoal(o, () => this.lowerer.withSubst(info.subst, () => this.lowerer.lower(clause.expr, info.args)));
    }
    for (const a of call.args) {
      for (const o of this.obligationsAt(a.value.id, 'refinement')) {
        const term = this.termOf(a.value);
        const target = info?.paramTypes.get(a.name.text);
        if (term === null || target === undefined || info === undefined) {
          this.skip(o, 'argument not lowered');
          continue;
        }
        // A parameter's refinement may mention other parameters: they denote the arguments.
        const calleeEnv = new Map([...this.env, ...info.args]);
        this.tryGoal(o, () => this.lowerer.withSubst(info.subst, () => this.refinementOf(target, term, calleeEnv)));
      }
    }
  }

  private overflowObligation(b: A.Binary): void {
    for (const o of this.obligationsAt(b.id, 'overflow')) {
      const term = this.termOf(b);
      const r = this.termOf(b.right);
      if (term === null || r === null) {
        this.skip(o, 'arithmetic not lowered');
        continue;
      }
      if (b.op === '/' || b.op === '%') this.emit(o, not(eq(r, int(0))));
      else this.emit(o, and(app('<=', [int(-INT_MAX), term], BOOL), app('<=', [term, int(INT_MAX)], BOOL)));
    }
  }

  private fieldObligations(n: A.Ctor | A.RecordUpdate): void {
    const ctorTerm = this.termOf(n);
    const inits = n.kind === 'Ctor' ? [...(n.args ?? []).map((a) => ({ name: a.name.text, value: a.value })), ...(n.fields ?? []).map((f) => ({ name: f.name.text, value: f.value }))] : n.fields.map((f) => ({ name: f.name.text, value: f.value }));
    const type = this.ty.exprTypes.get(n.id);
    const s = type === undefined ? undefined : stripRefinements(type);
    const owner = n.kind === 'Ctor' ? this.ctorOwner(n) : s !== undefined && s.k === 'record' ? s.def : null;
    for (const init of inits) {
      for (const o of this.obligationsAt(init.value.id, 'refinement')) {
        const value = this.termOf(init.value);
        if (ctorTerm === null || value === null || owner === null || type === undefined) {
          this.skip(o, 'constructor not lowered');
          continue;
        }
        const field = (this.ty.fields.get(owner) ?? []).find((f) => f.name === init.name);
        if (field === undefined) {
          this.skip(o, 'unknown field');
          continue;
        }
        // Sibling fields are visible to a field's refinement (§3.3).
        const fieldEnv = new Map(this.env);
        for (const f of this.ty.fields.get(owner) ?? []) fieldEnv.set(f.def, { term: this.lowerer.projectionOf(ctorTerm, type, owner, f.name, f.type), type: f.type });
        this.tryGoal(o, () => this.refinementOf(field.type, value, fieldEnv));
      }
    }
  }

  private ctorOwner(n: A.Ctor): DefId | null {
    const res = this.t.refs.get(n.id);
    return res !== undefined && res.k === 'def' ? res.def : null;
  }

  /** The refinement predicates of `type` applied to `term`, as one formula. */
  private refinementOf(type: Type, term: Formula, env: Env = this.env): Formula {
    const parts: Formula[] = [];
    let cur = type;
    while (cur.k === 'refined') {
      const pred = this.t.node(cur.pred);
      if (isExpr(pred)) {
        const saved = this.lowerer.it;
        this.lowerer.it = term;
        try {
          parts.push(this.lowerer.lower(pred, env));
        } finally {
          this.lowerer.it = saved;
        }
      }
      cur = cur.base;
    }
    return and(...parts);
  }

  /** A refinement obligation at `e` flowing into `type`. */
  private flowGoal(e: A.Expr, term: Formula, type: Type): void {
    for (const o of this.obligationsAt(e.id, 'refinement')) this.tryGoal(o, () => this.refinementOf(type, term));
  }

  // -------------------------------------------------------------------------
  // Emitting conditions
  // -------------------------------------------------------------------------

  private obligationsAt(node: A.NodeId, kind: Obligation['kind']): Obligation[] {
    return this.ctx.contracts.at(node).filter((o) => o.kind === kind && this.pending.has(o.id));
  }

  /** §19.3: from the binding's declared type alone, every value it can hold is within ±2^53 - 1. */
  private representationGoals(at: A.NodeId, type: Type): void {
    for (const o of this.obligationsAt(at, 'representation')) {
      this.tryGoal(o, () => {
        const x = this.lowerer.freshConst('rep', INT);
        this.lowerer.typeFacts(x, type, this.env);
        const max = 9007199254740991n;
        return and(app('>=', [x, int(-max)], BOOL), app('<=', [x, int(max)], BOOL));
      });
    }
  }

  private tryGoal(o: Obligation, goal: () => Formula): void {
    try {
      this.emit(o, goal());
    } catch (err) {
      if (!(err instanceof Unlowerable)) throw err;
      this.skip(o, err.reason);
    }
  }

  private emit(o: Obligation, goal: Formula): void {
    if (!this.pending.has(o.id)) return;
    this.pending.delete(o.id);
    this.out.built.set(o.id, { obligation: o, lowerer: this.lowerer, facts: [...this.facts], goal, names: this.names });
  }

  private skip(o: Obligation, reason: string): void {
    if (!this.pending.has(o.id)) return;
    this.pending.delete(o.id);
    this.out.skipped.set(o.id, reason);
  }
}

function stmtReturns(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'Return':
      return true;
    case 'If':
      return s.else !== null && blockReturns(s.then) && blockReturns(s.else);
    case 'Match':
      return s.arms.length > 0 && s.arms.every((a) => (a.body.kind === 'Block' ? blockReturns(a.body) : stmtReturns(a.body)));
    default:
      return false;
  }
}

function blockReturns(b: A.Block): boolean {
  return b.stmts.some(stmtReturns);
}

/** The conjunction of `fs`, `true` when empty. */
function conj(fs: readonly Formula[]): Formula {
  if (fs.length === 0) return TRUE;
  if (fs.length === 1) return fs[0] ?? TRUE;
  return and(...fs);
}
