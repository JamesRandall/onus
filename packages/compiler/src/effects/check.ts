/**
 * The effects pass (impl spec §4, pass 6; language spec §5.1, §6).
 *
 * A function's body may only have the effects its signature declares:
 *
 *   - a call contributes the callee's declared effects with effect
 *     parameters substituted, except `mutate`, which propagates only when one
 *     of the caller's own `inout` parameters is passed on;
 *   - assigning to an `inout` parameter or passing it `inout` is `mutate`;
 *   - a list literal, `++` and creating a closure are `alloc`; records and
 *     variants are values and do not allocate;
 *   - a `loop while` without `decreases` is `diverge`, and a recursive cycle
 *     whose functions lack a `decreases` clause or `diverge` is E0320;
 *   - `recover` absorbs `panic` from its block;
 *   - a function value flowing into a function-typed position must have no
 *     more effects than the position declares;
 *   - a `const fn` is pure and a contract or refinement may only allocate;
 *   - an impl function declares no effects beyond its interface's.
 *
 * Every violation is E0201 with the offending effects and the site that
 * introduced them.
 */
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Def, DefId, ModuleRecord, ResolveTables } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import { walk } from '../syntax/walk.js';
import type { Signature, TypeTables } from '../types/tables.js';
import { effectsToString, stripRefinements, substitute, type Type, type TypeArg } from '../types/type.js';
import { EffectSet, effectKey, type Effect } from './set.js';
import type { EffectTables } from './tables.js';

const ALLOC: Effect = { k: 'prim', name: 'alloc' };
const MUTATE: Effect = { k: 'prim', name: 'mutate' };
const DIVERGE: Effect = { k: 'prim', name: 'diverge' };
const PANIC: Effect = { k: 'prim', name: 'panic' };

/** Where each effect first arose in a body, for the diagnostic. */
class Sites {
  readonly effects = new Map<string, { effect: Effect; span: Span; why: string }>();

  add(e: Effect, span: Span, why: string): void {
    const k = effectKey(e);
    if (!this.effects.has(k)) this.effects.set(k, { effect: e, span, why });
  }

  addAll(set: EffectSet, span: Span, why: string): void {
    for (const e of set.values()) this.add(e, span, why);
  }

  set(): EffectSet {
    return EffectSet.of([...this.effects.values()].map((x) => x.effect));
  }
}

interface Frame {
  /** `inout` parameters of the function whose body is being walked. */
  readonly inoutParams: ReadonlySet<DefId>;
  readonly sites: Sites;
}

/**
 * Pass 6: check effects of every body.
 * Preconditions: `typesPass` has run without diagnostics.
 * Effects: writes `ctx.effects`; reports E0201, E0320, E0334.
 */
export function effectsPass(ctx: Context): void {
  new EffectChecker(ctx).run();
}

class EffectChecker {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private readonly ef: EffectTables;
  private currentDef: string | null = null;
  /** Direct named-call edges for recursion detection. */
  private readonly callGraph = new Map<DefId, Set<DefId>>();

  constructor(private readonly ctx: Context) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
    this.ef = ctx.effects;
  }

  run(): void {
    for (const m of this.t.modules) {
      for (const item of m.module.items) {
        this.currentDef = 'name' in item ? item.name.text : item.iface.text;
        this.item(m, item);
      }
    }
    this.currentDef = null;
    this.recursion();
  }

  private report(code: Code, span: Span, detail: string): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail] }));
  }

  private show(s: EffectSet): string {
    return effectsToString(s, this.t);
  }

  private defOf(node: A.NodeBase): Def {
    const d = this.t.defOf.get(node.id);
    if (d === undefined) throw new Error(`no definition for node ${node.id}`);
    return this.t.def(d);
  }

  private sig(def: Def): Signature {
    const s = this.ty.signatures.get(def.id);
    if (s === undefined) throw new Error(`no signature for ${def.name}`);
    return s;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private item(m: ModuleRecord, item: A.Item): void {
    switch (item.kind) {
      case 'FnDecl':
        this.fn(item, null);
        break;
      case 'ImplDecl': {
        const ifaceRes = this.t.refs.get(item.id);
        const iface = ifaceRes !== undefined && ifaceRes.k === 'def' ? this.t.def(ifaceRes.def) : null;
        for (const f of item.fns) {
          this.currentDef = `${item.iface.text}.${f.name.text}`;
          const want = iface === null ? null : this.t.defs.find((d) => d.parent === iface.id && d.kind === 'iface-fn' && d.name === f.name.text);
          this.fn(f, want ?? null);
        }
        break;
      }
      case 'InterfaceDecl':
        for (const it of item.items) {
          if (it.kind === 'IfaceFn') this.pureContracts(this.sig(this.defOf(it)));
        }
        break;
      case 'TypeAlias':
        this.pureWheres(item);
        break;
      case 'RecordDecl':
      case 'UnionDecl':
        this.pureWheres(item);
        break;
      default:
        break;
    }
    void m;
  }

  private fn(f: A.FnDecl, ifaceFn: Def | null): void {
    const def = this.defOf(f);
    const sig = this.sig(def);
    if (f.constFn && sig.effects.without(ALLOC).size > 0) {
      this.report('E0201', f.name.span, `a \`const fn\` may only allocate; \`${f.name.text}\` declares ${this.show(sig.effects.without(ALLOC))}`);
    }
    if (ifaceFn !== null) {
      const bound = this.sig(ifaceFn).effects;
      const extra = sig.effects.minus(bound);
      if (extra.length > 0) {
        this.report('E0334', f.name.span, `\`${f.name.text}\` declares ${this.show(EffectSet.of(extra))}, which the interface does not admit`);
      }
    }
    this.pureContracts(sig);
    this.pureWheres(f);
    if (f.body === null) return;
    const frame: Frame = { inoutParams: new Set(sig.paramDefs.filter((p) => this.t.def(p).inout)), sites: new Sites() };
    this.block(f.body, frame, def.id);
    const inferred = frame.sites.set();
    this.ef.inferred.set(def.id, inferred);
    this.containment(inferred, sig.effects, frame.sites, `\`${f.name.text}\``);
  }

  /** Reports every effect of `actual` that `declared` lacks, at the site that introduced it. */
  private containment(actual: EffectSet, declared: EffectSet, sites: Sites, what: string): void {
    for (const e of actual.minus(declared)) {
      const site = sites.effects.get(effectKey(e));
      const span = site?.span;
      if (span === undefined) continue;
      this.report('E0201', span, `${site?.why ?? 'this'} has effect \`${this.show(EffectSet.of([e]))}\`, which ${what} does not declare`);
    }
  }

  /** Contracts may allocate (text in messages) but have no other effect. */
  private pureContracts(sig: Signature): void {
    for (const c of sig.contracts) {
      const sites = new Sites();
      const frame: Frame = { inoutParams: new Set(), sites };
      this.expr(c.expr, frame, null);
      this.containment(sites.set(), EffectSet.of([ALLOC]), sites, `a \`${c.clause}\` clause`);
    }
  }

  /** Refinement predicates (`where`) under `node` may allocate but have no other effect. */
  private pureWheres(node: A.Node): void {
    walk(node, (n) => {
      if (n.kind === 'FnDecl' && n !== node) return false;
      if (n.kind === 'Block') return false;
      if (n.kind === 'NamedType' && n.where !== null) {
        const sites = new Sites();
        this.expr(n.where, { inoutParams: new Set(), sites }, null);
        this.containment(sites.set(), EffectSet.of([ALLOC]), sites, 'a `where` clause');
      }
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block, frame: Frame, owner: DefId | null): void {
    for (const s of b.stmts) this.stmt(s, frame, owner);
  }

  private stmt(s: A.Stmt, frame: Frame, owner: DefId | null): void {
    switch (s.kind) {
      case 'Let':
      case 'Var': {
        this.expr(s.value, frame, owner);
        const declared = this.ty.declTypes.get(this.defOf(s).id);
        if (declared !== undefined) this.flow(s.value, declared, `\`${s.name.text}\``);
        return;
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        if (res !== undefined && res.k === 'def' && frame.inoutParams.has(res.def)) {
          frame.sites.add(MUTATE, s.span, `assigning to inout parameter \`${s.name.text}\``);
        }
        this.expr(s.value, frame, owner);
        return;
      }
      case 'Return':
        this.expr(s.value, frame, owner);
        return;
      case 'If':
        this.expr(s.cond, frame, owner);
        this.block(s.then, frame, owner);
        if (s.else) this.block(s.else, frame, owner);
        return;
      case 'Match':
        this.expr(s.scrutinee, frame, owner);
        for (const a of s.arms) {
          if (a.guard) this.expr(a.guard, frame, owner);
          if (a.body.kind === 'Block') this.block(a.body, frame, owner);
          else this.stmt(a.body, frame, owner);
        }
        return;
      case 'Loop':
        this.expr(s.cond, frame, owner);
        for (const c of s.clauses) this.expr(c.expr, frame, owner);
        if (!s.clauses.some((c) => c.clause === 'decreases')) frame.sites.add(DIVERGE, s.span, 'a `loop while` without `decreases`');
        this.block(s.body, frame, owner);
        return;
      case 'For':
        if (s.domain.kind === 'RangeDomain') {
          this.expr(s.domain.lo, frame, owner);
          this.expr(s.domain.hi, frame, owner);
        } else {
          this.expr(s.domain.expr, frame, owner);
        }
        this.block(s.body, frame, owner);
        return;
      case 'Assume':
        if (s.verify !== null) this.verifyBlock(s.verify, owner);
        return;
      case 'ExprStmt':
        this.expr(s.expr, frame, owner);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private expr(e: A.Expr, frame: Frame, owner: DefId | null): void {
    switch (e.kind) {
      case 'IntLit':
      case 'FloatLit':
      case 'TextLit':
      case 'BoolLit':
      case 'DurationLit':
      case 'Name':
      case 'It':
      case 'ResultRef':
      case 'Old':
      case 'Fake':
      case 'Hole':
        return;
      case 'Ctor':
        for (const a of e.args ?? []) this.expr(a.value, frame, owner);
        for (const f of e.fields ?? []) this.expr(f.value, frame, owner);
        return;
      case 'RecordUpdate':
        this.expr(e.base, frame, owner);
        for (const f of e.fields) this.expr(f.value, frame, owner);
        return;
      case 'ListLit':
        frame.sites.add(ALLOC, e.span, 'a list literal');
        for (const x of e.elems) this.expr(x, frame, owner);
        return;
      case 'Try':
        this.expr(e.expr, frame, owner);
        if (e.else) this.expr(e.else.expr, frame, owner);
        return;
      case 'Recover': {
        const inner: Frame = { inoutParams: new Set(), sites: new Sites() };
        this.block(e.body, inner, owner);
        frame.sites.addAll(inner.sites.set().without(PANIC), e.span, 'this `recover` block');
        return;
      }
      case 'Quantifier':
        if (e.domain !== null) {
          if (e.domain.kind === 'RangeDomain') {
            this.expr(e.domain.lo, frame, owner);
            this.expr(e.domain.hi, frame, owner);
          } else this.expr(e.domain.expr, frame, owner);
        }
        if (e.where) this.expr(e.where, frame, owner);
        this.expr(e.body, frame, owner);
        return;
      case 'Closure':
        this.closure(e, owner);
        frame.sites.add(ALLOC, e.span, 'creating a closure');
        return;
      case 'FieldAccess':
        if (!this.t.refs.has(e.id)) this.expr(e.object, frame, owner);
        return;
      case 'Call':
        this.call(e, frame, owner);
        return;
      case 'Unary':
        this.expr(e.operand, frame, owner);
        return;
      case 'Binary':
        if (e.op === '++') frame.sites.add(ALLOC, e.span, '`++`');
        this.expr(e.left, frame, owner);
        this.expr(e.right, frame, owner);
        return;
      case 'And':
      case 'Or':
        for (const o of e.operands) this.expr(o, frame, owner);
        return;
      case 'Is':
        this.expr(e.expr, frame, owner);
        return;
    }
  }

  /**
   * A `verify` block (§20.2) is checked like a function of its own: its body's
   * effects must be declared on it, and its declared effects may not exceed
   * those of the function containing the `assume` (E0207).
   */
  private verifyBlock(v: A.VerifyBlock, owner: DefId | null): void {
    const declared = this.ty.verifies.get(v.id)?.effects ?? EffectSet.empty();
    const frame: Frame = { inoutParams: new Set(), sites: new Sites() };
    // The block is a definition of its own: its calls are not the enclosing function's (no false recursion).
    this.block(v.body, frame, this.t.defOf.get(v.id) ?? owner);
    this.containment(frame.sites.set(), declared, frame.sites, 'this verify block');
    const sig = owner === null ? undefined : this.ty.signatures.get(owner);
    if (sig === undefined) return;
    const extra = declared.minus(sig.effects);
    if (extra.length > 0) {
      this.report('E0207', v.span, `this verify block declares ${this.show(EffectSet.of(extra))}, which \`${this.t.def(owner ?? sig.def).name}\` does not declare; a verify block may not exceed its function's effects (§20.2)`);
    }
  }

  private closure(e: A.Closure, owner: DefId | null): void {
    const type = this.ty.exprTypes.get(e.id);
    const declared = type !== undefined && type.k === 'fn' ? type.effects : EffectSet.empty();
    const inout = new Set<DefId>();
    for (const p of e.params) {
      const d = this.t.defOf.get(p.id);
      if (d !== undefined && p.inout) inout.add(d);
    }
    const frame: Frame = { inoutParams: inout, sites: new Sites() };
    this.block(e.body, frame, owner);
    const inferred = frame.sites.set();
    this.ef.closures.set(e.id, inferred);
    this.containment(inferred, declared, frame.sites, 'this closure');
  }

  private call(e: A.Call, frame: Frame, owner: DefId | null): void {
    for (const a of e.args) {
      this.expr(a.value, frame, owner);
      if (a.inout && a.value.kind === 'Name') {
        const res = this.t.refs.get(a.value.id);
        if (res !== undefined && res.k === 'def' && frame.inoutParams.has(res.def)) {
          frame.sites.add(MUTATE, a.span, `passing inout parameter \`${a.value.name.text}\` on`);
        }
      }
    }
    const res = this.t.refs.get(e.callee.id);
    let effects: EffectSet | null = null;
    let calleeName = 'this call';
    let sig: Signature | null = null;
    if (res !== undefined && (res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn')) {
      const fnDef = this.t.def(res.k === 'def' ? res.def : res.fn);
      if (fnDef.kind === 'fn' || fnDef.kind === 'iface-fn') {
        sig = this.sig(fnDef);
        calleeName = `\`${fnDef.name}\``;
        const bindings = this.ty.effectBindings.get(e.id);
        effects = sig.effects.substitute((p) => bindings?.get(p) ?? null);
        if (owner !== null && fnDef.kind === 'fn') {
          let edges = this.callGraph.get(owner);
          if (edges === undefined) {
            edges = new Set();
            this.callGraph.set(owner, edges);
          }
          edges.add(fnDef.id);
        }
      }
    }
    if (effects === null) {
      this.expr(e.callee, frame, owner);
      const ct = this.ty.exprTypes.get(e.callee.id);
      const s = ct === undefined ? undefined : stripRefinements(ct);
      effects = s !== undefined && s.k === 'fn' ? s.effects : EffectSet.empty();
    }
    // `mutate` describes the callee's own parameters; the caller needs it only for its own inout parameters.
    const contributed = effects.without(MUTATE);
    this.ef.calls.set(e.id, contributed);
    frame.sites.addAll(contributed, e.span, `calling ${calleeName}`);
    // Function-typed arguments must stay within the effects their parameter admits.
    if (sig !== null) {
      const subst = this.substAt(e, sig);
      for (const a of e.args) {
        const p = sig.params.find((x) => x.name === a.name.text);
        if (p === undefined) continue;
        this.flow(a.value, substitute(p.type, subst), `parameter \`${p.name}\``);
      }
    } else {
      const ct = this.ty.exprTypes.get(e.callee.id);
      const s = ct === undefined ? undefined : stripRefinements(ct);
      if (s !== undefined && s.k === 'fn') {
        for (const a of e.args) {
          const p = s.params.find((x) => x.name === a.name.text);
          if (p !== undefined) this.flow(a.value, p.type, `parameter \`${p.name}\``);
        }
      }
    }
  }

  private substAt(call: A.Call, sig: Signature): Map<DefId, TypeArg> {
    const subst = new Map<DefId, TypeArg>();
    const args = this.ty.instantiations.get(call.id) ?? [];
    sig.tparams.forEach((p, i) => {
      const a = args[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    return subst;
  }

  /** A function value flowing into a function-typed position may not exceed its effects. */
  private flow(value: A.Expr, into: Type, what: string): void {
    const target = stripRefinements(into);
    if (target.k !== 'fn') return;
    const vt = this.ty.exprTypes.get(value.id);
    const actual = vt === undefined ? undefined : stripRefinements(vt);
    if (actual === undefined || actual.k !== 'fn') return;
    const extra = actual.effects.minus(target.effects);
    if (extra.length > 0) {
      this.report('E0201', value.span, `this function has effects ${this.show(EffectSet.of(extra))} that ${what} (${this.showFn(target)}) does not admit`);
    }
  }

  private showFn(t: Type): string {
    return t.k === 'fn' ? `fn(...) -> … may ${this.show(t.effects) || '∅'}` : '?';
  }

  // -------------------------------------------------------------------------
  // Recursion (§5.1)
  // -------------------------------------------------------------------------

  /** A measure's text with the parameters replaced by their positions, so measures compare across a cycle. */
  private measureKey(expr: A.Expr, sig: Signature): string {
    let key = printExpr(expr);
    sig.params.forEach((p, i) => {
      key = key.replace(new RegExp(`(?<![.\\w])${p.name}(?![\\w]|\\s*:)`, 'g'), `$${i}`);
    });
    return key;
  }

  private recursion(): void {
    const index = new Map<DefId, number>();
    const low = new Map<DefId, number>();
    const onStack = new Set<DefId>();
    const stack: DefId[] = [];
    let counter = 0;
    const sccs: DefId[][] = [];
    const strong = (v: DefId): void => {
      index.set(v, counter);
      low.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of this.callGraph.get(v) ?? []) {
        if (!index.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
        }
      }
      if (low.get(v) === index.get(v)) {
        const scc: DefId[] = [];
        for (;;) {
          const w = stack.pop();
          if (w === undefined) break;
          onStack.delete(w);
          scc.push(w);
          if (w === v) break;
        }
        sccs.push(scc);
      }
    };
    for (const v of this.callGraph.keys()) if (!index.has(v)) strong(v);
    let cycle = 0;
    for (const scc of sccs) {
      const first = scc[0];
      const cyclic = scc.length > 1 || (first !== undefined && (this.callGraph.get(first)?.has(first) ?? false));
      if (!cyclic) continue;
      cycle += 1;
      for (const f of scc) this.ctx.effects.cycles.set(f, cycle);
      // Mutual recursion shares one measure, up to renaming of the parameters by position (§5.1).
      const measures = new Map<string, DefId>();
      for (const f of scc) {
        const def = this.t.def(f);
        const sig = this.sig(def);
        const clause = sig.contracts.find((c) => c.clause === 'decreases');
        if (clause === undefined) continue;
        const key = this.measureKey(clause.expr, sig);
        const other = measures.get(key);
        if (other === undefined && measures.size > 0) {
          const [otherKey, otherDef] = [...measures][0] ?? ['', f];
          this.currentDef = def.name;
          this.report('E0320', clause.span, `\`${def.name}\` and \`${this.t.def(otherDef).name}\` are in one recursive cycle but declare different measures (\`${key}\` and \`${otherKey}\`, parameters numbered by position); a cycle shares one measure`);
        }
        if (other === undefined) measures.set(key, f);
      }
      for (const f of scc) {
        const def = this.t.def(f);
        const sig = this.sig(def);
        const measured = sig.contracts.some((c) => c.clause === 'decreases') || sig.effects.has(DIVERGE);
        if (measured) continue;
        this.currentDef = def.name;
        const others = scc.filter((x) => x !== f).map((x) => `\`${this.t.def(x).name}\``);
        this.report('E0320', def.span, `\`${def.name}\` is recursive${others.length > 0 ? ` (with ${others.join(', ')})` : ''} and declares neither \`decreases\` nor \`diverge\``);
      }
    }
  }
}
