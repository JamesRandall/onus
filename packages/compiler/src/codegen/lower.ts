/**
 * Lowering (impl spec §6; language spec §19): the checked AST plus obligation
 * statuses become the target-neutral form of `ir.ts`. This is the one place
 * that decides what generated code does; emitters only render:
 *
 *   - a `checked` obligation becomes a `check` (or a `checked` wrapper for a
 *     value flowing into a refined position); a `proved` one becomes nothing;
 *   - a callee checks its parameter refinements and non-pinned `requires` on
 *     entry unless every call site proved them;
 *   - `inout` calls become `call-inout` statements that assign the results
 *     back; a function with `inout` parameters returns them with its result;
 *   - `match` becomes a scrutinee temporary, per-arm tests and bindings;
 *   - loops carry their `invariant`/`decreases` checks as statements;
 *   - `old(x)` is a snapshot at entry; `result` is the return temporary;
 *   - interface calls resolve statically on concrete receivers and go through
 *     a dictionary parameter otherwise;
 *   - `example`/`property`/`law` bodies become assertion blocks; `verify`
 *     blocks become Bool-yielding assertion functions.
 */
import { calleeOf } from '../claims/calls.js';
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import type { Def, DefId, ModuleRecord, ResolveTables } from '../resolve/defs.js';
import { lineColOf, type Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import { isExpr, walk } from '../syntax/walk.js';
import type { Signature, TypeTables } from '../types/tables.js';
import { BOOL, prim, stripRefinements, substitute, type ConstValue, type Type, type TypeArg } from '../types/type.js';
import type { IrArm, IrBlock, IrCallTarget, IrDomain, IrExpr, IrFn, IrGen, IrGenBase, IrImpl, IrItem, IrModule, IrParam, IrStmt, IrTests, IrVerify, ObRef } from './ir.js';

export interface LowerOptions {
  /** Lower every `verify` block too (`onus test --assumptions`, §20.2). */
  readonly verify: boolean;
}

const ERROR: Type = { k: 'error' };
const UNIT: IrExpr = { k: 'unit' };

/**
 * Lowers one module.
 * Preconditions: every pass through `paths` ran without diagnostics.
 * Effects: none.
 */
export function lowerModule(ctx: Context, m: ModuleRecord, opts: LowerOptions): IrModule {
  return new Lowerer(ctx, m, opts).run();
}

/** Per-function lowering context. */
interface FnCtx {
  readonly inout: readonly string[];
  readonly ret: Type;
  readonly ensures: readonly A.Contract[];
  readonly def: Def | null;
  readonly dicts: ReadonlyMap<DefId, string>;
  result: IrExpr | null;
}

class Lowerer {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private fn: FnCtx | null = null;
  /** The value `it` names inside a refinement predicate. */
  private it: IrExpr | null = null;
  /** Inside a record or variant literal's field checks: sibling fields read from the literal. */
  private fieldObject: { readonly record: DefId; readonly name: string; readonly type: Type } | null = null;
  private temp = 0;
  /** Statements an expression needed before itself (`inout` calls), flushed before the enclosing statement. */
  private pre: IrStmt[] = [];
  /** Inside an impl: interface function → the implementing function. */
  private implFns: ReadonlyMap<DefId, { readonly def: Def; readonly name: string }> = new Map();
  private verifying = false;

  constructor(
    private readonly ctx: Context,
    private readonly m: ModuleRecord,
    private readonly opts: LowerOptions,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
  }

  run(): IrModule {
    const items: IrItem[] = [];
    let main: IrModule['main'] = null;
    for (const item of this.m.module.items) {
      const ir = this.item(item);
      if (ir !== null) items.push(ir);
      if (item.kind === 'FnDecl' && item.name.text === 'main' && item.vis.pub) main = this.mainSpec(item);
    }
    return { module: this.m, items, tests: this.tests(), verifies: this.opts.verify ? this.verifies() : [], main };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private defOf(node: A.NodeBase): DefId {
    const d = this.t.defOf.get(node.id);
    if (d === undefined) throw new Error(`no definition for node ${node.id}`);
    return d;
  }

  private typeOfExpr(e: A.Expr): Type {
    return this.ty.exprTypes.get(e.id) ?? ERROR;
  }

  private tmp(prefix = 't'): string {
    this.temp += 1;
    return `$${prefix}${this.temp}`;
  }

  private where(span: Span): string {
    const f = this.ctx.fileOf(span);
    const p = lineColOf(f, span.start);
    return `${f.path}:${p.line}:${p.col}`;
  }

  private obRef(kind: string, text: string, span: Span, def: string): ObRef {
    return { kind, text, at: this.where(span), def };
  }

  private obRefOf(o: Obligation): ObRef {
    return this.obRef(o.kind, o.text, this.t.node(o.at).span, this.t.def(o.def).name);
  }

  private withIt<T>(it: IrExpr, f: () => T): T {
    const saved = this.it;
    this.it = it;
    try {
      return f();
    } finally {
      this.it = saved;
    }
  }

  private refinementPreds(t: Type): A.Expr[] {
    const out: A.Expr[] = [];
    let cur = t;
    while (cur.k === 'refined') {
      const n = this.t.node(cur.pred);
      if (isExpr(n)) out.push(n);
      cur = cur.base;
    }
    return out;
  }

  /** Runs `f` with a fresh pre-statement buffer and returns its statements followed by `f`'s result. */
  private collect(f: () => IrStmt[]): IrStmt[] {
    const saved = this.pre;
    this.pre = [];
    try {
      const out = f();
      return [...this.pre, ...out];
    } finally {
      this.pre = saved;
    }
  }

  private isOption(t: Type): boolean {
    const s = stripRefinements(t);
    return s.k === 'union' && this.t.qualifiedName(s.def) === 'std.option.Option';
  }

  private typeSlug(t: Type): string {
    const s = stripRefinements(t);
    switch (s.k) {
      case 'prim':
        return s.name;
      case 'record':
      case 'union':
      case 'opaque':
      case 'capability':
        return `${this.t.def(s.def).name}${s.args.map((a) => (a.k === 'type' ? `_${this.typeSlug(a.type)}` : '')).join('')}`;
      case 'param':
        return this.t.def(s.def).name;
      default:
        return 'X';
    }
  }

  private targetType(node: A.ImplDecl): Type {
    const known = this.ty.exprTypes.get(node.target.id);
    if (known !== undefined) return known;
    const res = this.t.refs.get(node.target.id);
    if (res !== undefined && res.k === 'prim') return { k: 'prim', name: res.name };
    if (res !== undefined && res.k === 'def') {
      const d = this.t.def(res.def);
      if (d.kind === 'record') return { k: 'record', def: d.id, args: [] };
      if (d.kind === 'union') return { k: 'union', def: d.id, args: [] };
      if (d.kind === 'alias') return this.ty.aliases.get(d.id) ?? ERROR;
      if (d.kind === 'intrinsic-type') return { k: 'opaque', def: d.id, args: [] };
    }
    return ERROR;
  }

  private implFnName(def: Def): string {
    const impl = def.parent === null ? null : this.t.def(def.parent);
    if (impl === null) return def.name;
    const node = this.t.node(impl.node);
    const target = node.kind === 'ImplDecl' ? this.typeSlug(this.targetType(node)) : '';
    return `${impl.name}$${target}$${def.name}`;
  }

  /** The emitted name of a function: its own, or `Iface$Target$fn` inside an impl. */
  private emittedName(def: Def): string {
    return def.parent !== null && this.t.def(def.parent).kind === 'impl' ? this.implFnName(def) : def.name;
  }

  private implDictName(iface: Def, target: Type): string {
    return `${iface.name}$${this.typeSlug(target)}`;
  }

  /** Type parameters of a record or union instantiation, bound to its arguments. */
  private substOf(type: Type): Map<DefId, TypeArg> {
    const s = stripRefinements(type);
    const subst = new Map<DefId, TypeArg>();
    if (s.k !== 'record' && s.k !== 'union' && s.k !== 'opaque') return subst;
    (this.ty.typeParams.get(s.def) ?? []).forEach((p, i) => {
      const a = s.args[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    return subst;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private item(item: A.Item): IrItem | null {
    switch (item.kind) {
      case 'FnDecl':
        return this.fnDecl(item, null);
      case 'ConstDecl': {
        const def = this.t.def(this.defOf(item));
        const value = this.ctx.consteval.constValues.get(def.id);
        const type = this.ty.declTypes.get(def.id) ?? ERROR;
        return { k: 'const', def, type, value: value !== undefined ? { k: 'value', value } : this.expr(item.value) };
      }
      case 'TypeAlias': {
        const def = this.t.def(this.defOf(item));
        return { k: 'alias', def, type: this.ty.aliases.get(def.id) ?? ERROR };
      }
      case 'IntrinsicType': {
        const def = this.t.def(this.defOf(item));
        return { k: 'intrinsic-type', def, params: this.typeParamDefs(def.id) };
      }
      case 'RecordDecl': {
        const def = this.t.def(this.defOf(item));
        return { k: 'record', def, params: this.typeParamDefs(def.id), fields: (this.ty.fields.get(def.id) ?? []).map((f) => ({ name: f.name, type: f.type })) };
      }
      case 'UnionDecl': {
        const def = this.t.def(this.defOf(item));
        const variants = (this.ty.variants.get(def.id) ?? []).map((v) => ({ def: this.t.def(v), fields: (this.ty.fields.get(v) ?? []).map((f) => ({ name: f.name, type: f.type })) }));
        return { k: 'union', def, params: this.typeParamDefs(def.id), variants };
      }
      case 'InterfaceDecl': {
        const def = this.t.def(this.defOf(item));
        const tp = this.t.defs.find((d) => d.kind === 'type-param' && d.node === def.node);
        const fns = this.t.defs.filter((d) => d.parent === def.id && d.kind === 'iface-fn').flatMap((d) => {
          const sig = this.ty.signatures.get(d.id);
          return sig === undefined ? [] : [{ def: d, sig }];
        });
        return { k: 'interface', def, tparam: tp === undefined ? null : tp.name, fns };
      }
      case 'ImplDecl':
        return this.impl(item);
      case 'CapabilityDecl':
        return { k: 'capability', def: this.t.def(this.defOf(item)) };
      case 'ClaimDecl':
      case 'PathDecl':
      case 'PolicyDecl':
      case 'ExampleDecl':
      case 'PropertyDecl':
        return null;
    }
  }

  private typeParamDefs(def: DefId): DefId[] {
    return (this.ty.typeParams.get(def) ?? []).filter((p) => p.k === 'type').map((p) => p.def);
  }

  private impl(item: A.ImplDecl): IrImpl | null {
    const ifaceRes = this.t.refs.get(item.id);
    if (ifaceRes === undefined || ifaceRes.k !== 'def') return null;
    const iface = this.t.def(ifaceRes.def);
    const target = this.targetType(item);
    const map = new Map<DefId, { def: Def; name: string }>();
    for (const f of item.fns) {
      const fd = this.t.def(this.defOf(f));
      const want = this.t.defs.find((d) => d.parent === iface.id && d.kind === 'iface-fn' && d.name === f.name.text);
      if (want !== undefined) map.set(want.id, { def: fd, name: this.implFnName(fd) });
    }
    this.implFns = map;
    const fns: IrFn[] = [];
    for (const f of item.fns) {
      const ir = this.fnDecl(f, { name: this.implFnName(this.t.def(this.defOf(f))) });
      if (ir !== null) fns.push(ir);
    }
    this.implFns = new Map();
    const entries = fns.map((fn) => ({ name: fn.def.name, fn }));
    return { k: 'impl', def: this.t.def(this.defOf(item)), iface, target, dictName: this.implDictName(iface, target), fns, entries };
  }

  private fnDecl(f: A.FnDecl, impl: { readonly name: string } | null): IrFn | null {
    const def = this.t.def(this.defOf(f));
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return null;
    const dictParams = sig.tparams.flatMap((p) => (p.k === 'type' && p.bound !== null ? [{ def: p.def, iface: p.bound, name: `$dict_${this.t.def(p.def).name}` }] : []));
    const constParams = sig.tparams.flatMap((p) => (p.k === 'const' ? [{ def: p.def, name: this.t.def(p.def).name, type: p.type }] : []));
    const params: IrParam[] = sig.params.map((p) => ({ name: p.name, type: p.type, inout: p.inout }));
    const head = { k: 'fn' as const, def, sig, name: impl?.name ?? def.name, dictParams, constParams, params, ret: sig.ret };
    if (f.intrinsic) {
      const q = this.t.qualifiedName(def.id);
      return { ...head, intrinsic: { ns: q.split('.')[1] ?? '', name: def.name }, entry: [], body: null, earlyReturn: false };
    }
    if (f.body === null) return null;
    const olds = new Set<string>();
    for (const c of f.contracts) {
      walk(c.expr, (n) => {
        if (n.kind === 'Old') olds.add(n.name.text);
        return true;
      });
    }
    this.fn = { inout: params.filter((p) => p.inout).map((p) => p.name), ret: sig.ret, ensures: f.contracts.filter((c) => c.clause === 'ensures'), def, dicts: new Map(dictParams.map((d) => [d.def, d.name])), result: null };
    const entry: IrStmt[] = this.collect(() => this.entryChecks(sig, f.contracts, def.name));
    for (const o of olds) {
      const type = params.find((p) => p.name === o)?.type ?? ERROR;
      entry.push({ k: 'let', name: `$old_${o}`, type, mutable: false, value: { k: 'snapshot', value: { k: 'local', name: o, type }, type } });
    }
    const body = this.block(f.body);
    if (this.fn.inout.length > 0 && isUnit(sig.ret)) body.push({ k: 'return', value: UNIT });
    this.fn = null;
    return { ...head, intrinsic: null, entry, body, earlyReturn: containsTry(f.body) };
  }

  /** Parameter refinements and non-pinned `requires` the callee checks on entry, unless every call site proved them. */
  private entryChecks(sig: Signature, contracts: readonly A.Contract[], defName: string): IrStmt[] {
    const out: IrStmt[] = [];
    const callSites = this.ctx.contracts.obligations.filter((o) => o.callee === sig.def);
    sig.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      if (pd === undefined) return;
      const declared = this.ty.declTypes.get(pd);
      if (declared === undefined) return;
      const flows = callSites.filter((o) => o.kind === 'refinement' && o.param === p.name);
      if (flows.length > 0 && flows.every((o) => o.status === 'proved')) return;
      const node = this.t.node(this.t.def(pd).node);
      const local: IrExpr = { k: 'local', name: p.name, type: declared };
      for (const pred of this.refinementPreds(declared)) {
        out.push({ k: 'check', cond: this.withIt(local, () => this.expr(pred)), ob: this.obRef('refinement', printExpr(pred), node.span, defName) });
      }
    });
    for (const c of contracts) {
      if (c.clause !== 'requires' || c.proved) continue;
      const sites = callSites.filter((o) => o.kind === 'requires' && o.source === c.id);
      if (sites.length > 0 && sites.every((o) => o.status === 'proved')) continue;
      out.push({ k: 'check', cond: this.expr(c.expr), ob: this.obRef('requires', printExpr(c.expr), c.span, defName) });
    }
    return out;
  }

  private mainSpec(f: A.FnDecl): IrModule['main'] {
    const def = this.t.def(this.defOf(f));
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return null;
    const roots: Record<string, string> = {};
    let args = 'args';
    for (const p of sig.params) {
      const s = stripRefinements(p.type);
      if (s.k === 'capability') {
        if (this.t.qualifiedName(s.def).startsWith('std.io.')) roots[p.name] = this.t.def(s.def).name;
      } else if (s.k === 'opaque') {
        args = p.name;
      }
    }
    return { roots, args };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): IrStmt[] {
    return b.stmts.flatMap((s) => this.stmt(s));
  }

  private stmt(s: A.Stmt): IrStmt[] {
    return this.collect(() => this.stmtInner(s));
  }

  private stmtInner(s: A.Stmt): IrStmt[] {
    switch (s.kind) {
      case 'Let':
      case 'Var': {
        const def = this.t.def(this.defOf(s));
        const declared = this.ty.declTypes.get(def.id) ?? ERROR;
        return [{ k: 'let', name: def.name, type: declared, mutable: s.kind === 'Var', value: this.checkedFlow(s.value, declared) }];
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        const def = res !== undefined && res.k === 'def' ? this.t.def(res.def) : null;
        const declared = def === null ? ERROR : (this.ty.declTypes.get(def.id) ?? ERROR);
        return [{ k: 'assign', name: def === null ? s.name.text : def.name, type: declared, value: this.checkedFlow(s.value, declared) }];
      }
      case 'Return':
        return this.returnStmt(s);
      case 'If': {
        const cond = this.expr(s.cond);
        return [{ k: 'if', cond, then: this.block(s.then), else: s.else ? this.block(s.else) : null }];
      }
      case 'Match':
        return this.match(s);
      case 'Loop':
        return this.loop(s);
      case 'For':
        return this.forStmt(s);
      case 'Assume':
        return [{ k: 'comment', text: `assume ${s.claim.segments.map((x) => x.text).join('.')} ${JSON.stringify(s.justification)}` }];
      case 'ExprStmt': {
        const e = this.expr(s.expr, true);
        return e.k === 'unit' ? [] : [{ k: 'expr', expr: e }];
      }
    }
  }

  /** `value` flowing into `declared`: wrapped in the refinement checks when that flow is a checked obligation. */
  private checkedFlow(value: A.Expr, declared: Type): IrExpr {
    const ob = this.ctx.contracts.find(value.id, 'refinement');
    const e = this.expr(value);
    if (ob === null || ob.status !== 'checked') return e;
    const preds = this.refinementPreds(declared);
    if (preds.length === 0) return e;
    const it = this.tmp('it');
    const itExpr: IrExpr = { k: 'local', name: it, type: declared };
    const checks: IrStmt[] = preds.map((p) => ({ k: 'check', cond: this.withIt(itExpr, () => this.expr(p)), ob: this.obRefOf(ob) }));
    return { k: 'checked', value: e, it, type: declared, checks };
  }

  private returnStmt(s: A.Return): IrStmt[] {
    const fn = this.fn;
    if (fn === null) return [{ k: 'return', value: this.expr(s.value) }];
    const value = this.checkedFlow(s.value, fn.ret);
    const ensures = this.ctx.contracts.at(s.id).filter((o) => o.kind === 'ensures' && o.status === 'checked');
    if (ensures.length === 0) return [{ k: 'return', value }];
    const r = this.tmp('r');
    const result: IrExpr = { k: 'local', name: r, type: fn.ret };
    const out: IrStmt[] = [{ k: 'let', name: r, type: fn.ret, mutable: false, value }];
    fn.result = result;
    for (const o of ensures) {
      const clause = fn.ensures.find((c) => c.id === o.source);
      if (clause === undefined) continue;
      out.push({ k: 'check', cond: this.expr(clause.expr), ob: this.obRefOf(o) });
    }
    fn.result = null;
    out.push({ k: 'return', value: result });
    return out;
  }

  private match(s: A.Match): IrStmt[] {
    const tmp = this.tmp('m');
    const type = this.typeOfExpr(s.scrutinee);
    const scrutinee = this.expr(s.scrutinee);
    const subject: IrExpr = { k: 'local', name: tmp, type };
    const arms: IrArm[] = s.arms.map((arm) => ({
      test: this.patternTest(arm.pattern, subject, type),
      bindings: this.patternBindings(arm.pattern, subject, type),
      guard: arm.guard ? this.expr(arm.guard) : null,
      body: arm.body.kind === 'Block' ? this.block(arm.body) : this.stmt(arm.body),
    }));
    return [{ k: 'match', tmp, type, scrutinee, arms }];
  }

  private patternTest(p: A.Pattern, subject: IrExpr, type: Type): IrExpr | null {
    switch (p.kind) {
      case 'WildcardPat':
      case 'BindPat':
        return null;
      case 'LitPat':
        return { k: 'eq', left: subject, right: this.expr(p.literal), type, prim: false, negate: false };
      case 'VariantPat': {
        const res = this.t.refs.get(p.id);
        if (res === undefined || res.k !== 'def') return { k: 'bool', v: false };
        return { k: 'is-variant', subject, variant: this.t.def(res.def), type };
      }
    }
  }

  private patternBindings(p: A.Pattern, subject: IrExpr, type: Type): IrArm['bindings'] {
    if (p.kind === 'BindPat') return [{ name: p.name.text, type, value: subject }];
    if (p.kind !== 'VariantPat' || p.fields === null) return [];
    const res = this.t.refs.get(p.id);
    if (res === undefined || res.k !== 'def') return [];
    const fields = this.ty.fields.get(res.def) ?? [];
    const subst = this.substOf(type);
    const out: { name: string; type: Type; value: IrExpr }[] = [];
    let i = 0;
    for (const pf of p.fields) {
      if (pf.kind === 'PatFieldRest') break;
      const f = fields[i];
      if (pf.kind === 'PatFieldName' && f !== undefined) {
        const ft = substitute(f.type, subst);
        out.push({ name: pf.name.text, type: ft, value: { k: 'field', object: subject, name: f.name, type: ft, owner: this.t.def(res.def) } });
      }
      i += 1;
    }
    return out;
  }

  private loop(s: A.Loop): IrStmt[] {
    const obs = this.ctx.contracts.at(s.id);
    const invariants = s.clauses.filter((c) => c.clause === 'invariant');
    const decreases = s.clauses.find((c) => c.clause === 'decreases') ?? null;
    const out: IrStmt[] = [];
    for (const inv of invariants) {
      const o = obs.find((x) => x.kind === 'invariant-entry' && x.source === inv.id);
      if (o !== undefined && o.status === 'checked') out.push({ k: 'check', cond: this.expr(inv.expr), ob: this.obRefOf(o) });
    }
    const cond = this.expr(s.cond);
    const body: IrStmt[] = [];
    const dec = decreases === null ? null : (obs.find((x) => x.kind === 'decreases' && x.source === decreases.id) ?? null);
    const measure = this.tmp('measure');
    const measureExpr: IrExpr = { k: 'local', name: measure, type: prim('Int') };
    const checkedDecreases = dec !== null && dec.status === 'checked' && decreases !== null;
    if (checkedDecreases && dec !== null && decreases !== null) {
      body.push(...this.collect(() => [{ k: 'let', name: measure, type: prim('Int'), mutable: false, value: this.expr(decreases.expr) }]));
      body.push({ k: 'check', cond: { k: 'cmp', op: '>=', left: measureExpr, right: { k: 'int', v: 0n }, float: false }, ob: this.obRefOf(dec) });
    }
    body.push(...this.block(s.body));
    for (const inv of invariants) {
      const o = obs.find((x) => x.kind === 'invariant-step' && x.source === inv.id);
      if (o !== undefined && o.status === 'checked') body.push(...this.collect(() => [{ k: 'check', cond: this.expr(inv.expr), ob: this.obRefOf(o) }]));
    }
    if (checkedDecreases && dec !== null && decreases !== null) {
      body.push(...this.collect(() => [{ k: 'check', cond: { k: 'cmp', op: '<', left: this.expr(decreases.expr), right: measureExpr, float: false }, ob: this.obRefOf(dec) }]));
    }
    out.push({ k: 'loop', cond, body });
    return out;
  }

  private forStmt(s: A.For): IrStmt[] {
    const def = this.t.def(this.defOf(s));
    const declared = this.ty.declTypes.get(def.id) ?? ERROR;
    if (s.domain.kind === 'RangeDomain') {
      const lo = this.expr(s.domain.lo);
      let hi = this.expr(s.domain.hi);
      if (hi.k !== 'int' && hi.k !== 'local') {
        const name = this.tmp('hi');
        this.pre.push({ k: 'let', name, type: prim('Int'), mutable: false, value: hi });
        hi = { k: 'local', name, type: prim('Int') };
      }
      return [{ k: 'for-range', name: def.name, lo, hi, body: this.block(s.body) }];
    }
    const list = this.expr(s.domain.expr);
    const ob = this.ctx.contracts.find(s.domain.expr.id, 'refinement');
    const body: IrStmt[] = [];
    if (ob !== null && ob.status === 'checked') {
      const local: IrExpr = { k: 'local', name: def.name, type: declared };
      for (const p of this.refinementPreds(declared)) body.push(...this.collect(() => [{ k: 'check', cond: this.withIt(local, () => this.expr(p)), ob: this.obRefOf(ob) }]));
    }
    body.push(...this.block(s.body));
    return [{ k: 'for-each', name: def.name, type: declared, list, body }];
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /** Lowers `e`; with `discard`, a call whose `inout` results were assigned yields `unit`. */
  private expr(e: A.Expr, discard = false): IrExpr {
    switch (e.kind) {
      case 'IntLit':
        return { k: 'int', v: e.value };
      case 'FloatLit':
        return { k: 'float', v: e.value };
      case 'TextLit':
        return { k: 'text', v: e.value };
      case 'BoolLit':
        return { k: 'bool', v: e.value };
      case 'DurationLit':
        return { k: 'int', v: e.nanos };
      case 'Name':
        return this.name(e);
      case 'It':
        return this.it ?? { k: 'local', name: '$it', type: this.typeOfExpr(e) };
      case 'ResultRef':
        return this.fn?.result ?? { k: 'local', name: '$r', type: this.typeOfExpr(e) };
      case 'Old':
        return { k: 'local', name: `$old_${e.name.text}`, type: this.typeOfExpr(e) };
      case 'Ctor':
        return this.ctor(e);
      case 'RecordUpdate':
        return this.recordUpdate(e);
      case 'ListLit':
        return { k: 'list', elems: e.elems.map((x) => this.expr(x)), type: this.typeOfExpr(e) };
      case 'Try':
        return this.tryExpr(e);
      case 'Recover':
        return this.recover(e);
      case 'Quantifier':
        return this.quantifier(e);
      case 'Closure':
        return this.closure(e);
      case 'Fake':
        return this.fake(e);
      case 'Hole':
        throw new Error('a hole cannot be compiled');
      case 'FieldAccess':
        return this.fieldAccess(e);
      case 'Call':
        return this.call(e, discard);
      case 'Unary':
        return this.unary(e);
      case 'Binary':
        return this.binary(e);
      case 'And':
        return { k: 'and', operands: e.operands.map((o) => this.expr(o)) };
      case 'Or':
        return { k: 'or', operands: e.operands.map((o) => this.expr(o)) };
      case 'Is': {
        const subject = this.expr(e.expr);
        const test = this.patternTest(e.pattern, subject, this.typeOfExpr(e.expr));
        return test ?? { k: 'bool', v: true };
      }
    }
  }

  private fnValue(def: Def): IrExpr {
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return { k: 'local', name: def.name, type: ERROR };
    return { k: 'fnref', def, name: this.emittedName(def), sig };
  }

  private name(e: A.Name): IrExpr {
    const type = this.typeOfExpr(e);
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') return { k: 'local', name: e.name.text, type };
    const def = this.t.def(res.def);
    if (def.kind === 'fn') return this.fnValue(def);
    if (def.kind === 'const') return { k: 'global', def, type };
    if (def.kind === 'field' && this.fieldObject !== null && this.fieldObject.record === def.parent) {
      return { k: 'field', object: { k: 'local', name: this.fieldObject.name, type: this.fieldObject.type }, name: def.name, type, owner: this.t.def(this.fieldObject.record) };
    }
    return { k: 'local', name: def.name, type };
  }

  private typeInfoOf(def: DefId | null, primName: string | null): IrExpr {
    if (def === null) return { k: 'typeinfo', name: primName ?? '?', fields: [] };
    const d = this.t.def(def);
    return { k: 'typeinfo', name: d.name, fields: (this.ty.fields.get(def) ?? []).map((f) => ({ name: f.name, type_name: this.typeSlug(f.type) })) };
  }

  private ctor(e: A.Ctor): IrExpr {
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k === 'unit') return UNIT;
    if (res.k === 'type-value') return this.typeInfoOf(res.type.k === 'def' ? res.type.def : null, res.type.k === 'prim' ? res.type.name : null);
    if (res.k !== 'def') return UNIT;
    const def = this.t.def(res.def);
    const type = this.typeOfExpr(e);
    const inits = [...(e.args ?? []).map((a) => ({ name: a.name.text, value: a.value })), ...(e.fields ?? []).map((f) => ({ name: f.name.text, value: f.value }))];
    const fields = inits.map((i) => ({ name: i.name, value: this.expr(i.value) }));
    const literal: IrExpr = def.kind === 'variant' ? { k: 'variant', def, type, fields } : { k: 'record', def, type, fields };
    return this.fieldChecks(def, literal, type, inits);
  }

  private recordUpdate(e: A.RecordUpdate): IrExpr {
    const type = this.typeOfExpr(e);
    const base = this.expr(e.base);
    const s = stripRefinements(this.typeOfExpr(e.base));
    const def = s.k === 'record' ? this.t.def(s.def) : null;
    const inits = e.fields.map((f) => ({ name: f.name.text, value: f.value }));
    const fields = inits.map((i) => ({ name: i.name, value: this.expr(i.value) }));
    if (def === null) return { k: 'update', base, def: this.t.def(this.defOf(this.m.module)), type, fields };
    return this.fieldChecks(def, { k: 'update', base, def, type, fields }, type, inits);
  }

  /** Wraps a record or variant literal in the checks of its refined fields whose flows are checked obligations. */
  private fieldChecks(def: Def, literal: IrExpr, type: Type, inits: readonly { readonly name: string; readonly value: A.Expr }[]): IrExpr {
    const fields = this.ty.fields.get(def.id) ?? [];
    const checks: IrStmt[] = [];
    const v = this.tmp('v');
    const object: IrExpr = { k: 'local', name: v, type };
    const saved = this.fieldObject;
    this.fieldObject = { record: def.id, name: v, type };
    for (const init of inits) {
      const ob = this.ctx.contracts.find(init.value.id, 'refinement');
      if (ob === null || ob.status !== 'checked') continue;
      const field = fields.find((f) => f.name === init.name);
      if (field === undefined) continue;
      const it: IrExpr = { k: 'field', object, name: field.name, type: field.type, owner: def };
      for (const p of this.refinementPreds(field.type)) checks.push({ k: 'check', cond: this.withIt(it, () => this.expr(p)), ob: this.obRefOf(ob) });
    }
    this.fieldObject = saved;
    if (checks.length === 0) return literal;
    return { k: 'checked', value: literal, it: v, type, checks };
  }

  private tryExpr(e: A.Try): IrExpr {
    const operand = this.expr(e.expr);
    const option = this.isOption(this.typeOfExpr(e.expr));
    const fnRet = this.fn?.ret ?? null;
    const outerOption = fnRet !== null && this.isOption(fnRet);
    const type = this.typeOfExpr(e);
    if (e.else === null) return { k: 'try', operand, option, outerOption, else: null, raw: false, type };
    const name = e.else.name.text === '_' ? null : e.else.name.text;
    const errorType = name === null ? ERROR : (this.ty.declTypes.get(this.defOf(e.else)) ?? ERROR);
    return { k: 'try', operand, option, outerOption, else: { name, errorType, value: this.expr(e.else.expr) }, raw: this.verifying, type };
  }

  private recover(e: A.Recover): IrExpr {
    const saved = this.fn;
    this.fn = saved === null ? null : { ...saved, ret: ERROR, ensures: [], inout: [] };
    const last = e.body.stmts[e.body.stmts.length - 1];
    const body: IrStmt[] = [];
    let value: IrExpr = UNIT;
    for (const s of e.body.stmts) {
      if (s === last && s.kind === 'ExprStmt') {
        body.push(...this.collect(() => {
          value = this.expr(s.expr);
          return [];
        }));
      } else body.push(...this.stmt(s));
    }
    this.fn = saved;
    return { k: 'recover', body, value, type: this.typeOfExpr(e) };
  }

  private quantifier(e: A.Quantifier): IrExpr {
    const def = this.t.def(this.defOf(e));
    const binder = this.ty.declTypes.get(def.id) ?? ERROR;
    let domain: IrDomain;
    if (e.domain === null) domain = { k: 'bools' };
    else if (e.domain.kind === 'RangeDomain') domain = { k: 'range', lo: this.expr(e.domain.lo), hi: this.expr(e.domain.hi) };
    else {
      const s = stripRefinements(this.typeOfExpr(e.domain.expr));
      domain = s.k === 'union' ? { k: 'oklist', expr: this.expr(e.domain.expr) } : { k: 'list', expr: this.expr(e.domain.expr) };
    }
    return { k: 'quantifier', quant: e.quant, name: def.name, binder, domain, where: e.where === null ? null : this.expr(e.where), body: this.expr(e.body) };
  }

  private closure(e: A.Closure): IrExpr {
    const type = this.typeOfExpr(e);
    const fnType = type.k === 'fn' ? type : null;
    const params: IrParam[] = e.params.map((p) => {
      const pd = this.t.defOf.get(p.id);
      return { name: p.name.text, type: (pd === undefined ? undefined : this.ty.declTypes.get(pd)) ?? ERROR, inout: p.inout };
    });
    const saved = this.fn;
    this.fn = { inout: params.filter((p) => p.inout).map((p) => p.name), ret: fnType?.ret ?? ERROR, ensures: [], def: saved?.def ?? null, dicts: saved?.dicts ?? new Map(), result: null };
    const entry: IrStmt[] = [];
    e.params.forEach((p, i) => {
      const param = params[i];
      if (param === undefined) return;
      const local: IrExpr = { k: 'local', name: param.name, type: param.type };
      for (const pred of this.refinementPreds(param.type)) {
        entry.push(...this.collect(() => [{ k: 'check', cond: this.withIt(local, () => this.expr(pred)), ob: this.obRef('refinement', printExpr(pred), p.span, saved?.def?.name ?? 'closure') }]));
      }
    });
    const body = this.block(e.body);
    if (this.fn.inout.length > 0 && fnType !== null && isUnit(fnType.ret)) body.push({ k: 'return', value: UNIT });
    this.fn = saved;
    return { k: 'closure', params, fnType, entry, body, earlyReturn: containsTry(e.body) };
  }

  private fake(e: A.Fake): IrExpr {
    const res = this.t.refs.get(e.id);
    const kind = res !== undefined && res.k === 'def' ? this.t.def(res.def).name : 'capability';
    return { k: 'fake', kind, fields: e.fields.map((f) => ({ name: f.name.text, value: this.expr(f.value) })), type: this.typeOfExpr(e) };
  }

  private fieldAccess(e: A.FieldAccess): IrExpr {
    const type = this.typeOfExpr(e);
    const res = this.t.refs.get(e.id);
    if (res !== undefined) {
      if (res.k === 'def') {
        const d = this.t.def(res.def);
        return d.kind === 'fn' ? this.fnValue(d) : { k: 'global', def: d, type };
      }
      if (res.k === 'companion') return this.fnValue(this.t.def(res.fn));
      if (res.k === 'unit') return UNIT;
      if (res.k === 'type-value') return this.typeInfoOf(res.type.k === 'def' ? res.type.def : null, res.type.k === 'prim' ? res.type.name : null);
      return UNIT;
    }
    const s = stripRefinements(this.typeOfExpr(e.object));
    return { k: 'field', object: this.expr(e.object), name: e.name.text, type, owner: s.k === 'record' ? this.t.def(s.def) : null };
  }

  private call(e: A.Call, discard: boolean): IrExpr {
    const res = this.t.refs.get(e.callee.id);
    const type = this.typeOfExpr(e);
    const target = res !== undefined && (res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn') ? this.t.def(res.k === 'def' ? res.def : res.fn) : null;
    if (res !== undefined && target !== null && (target.kind === 'fn' || target.kind === 'iface-fn')) {
      const sig = this.ty.signatures.get(target.id);
      if (sig === undefined) return UNIT;
      let callTarget: IrCallTarget;
      if (res.k === 'iface-fn') callTarget = this.dispatch(res.iface, target, e);
      else if (target.kind === 'iface-fn') {
        const via = this.implFns.get(target.id);
        callTarget = via === undefined ? { k: 'fn', def: target, name: target.name } : { k: 'fn', def: via.def, name: via.name };
      } else callTarget = { k: 'fn', def: target, name: this.emittedName(target) };
      const targs = this.ty.instantiations.get(e.id) ?? [];
      const dicts: IrExpr[] = [];
      const consts: IrExpr[] = [];
      sig.tparams.forEach((p, i) => {
        const a = targs[i];
        if (p.k === 'type' && p.bound !== null) {
          const bound = a !== undefined && a.k === 'type' ? a.type : null;
          dicts.push(bound === null ? UNIT : this.dictFor(p.bound, bound));
        } else if (p.k === 'const') {
          consts.push(a !== undefined && a.k === 'const' ? this.constLiteral(a.value) : UNIT);
        }
      });
      const args = sig.params.map((p) => {
        const a = e.args.find((x) => x.name.text === p.name);
        return a === undefined ? UNIT : this.expr(a.value);
      });
      const call: IrExpr = { k: 'call', target: callTarget, sig, dicts, consts, args, type };
      const inoutParams = sig.params.filter((p) => p.inout);
      if (inoutParams.length === 0) return call;
      return this.inoutCall(call, type, inoutParams.map((p) => e.args.find((a) => a.name.text === p.name)), discard);
    }
    const callee = this.expr(e.callee);
    const ct = stripRefinements(this.typeOfExpr(e.callee));
    if (ct.k !== 'fn') return UNIT;
    const ordered = ct.params.map((p) => e.args.find((a) => a.name.text === p.name));
    const call: IrExpr = { k: 'call-value', callee, fnType: ct, args: ordered.map((a) => (a === undefined ? UNIT : this.expr(a.value))), type };
    const inout = ct.params.map((p, i) => (p.inout ? ordered[i] : undefined)).filter((_, i) => ct.params[i]?.inout === true);
    if (inout.length === 0) return call;
    return this.inoutCall(call, type, inout, discard);
  }

  /** A call with `inout` arguments becomes a statement assigning its results back; the expression is the result temporary. */
  private inoutCall(call: IrExpr, type: Type, args: readonly (A.Arg | undefined)[], discard: boolean): IrExpr {
    const targets = args.map((a) => (a !== undefined && a.value.kind === 'Name' ? { name: a.value.name.text, type: this.typeOfExpr(a.value) } : { name: this.tmp('x'), type: ERROR }));
    const result = discard ? null : { name: this.tmp('r'), type };
    this.pre.push({ k: 'call-inout', result, call, targets });
    return result === null ? UNIT : { k: 'local', name: result.name, type };
  }

  private constLiteral(v: ConstValue): IrExpr {
    if (v.k === 'sym') return { k: 'local', name: this.t.def(v.def).name, type: ERROR };
    return { k: 'const', value: v };
  }

  /** The dictionary implementing `iface` for `target`: a parameter, an impl of some module, or nothing. */
  private dictFor(iface: DefId, target: Type): IrExpr {
    const s = stripRefinements(target);
    if (s.k === 'param') {
      const d = this.fn?.dicts.get(s.def);
      if (d !== undefined) return { k: 'dict-param', name: d };
    }
    const ifaceDef = this.t.def(iface);
    for (const m of this.t.modules) {
      for (const item of m.module.items) {
        if (item.kind !== 'ImplDecl') continue;
        const r = this.t.refs.get(item.id);
        if (r === undefined || r.k !== 'def' || r.def !== iface) continue;
        const targetType = this.targetType(item);
        if (this.typeSlug(targetType) !== this.typeSlug(s)) continue;
        return { k: 'dict', iface: ifaceDef, target: targetType, module: m.id, name: this.implDictName(ifaceDef, targetType) };
      }
    }
    return UNIT;
  }

  private dispatch(iface: DefId, fn: Def, e: A.Call): IrCallTarget {
    const targs = this.ty.instantiations.get(e.id) ?? [];
    const last = targs[targs.length - 1];
    const target = last !== undefined && last.k === 'type' ? last.type : null;
    const inImpl = this.implFns.get(fn.id);
    if (inImpl !== undefined && target !== null && stripRefinements(target).k === 'param') return { k: 'fn', def: inImpl.def, name: inImpl.name };
    if (target === null) return { k: 'dict', dict: UNIT, name: fn.name };
    if (stripRefinements(target).k !== 'param') {
      const resolved = calleeOf(this.ctx, e);
      if (resolved.k === 'impl') {
        const def = this.t.def(resolved.def);
        return { k: 'fn', def, name: this.emittedName(def) };
      }
    }
    return { k: 'dict', dict: this.dictFor(iface, target), name: fn.name };
  }

  private unary(e: A.Unary): IrExpr {
    const v = this.expr(e.operand);
    if (e.op === 'not') return { k: 'not', operand: v };
    const s = stripRefinements(this.typeOfExpr(e.operand));
    if (s.k === 'prim' && (s.name === 'Int' || s.name === 'Duration')) {
      return { k: 'neg', operand: v, float: false, ob: this.obRef('overflow', `-${printExpr(e.operand)} within Int`, e.span, this.fn?.def?.name ?? '?') };
    }
    return { k: 'neg', operand: v, float: true, ob: null };
  }

  private binary(e: A.Binary): IrExpr {
    const left = this.expr(e.left);
    const right = this.expr(e.right);
    const lt = this.typeOfExpr(e.left);
    const s = stripRefinements(lt);
    const isInt = s.k === 'prim' && (s.name === 'Int' || s.name === 'Duration');
    switch (e.op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%': {
        if (isInt) {
          const ob = this.ctx.contracts.find(e.id, 'overflow');
          return { k: 'intop', op: e.op, left, right, ob: ob !== null && ob.status === 'checked' ? this.obRefOf(ob) : null };
        }
        return { k: 'floatop', op: e.op, left, right };
      }
      case '++':
        return { k: 'concat', left, right, text: s.k === 'prim' && s.name === 'Text', type: this.typeOfExpr(e) };
      case '==':
      case '!=':
        return { k: 'eq', left, right, type: lt, prim: s.k === 'prim', negate: e.op === '!=' };
      case '<':
      case '<=':
      case '>':
      case '>=':
        return { k: 'cmp', op: e.op, left, right, float: s.k === 'prim' && s.name === 'Float' };
      case 'implies':
        return { k: 'implies', left, right };
    }
  }

  // -------------------------------------------------------------------------
  // Tests, verify blocks
  // -------------------------------------------------------------------------

  /** An assertion block (§5.2): bare expressions must hold. */
  private assertionBlock(b: A.Block): IrBlock {
    return b.stmts.flatMap((s) => (s.kind === 'ExprStmt' ? this.collect(() => [{ k: 'assert', cond: this.expr(s.expr) }]) : this.stmt(s)));
  }

  private tests(): IrTests | null {
    const examples: IrTests['examples'][number][] = [];
    const properties: IrTests['properties'][number][] = [];
    for (const item of this.m.module.items) {
      if (item.kind === 'ExampleDecl') {
        this.fn = null;
        examples.push({ name: item.name.text, body: this.assertionBlock(item.body) });
      } else if (item.kind === 'PropertyDecl') {
        this.fn = null;
        properties.push({ label: `property ${item.name.text}`, params: this.genParams(item.params, new Map()), body: this.assertionBlock(item.body) });
      } else if (item.kind === 'ImplDecl') {
        const r = this.t.refs.get(item.id);
        if (r === undefined || r.k !== 'def') continue;
        const iface = this.t.def(r.def);
        const target = this.targetType(item);
        const tp = this.t.defs.find((d) => d.kind === 'type-param' && d.node === iface.node);
        const subst = new Map<DefId, TypeArg>();
        if (tp !== undefined) subst.set(tp.id, { k: 'type', type: target });
        const map = new Map<DefId, { def: Def; name: string }>();
        for (const f of item.fns) {
          const fd = this.t.def(this.defOf(f));
          const want = this.t.defs.find((d) => d.parent === iface.id && d.kind === 'iface-fn' && d.name === f.name.text);
          if (want !== undefined) map.set(want.id, { def: fd, name: this.implFnName(fd) });
        }
        for (const law of this.t.defs.filter((d) => d.parent === r.def && d.kind === 'law')) {
          const node = this.t.node(law.node);
          if (node.kind !== 'Law') continue;
          this.implFns = map;
          this.fn = null;
          properties.push({ label: `law ${iface.name}[${this.typeSlug(target)}].${law.name}`, params: this.genParams(node.params, subst), body: this.assertionBlock(node.body) });
          this.implFns = new Map();
        }
      }
    }
    if (examples.length === 0 && properties.length === 0) return null;
    return { examples, properties };
  }

  private genParams(params: readonly A.Param[], subst: Map<DefId, TypeArg>): { name: string; gen: IrGen }[] {
    return params.map((param) => {
      const pd = this.t.defOf.get(param.id);
      const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
      return { name: param.name.text, gen: this.generator(substitute(type ?? ERROR, subst)) };
    });
  }

  /** A generator for `t`, filtered by its refinements. */
  private generator(t: Type): IrGen {
    const it = this.tmp('it');
    const local: IrExpr = { k: 'local', name: it, type: t };
    const filters = this.refinementPreds(t).map((p) => ({ it, cond: this.withIt(local, () => this.expr(p)) }));
    return { base: this.baseGenerator(stripRefinements(t)), filters };
  }

  private baseGenerator(s: Type): IrGenBase {
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Int':
            return { k: 'int' };
          case 'Float':
            return { k: 'float' };
          case 'Duration':
            return { k: 'duration' };
          case 'Bool':
            return { k: 'bool' };
          case 'Text':
            return { k: 'text' };
          case 'Unit':
            return { k: 'unit' };
          default:
            return { k: 'unknown' };
        }
      case 'opaque': {
        const a0 = s.args[0];
        if (this.t.qualifiedName(s.def) === 'std.list.List' && a0 !== undefined && a0.k === 'type') return { k: 'list', elem: this.generator(a0.type) };
        return { k: 'unknown' };
      }
      case 'record':
        return { k: 'record', fields: (this.ty.fields.get(s.def) ?? []).map((f) => ({ name: f.name, gen: this.generator(f.type) })) };
      case 'union':
        return {
          k: 'union',
          variants: (this.ty.variants.get(s.def) ?? []).map((v) => ({ name: this.t.def(v).name, fields: (this.ty.fields.get(v) ?? []).map((f) => ({ name: f.name, gen: this.generator(f.type) })) })),
        };
      default:
        return { k: 'unknown' };
    }
  }

  /** Every `verify` block as a Bool-yielding function (§20.2). */
  private verifies(): IrVerify[] {
    const out: IrVerify[] = [];
    const fns: A.FnDecl[] = [];
    for (const item of this.m.module.items) {
      if (item.kind === 'FnDecl') fns.push(item);
      else if (item.kind === 'ImplDecl') fns.push(...item.fns);
    }
    for (const f of fns) {
      if (f.body === null) continue;
      const sites = this.ctx.claims.assumesOf(this.defOf(f));
      walk(f.body, (n) => {
        if (n.kind === 'VerifyBlock') return false;
        if (n.kind !== 'Assume' || n.verify === null) return true;
        const a = sites.find((x) => x.node === n.id);
        const v = n.verify;
        const vd = this.t.defOf.get(v.id);
        if (a === undefined || vd === undefined) return true;
        const params = v.params.flatMap((p) => {
          const pd = this.t.defOf.get(p.id);
          const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
          const s = type === undefined ? undefined : stripRefinements(type);
          return s !== undefined && s.k === 'capability' ? [{ name: p.name.text, capability: s.def, node: p.id }] : [];
        });
        const pos = lineColOf(this.ctx.fileOf(n.span), n.span.start);
        this.fn = { inout: [], ret: BOOL, ensures: [], def: this.t.def(vd), dicts: new Map(), result: null };
        this.verifying = true;
        const body = this.assertionBlock(v.body);
        this.verifying = false;
        this.fn = null;
        out.push({ name: `verify$${out.length}`, key: a.key, claim: this.t.qualifiedName(a.claim), def: this.t.qualifiedName(a.fn), at: `${this.t.qualifiedName(a.fn)}:${pos.line}:${pos.col}`, params, body, earlyReturn: containsTry(v.body) });
        return true;
      });
    }
    return out;
  }
}

function isUnit(t: Type): boolean {
  const s = stripRefinements(t);
  return s.k === 'prim' && s.name === 'Unit';
}

/** True iff `b` contains a `try` outside any nested closure or verify block. */
export function containsTry(b: A.Block): boolean {
  let found = false;
  walk(b, (n) => {
    if (found) return false;
    if (n.kind === 'Closure' || n.kind === 'VerifyBlock') return false;
    if (n.kind === 'Try') found = true;
    return !found;
  });
  return found;
}
