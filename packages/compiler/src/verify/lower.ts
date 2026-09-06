/**
 * Lowering Onus expressions to formulas (impl spec §7.1).
 *
 * A `Lowerer` accumulates the declarations and axioms a verification
 * condition needs: uninterpreted sorts for non-arithmetic types, projections
 * and tags for records and unions, `len`/`get` for lists, and one
 * uninterpreted function per called function (per generic instantiation),
 * whose `ensures` clauses and return-type refinements are asserted about
 * every application. Expressions of type `Float` are not lowered in v0;
 * `Unlowerable` marks an obligation as `checked`.
 */
import type { Context } from '../context.js';
import type { Mutation } from './vc.js';
import type { Value } from '../consteval/values.js';
import type { Def, DefId, ResolveTables } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { isExpr } from '../syntax/walk.js';
import type { Signature, TypeTables } from '../types/tables.js';
import { stripRefinements, substitute, substituteArg, type ConstValue, type Type, type TypeArg } from '../types/type.js';
import { and, app, BOOL, eq, FALSE, implies, INT, int, not, or, TRUE, variable, type Formula, type Sort } from './formula.js';

export class Unlowerable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Where a name resolves during lowering: an SMT variable, possibly with the value it is known to equal. */
export type Binding = { readonly term: Formula; readonly type: Type };

export type Env = ReadonlyMap<DefId, Binding>;

interface FnDecl {
  readonly args: readonly Sort[];
  readonly ret: Sort;
}

/**
 * Lowers expressions and collects declarations for one verification
 * condition. Not reusable across conditions: declarations are per problem.
 */
/** The SMT-safe spelling of a function name. Effects: none. */
function cleanFnName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.]/g, '_');
}

export class Lowerer {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  readonly sorts = new Set<string>();
  readonly fns = new Map<string, FnDecl>();
  readonly axioms: Formula[] = [];
  /** Axioms of the sorts themselves, true of every value: a list's length is non-negative. Printed with the declarations. */
  readonly sortAxioms: Formula[] = [];
  /** `hasFacts` by type key and remaining depth. */
  private readonly factsMemo = new Map<string, boolean>();
  private readonly textLits = new Map<string, string>();
  private fresh = 0;
  /** Substitutions for contract keywords. */
  it: Formula | null = null;
  result: Formula | null = null;
  /** `old(x)` → the entry value of parameter x. */
  olds = new Map<DefId, Formula>();
  /** Facts learned while lowering (e.g. `try e` implies `e` is Ok). */
  readonly learned: Formula[] = [];
  /**
   * Variables a call changed through an `inout` argument, with the term of their value after the call.
   * The body walker re-binds them (the callee's `ensures` relates that value to `old(param)`, the value passed).
   */
  readonly rebound: { readonly def: DefId; readonly term: Formula }[] = [];
  /** The term each lowered expression node became. */
  readonly terms = new Map<A.NodeId, Formula>();
  /** Per call node: argument bindings by parameter def, parameter types after instantiation, and the instantiation. */
  readonly calls = new Map<A.NodeId, { readonly args: Env; readonly paramTypes: ReadonlyMap<string, Type>; readonly subst: ReadonlyMap<DefId, TypeArg> }>();

  /** Lowers under an instantiation, so that generic calls inside a callee's contracts use the caller's types. */
  withSubst<T>(subst: ReadonlyMap<DefId, TypeArg>, f: () => T): T {
    this.substStack.push(subst);
    try {
      return f();
    } finally {
      this.substStack.pop();
    }
  }
  private typeFactDepth = 0;
  /** Outer instantiations in force while lowering a callee's contracts. */
  private readonly substStack: ReadonlyMap<DefId, TypeArg>[] = [];

  /** Functions whose contracts are being lowered right now (see `calleeFacts`). */
  private readonly expanding = new Set<DefId>();

  constructor(
    private readonly ctx: Context,
    /** A contract weakening whose facts are withheld (§20.4, `onus test --mutate`). */
    private readonly mutation: Mutation | null = null,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
  }

  // -------------------------------------------------------------------------
  // Sorts and names
  // -------------------------------------------------------------------------

  /** The sort of a type; declares an uninterpreted sort when needed. Throws `Unlowerable` for Float. */
  sortOf(t: Type): Sort {
    const s = stripRefinements(t);
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Int':
          case 'Duration':
            return INT;
          case 'Bool':
            return BOOL;
          default:
            return this.namedSort(s.name);
        }
      case 'record':
      case 'union':
      case 'opaque':
      case 'capability':
        return this.namedSort(this.slug(s));
      case 'param':
        return this.namedSort(`T_${this.t.def(s.def).name}_${s.def}`);
      case 'fn':
        return this.namedSort('Fn');
      case 'typeinfo':
      case 'spec':
        return this.namedSort(s.k === 'typeinfo' ? 'TypeInfo' : 'Spec');
      case 'error':
        throw new Unlowerable('an expression of unknown type');
      case 'refined':
        throw new Unlowerable('unreachable');
    }
  }

  private namedSort(name: string): Sort {
    const clean = name.replace(/[^A-Za-z0-9_]/g, '_');
    this.sorts.add(clean);
    return { k: 'sort', name: clean };
  }

  /** A stable, SMT-safe name for a type instantiation. */
  slug(t: Type): string {
    const s = stripRefinements(t);
    switch (s.k) {
      case 'prim':
        return s.name;
      case 'record':
      case 'union':
      case 'opaque':
      case 'capability':
        return `${this.t.qualifiedName(s.def)}${s.args.map((a) => `_${this.argSlug(a)}`).join('')}`;
      case 'param':
        return `T_${this.t.def(s.def).name}_${s.def}`;
      case 'fn':
        return 'Fn';
      case 'typeinfo':
        return 'TypeInfo';
      case 'spec':
        return 'Spec';
      case 'error':
        return 'Error';
      case 'refined':
        return this.slug(s);
    }
  }

  private argSlug(a: TypeArg): string {
    if (a.k === 'type') return this.slug(a.type);
    if (a.k === 'effects') return 'e';
    return this.constSlug(a.value);
  }

  private constSlug(v: ConstValue): string {
    switch (v.k) {
      case 'int':
      case 'duration':
        return v.v.toString();
      case 'float':
        return String(v.v).replace(/[^0-9]/g, '_');
      case 'bool':
        return v.v ? 'true' : 'false';
      case 'text':
        return `t${this.textLitName(v.v).slice(1)}`;
      case 'unit':
        return 'Unit';
      case 'variant':
        return this.t.qualifiedName(v.def);
      case 'sym':
        return `s${v.def}`;
      case 'error':
        return 'err';
    }
  }

  declareFn(name: string, args: readonly Sort[], ret: Sort): string {
    const clean = cleanFnName(name);
    if (!this.fns.has(clean)) this.fns.set(clean, { args, ret });
    return clean;
  }

  /** A fresh constant of the given sort. */
  freshConst(prefix: string, sort: Sort): Formula {
    this.fresh += 1;
    const name = `${prefix}_${this.fresh}`;
    this.declareFn(name, [], sort);
    return variable(name, sort);
  }

  private textLitName(value: string): string {
    const existing = this.textLits.get(value);
    if (existing !== undefined) return existing;
    const name = `text_lit_${this.textLits.size + 1}`;
    this.textLits.set(value, name);
    this.declareFn(name, [], this.namedSort('Text'));
    return name;
  }

  /** Distinct text literals denote distinct values. */
  textDistinctness(): Formula | null {
    const names = [...this.textLits.values()];
    if (names.length < 2) return null;
    const text = this.namedSort('Text');
    return app('distinct', names.map((n) => variable(n, text)), BOOL);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private typeOfExpr(e: A.Expr): Type {
    const t = this.ty.exprTypes.get(e.id);
    if (t === undefined) throw new Unlowerable('an expression without a type');
    return t;
  }

  /**
   * Lowers `e` under `env`. Calls become uninterpreted applications (or
   * fresh constants when effectful) with the callee's contracts as facts.
   * Effects: adds declarations, axioms and learned facts.
   */
  lower(e: A.Expr, env: Env): Formula {
    const term = this.lowerInner(e, env);
    this.terms.set(e.id, term);
    return term;
  }

  /** Applies the outer instantiations to a type mentioned inside a callee's contract. */
  private inContext(t: Type): Type {
    let cur = t;
    for (const s of this.substStack) cur = substitute(cur, s);
    return cur;
  }

  private inContextArg(a: TypeArg): TypeArg {
    let cur = a;
    for (const s of this.substStack) cur = substituteArg(cur, s);
    return cur;
  }

  private lowerInner(e: A.Expr, env: Env): Formula {
    switch (e.kind) {
      case 'IntLit':
        return int(e.value);
      case 'DurationLit':
        return int(e.nanos);
      case 'BoolLit':
        return e.value ? TRUE : FALSE;
      case 'FloatLit':
        // An opaque value: Float arithmetic is not verified in v0 (§3.2), but a literal in a record or call must not sink the obligations around it.
        return this.freshConst('float', this.sortOf({ k: 'prim', name: 'Float' }));
      case 'TextLit':
        return variable(this.textLitName(e.value), this.namedSort('Text'));
      case 'Name':
        return this.nameTerm(e, env);
      case 'It':
        if (this.it === null) throw new Unlowerable('`it` outside a refinement');
        return this.it;
      case 'ResultRef':
        if (this.result === null) throw new Unlowerable('`result` outside an ensures clause');
        return this.result;
      case 'Old': {
        const res = this.t.refs.get(e.id);
        const old = res !== undefined && res.k === 'def' ? this.olds.get(res.def) : undefined;
        if (old === undefined) throw new Unlowerable('`old(...)` without an entry value');
        return old;
      }
      case 'Ctor':
        return this.ctor(e, env);
      case 'RecordUpdate':
        return this.recordUpdate(e, env);
      case 'ListLit':
        return this.listLit(e, env);
      case 'Try': {
        const inner = this.lower(e.expr, env);
        const it = this.typeOfExpr(e.expr);
        const s = stripRefinements(it);
        if (s.k !== 'union') throw new Unlowerable('`try` on a non-union');
        const variants = this.ty.variants.get(s.def) ?? [];
        const ok = variants.find((v) => this.t.def(v).name === 'Ok' || this.t.def(v).name === 'Some');
        if (ok === undefined) throw new Unlowerable('`try` on an unknown union');
        // Execution continues only when the value was Ok/Some.
        this.learned.push(this.isVariant(inner, it, ok));
        return this.projection(inner, it, ok, 'value');
      }
      case 'Quantifier':
        return this.quantifier(e, env);
      case 'FieldAccess':
        return this.fieldAccess(e, env);
      case 'Call':
        return this.call(e, env);
      case 'Unary': {
        const ot = stripRefinements(this.typeOfExpr(e.operand));
        if (e.op === 'neg' && ot.k === 'prim' && ot.name === 'Float') throw new Unlowerable('Float arithmetic is not verified in v0 (§3.2)');
        const v = this.lower(e.operand, env);
        return e.op === 'not' ? not(v) : app('-', [v], INT);
      }
      case 'Binary':
        return this.binary(e, env);
      case 'And':
      case 'Or': {
        // An operand the verifier cannot read (a float comparison) becomes an unknown Bool,
        // so the readable operands still contribute knowledge.
        const parts: Formula[] = [];
        for (const o of e.operands) {
          try {
            parts.push(this.lower(o, env));
          } catch (err) {
            if (!(err instanceof Unlowerable)) throw err;
            parts.push(this.freshConst('unknown', BOOL));
          }
        }
        return e.kind === 'And' ? and(...parts) : or(...parts);
      }
      case 'Is': {
        const v = this.lower(e.expr, env);
        const p = e.pattern;
        if (p.kind === 'WildcardPat' || p.kind === 'BindPat') return TRUE;
        if (p.kind === 'LitPat') return eq(v, this.lower(p.literal, env));
        const res = this.t.refs.get(p.id);
        if (res === undefined || res.k !== 'def') throw new Unlowerable('unresolved pattern');
        // The subject's type is instantiated for the current call context: a generic callee's
        // `ensures result is None` must test the caller's `Option[Cmd]`, not `Option[T]`.
        return this.isVariant(v, this.inContext(this.typeOfExpr(e.expr)), res.def);
      }
      case 'Recover':
      case 'Closure':
      case 'Fake':
      case 'Hole':
        return this.freshConst('opaque', this.sortOf(this.typeOfExpr(e)));
    }
  }

  private nameTerm(e: A.Name, env: Env): Formula {
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') throw new Unlowerable(`\`${e.name.text}\` is unresolved`);
    const def = this.t.def(res.def);
    const bound = env.get(def.id);
    if (bound !== undefined) return bound.term;
    if (def.kind === 'const') {
      const v = this.ctx.consteval.constValues.get(def.id);
      if (v !== undefined) return this.constTerm(v, this.ty.declTypes.get(def.id) ?? { k: 'error' });
    }
    if (def.kind === 'fn') return this.freshConst(`fn_${def.name}`, this.namedSort('Fn'));
    throw new Unlowerable(`\`${def.name}\` is not in the verifier's scope`);
  }

  /** A constant value as a term. */
  constTerm(v: Value, type: Type): Formula {
    switch (v.k) {
      case 'int':
      case 'duration':
        return int(BigInt(v.v));
      case 'bool':
        return v.v ? TRUE : FALSE;
      case 'text':
        return variable(this.textLitName(v.v), this.namedSort('Text'));
      default:
        return this.freshConst('const', this.sortOf(type));
    }
  }

  /** A type index as a term, for instantiated const parameters. */
  constArgTerm(v: ConstValue, env: Env): Formula {
    switch (v.k) {
      case 'int':
      case 'duration':
        return int(v.v);
      case 'bool':
        return v.v ? TRUE : FALSE;
      case 'text':
        return variable(this.textLitName(v.v), this.namedSort('Text'));
      case 'sym': {
        const b = env.get(v.def);
        if (b !== undefined) return b.term;
        throw new Unlowerable('a type index outside the verifier\'s scope');
      }
      case 'variant': {
        // A constant variant of a non-generic union: a value of the union's sort carrying its tag.
        const parent = this.t.def(v.def).parent;
        if (parent === null || (this.ty.typeParams.get(parent) ?? []).length > 0) throw new Unlowerable('a variant index of a generic union');
        const type: Type = { k: 'union', def: parent, args: [] };
        const term = this.freshConst(`variant_${this.t.def(v.def).name}`, this.sortOf(type));
        this.axioms.push(this.isVariant(term, type, v.def));
        return term;
      }
      default:
        throw new Unlowerable('an index that is not a value');
    }
  }

  // -------------------------------------------------------------------------
  // Records, unions, lists
  // -------------------------------------------------------------------------

  /** The projection `f` of `term` of record/variant `owner` (a record def or a variant def). */
  projectionOf(term: Formula, type: Type, owner: DefId, field: string, fieldType: Type): Formula {
    const name = this.declareFn(`${this.slug(type)}.${this.t.def(owner).name}.${field}`, [this.sortOf(type)], this.sortOf(fieldType));
    this.projections.add(name);
    return app(name, [term], this.sortOf(fieldType));
  }

  /** Functions whose first argument is the container of their result: field projections and list element reads (§5.1, structural measures). */
  readonly projections = new Set<string>();

  /** What a bound name stands for: the walker binds every name to a fresh constant equal to its value. */
  readonly aliases = new Map<string, Formula>();

  private resolveAlias(term: Formula): Formula {
    let cur = term;
    for (let i = 0; i < 64 && cur.k === 'var'; i += 1) {
      const next = this.aliases.get(cur.name);
      if (next === undefined) return cur;
      cur = next;
    }
    return cur;
  }

  /** Whether `term` is `whole` itself, through aliases: a measure passed on unchanged (§5.1). Effects: none. */
  isSamePart(term: Formula, whole: Formula): boolean {
    return formulaEquals(this.resolveAlias(term), this.resolveAlias(whole));
  }

  /** Whether `term` is a proper part of `whole`: a chain of one or more projections or element reads from it. Effects: none. */
  isProperPart(term: Formula, whole: Formula): boolean {
    const target = this.resolveAlias(whole);
    let cur = this.resolveAlias(term);
    let steps = 0;
    for (;;) {
      if (steps > 0 && (formulaEquals(cur, target) || formulaEquals(cur, whole))) return true;
      if (cur.k !== 'app' || !this.projections.has(cur.fn)) return false;
      const inner = cur.args[0];
      if (inner === undefined) return false;
      cur = this.resolveAlias(inner);
      steps += 1;
    }
  }

  private substOfType(type: Type): Map<DefId, TypeArg> {
    const s = stripRefinements(type);
    const subst = new Map<DefId, TypeArg>();
    if (s.k !== 'record' && s.k !== 'union' && s.k !== 'opaque') return subst;
    (this.ty.typeParams.get(s.def) ?? []).forEach((p, i) => {
      const a = s.args[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    return subst;
  }

  private projection(term: Formula, type: Type, owner: DefId, field: string): Formula {
    const f = (this.ty.fields.get(owner) ?? []).find((x) => x.name === field);
    if (f === undefined) throw new Unlowerable(`no field ${field}`);
    return this.projectionOf(term, type, owner, field, substitute(f.type, this.substOfType(type)));
  }

  /** `tag(term) == index of variant`. */
  isVariant(term: Formula, type: Type, variant: DefId): Formula {
    const s = stripRefinements(type);
    if (s.k !== 'union') throw new Unlowerable('variant test on a non-union');
    const variants = this.ty.variants.get(s.def) ?? [];
    const index = variants.indexOf(variant);
    if (index < 0) throw new Unlowerable('variant of another union');
    const tag = this.declareFn(`${this.slug(type)}.tag`, [this.sortOf(type)], INT);
    return eq(app(tag, [term], INT), int(index));
  }

  private ctor(e: A.Ctor, env: Env): Formula {
    const res = this.t.refs.get(e.id);
    if (res === undefined) throw new Unlowerable('unresolved constructor');
    const type = this.typeOfExpr(e);
    if (res.k === 'unit') return this.freshConst('unit', this.sortOf(type));
    if (res.k === 'type-value') return this.freshConst('typeinfo', this.sortOf(type));
    if (res.k !== 'def') throw new Unlowerable('unresolved constructor');
    const def = this.t.def(res.def);
    const inits = [...(e.args ?? []).map((a) => ({ name: a.name.text, value: a.value })), ...(e.fields ?? []).map((f) => ({ name: f.name.text, value: f.value }))];
    const term = this.freshConst(def.kind === 'variant' ? `v_${def.name}` : `r_${def.name}`, this.sortOf(type));
    if (def.kind === 'variant') this.axioms.push(this.isVariant(term, type, def.id));
    for (const i of inits) {
      const value = this.lower(i.value, env);
      this.axioms.push(eq(this.projection(term, type, def.id, i.name), value));
    }
    return term;
  }

  private recordUpdate(e: A.RecordUpdate, env: Env): Formula {
    const type = this.typeOfExpr(e);
    const s = stripRefinements(type);
    if (s.k !== 'record') throw new Unlowerable('`with` on a non-record');
    const base = this.lower(e.base, env);
    const term = this.freshConst(`r_${this.t.def(s.def).name}`, this.sortOf(type));
    const updated = new Map(e.fields.map((f) => [f.name.text, this.lower(f.value, env)] as const));
    for (const f of this.ty.fields.get(s.def) ?? []) {
      const value = updated.get(f.name) ?? this.projection(base, type, s.def, f.name);
      this.axioms.push(eq(this.projection(term, type, s.def, f.name), value));
    }
    return term;
  }

  private listFns(type: Type): { len: string; get: string; elem: Type } {
    const s = stripRefinements(type);
    const a0 = s.k === 'opaque' ? s.args[0] : undefined;
    if (s.k !== 'opaque' || a0 === undefined || a0.k !== 'type' || this.t.qualifiedName(s.def) !== 'std.list.List') throw new Unlowerable('not a list');
    const sort = this.sortOf(type);
    const lenName = `${this.slug(type)}.len`;
    const first = !this.fns.has(cleanFnName(lenName));
    const len = this.declareFn(lenName, [sort], INT);
    // Every list's length is non-negative: an axiom of the sort, stated once, rather than a fact of each list term.
    if (first) this.sortAxioms.push({ k: 'quant', quant: 'forall', vars: [{ name: 'xs', sort }], body: app('>=', [app(len, [variable('xs', sort)], INT), int(0)], BOOL) });
    const get = this.declareFn(`${this.slug(type)}.get`, [sort, INT], this.sortOf(a0.type));
    return { len, get, elem: a0.type };
  }

  listLen(term: Formula, type: Type): Formula {
    return app(this.listFns(type).len, [term], INT);
  }

  listGet(term: Formula, type: Type, index: Formula): Formula {
    const { get, elem } = this.listFns(type);
    this.projections.add(get);
    return app(get, [term, index], this.sortOf(elem));
  }

  private listLit(e: A.ListLit, env: Env): Formula {
    const type = this.typeOfExpr(e);
    const term = this.freshConst('list', this.sortOf(type));
    this.axioms.push(eq(this.listLen(term, type), int(e.elems.length)));
    e.elems.forEach((x, i) => this.axioms.push(eq(this.listGet(term, type, int(i)), this.lower(x, env))));
    return term;
  }

  private fieldAccess(e: A.FieldAccess, env: Env): Formula {
    const res = this.t.refs.get(e.id);
    if (res !== undefined) {
      if (res.k === 'def') {
        const def = this.t.def(res.def);
        if (def.kind === 'const') {
          const v = this.ctx.consteval.constValues.get(def.id);
          if (v !== undefined) return this.constTerm(v, this.ty.declTypes.get(def.id) ?? { k: 'error' });
        }
      }
      return this.freshConst('member', this.sortOf(this.typeOfExpr(e)));
    }
    const obj = this.lower(e.object, env);
    const ot = this.typeOfExpr(e.object);
    const s = stripRefinements(ot);
    if (s.k !== 'record') throw new Unlowerable('field access on a non-record');
    return this.projection(obj, ot, s.def, e.name.text);
  }

  private quantifier(e: A.Quantifier, env: Env): Formula {
    const binderDef = this.t.defOf.get(e.id);
    const binderType = binderDef === undefined ? undefined : this.ty.declTypes.get(binderDef);
    if (binderDef === undefined || binderType === undefined) throw new Unlowerable('unresolved binder');
    this.fresh += 1;
    const name = `q_${this.t.def(binderDef).name}_${this.fresh}`;
    let domain: Formula;
    let bodyEnv: Map<DefId, Binding>;
    const sort = this.sortOf(binderType);
    if (e.domain === null) {
      const s = stripRefinements(binderType);
      if (s.k === 'prim' && s.name === 'Bool') {
        const t = this.lower(e.body, new Map([...env, [binderDef, { term: TRUE, type: binderType }]]));
        const f = this.lower(e.body, new Map([...env, [binderDef, { term: FALSE, type: binderType }]]));
        return e.quant === 'forall' ? and(t, f) : or(t, f);
      }
      throw new Unlowerable('quantification over a finite union is not lowered in v0');
    }
    const x = variable(name, sort);
    bodyEnv = new Map([...env, [binderDef, { term: x, type: binderType }]]);
    const axiomsBefore = this.axioms.length;
    if (e.domain.kind === 'RangeDomain') {
      domain = and(app('<=', [this.lower(e.domain.lo, env), x], BOOL), app('<', [x, this.lower(e.domain.hi, env)], BOOL));
    } else {
      const dt = this.typeOfExpr(e.domain.expr);
      let list = this.lower(e.domain.expr, env);
      let listType = dt;
      let guard: Formula = TRUE;
      const s = stripRefinements(dt);
      if (s.k === 'union') {
        // Result[List[T], E] / Option[List[T]]: quantify over the Ok/Some payload.
        const variants = this.ty.variants.get(s.def) ?? [];
        const ok = variants.find((v) => this.t.def(v).name === 'Ok' || this.t.def(v).name === 'Some');
        if (ok === undefined) throw new Unlowerable('quantifier over an unknown union');
        guard = this.isVariant(list, dt, ok);
        const payload = (this.ty.fields.get(ok) ?? []).find((f) => f.name === 'value');
        if (payload === undefined) throw new Unlowerable('malformed Ok');
        listType = substitute(payload.type, this.substOfType(dt));
        list = this.projection(list, dt, ok, 'value');
      }
      const idx = variable(`${name}_i`, INT);
      const inRange = and(app('<=', [int(0), idx], BOOL), app('<', [idx, this.listLen(list, listType)], BOOL));
      const elem = this.listGet(list, listType, idx);
      bodyEnv = new Map([...env, [binderDef, { term: elem, type: binderType }]]);
      const scoped = this.axioms.length;
      const where = e.where === null ? TRUE : this.lower(e.where, bodyEnv);
      const body = this.lower(e.body, bodyEnv);
      // Facts produced under the binder (callee contracts, constructor definitions) stay under it.
      const under = this.axioms.splice(scoped);
      const inner = e.quant === 'forall' ? implies(and(inRange, where, ...under), body) : and(inRange, where, ...under, body);
      const q: Formula = { k: 'quant', quant: e.quant, vars: [{ name: `${name}_i`, sort: INT }], body: inner };
      return e.quant === 'forall' ? implies(guard, q) : and(guard, q);
    }
    const scoped = this.axioms.length;
    const where = e.where === null ? TRUE : this.lower(e.where, bodyEnv);
    const body = this.lower(e.body, bodyEnv);
    const under = this.axioms.splice(scoped);
    void axiomsBefore;
    const inner = e.quant === 'forall' ? implies(and(domain, where, ...under), body) : and(domain, where, ...under, body);
    return { k: 'quant', quant: e.quant, vars: [{ name, sort }], body: inner };
  }

  private binary(e: A.Binary, env: Env): Formula {
    const lt = stripRefinements(this.typeOfExpr(e.left));
    if (lt.k === 'prim' && lt.name === 'Float' && e.op !== '==' && e.op !== '!=') throw new Unlowerable('Float arithmetic is not verified in v0 (§3.2)');
    const l = this.lower(e.left, env);
    const r = this.lower(e.right, env);
    switch (e.op) {
      case '+':
      case '-':
      case '*':
        return app(e.op, [l, r], INT);
      case '/':
        return app('div', [l, r], INT);
      case '%':
        return app('mod', [l, r], INT);
      case '++': {
        const sort = this.sortOf(this.typeOfExpr(e));
        if (lt.k === 'prim' && lt.name === 'Text') return app(this.declareFn('Text.concat', [sort, sort], sort), [l, r], sort);
        const type = this.typeOfExpr(e);
        const term = this.freshConst('concat', sort);
        this.axioms.push(eq(this.listLen(term, type), app('+', [this.listLen(l, type), this.listLen(r, type)], INT)));
        return term;
      }
      case '==':
        return eq(l, r);
      case '!=':
        return not(eq(l, r));
      case '<':
      case '<=':
      case '>':
      case '>=':
        return app(e.op, [l, r], BOOL);
      case 'implies':
        return implies(l, r);
    }
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private call(e: A.Call, env: Env): Formula {
    const res = this.t.refs.get(e.callee.id);
    const retType = this.typeOfExpr(e);
    if (res === undefined || !(res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn')) {
      return this.opaqueResult(retType, 'call');
    }
    const fnDef = this.t.def(res.k === 'def' ? res.def : res.fn);
    const sig = this.ty.signatures.get(fnDef.id);
    if (sig === undefined || (fnDef.kind !== 'fn' && fnDef.kind !== 'iface-fn')) return this.opaqueResult(retType, 'call');
    const targs = (this.ty.instantiations.get(e.id) ?? []).map((a) => this.inContextArg(a));
    const subst = new Map<DefId, TypeArg>();
    sig.tparams.forEach((p, i) => {
      const a = targs[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    if (res.k === 'iface-fn') {
      // The checker appends the interface's type parameter to an interface call's instantiation (docs/CHANGES.md item 177).
      const ifaceDef = this.t.def(res.iface);
      const ip = this.t.defs.find((x) => x.kind === 'type-param' && x.node === ifaceDef.node);
      const last = targs[sig.tparams.length];
      if (ip !== undefined && last !== undefined) subst.set(ip.id, last);
    }
    // Value parameters used as indices in the callee's types denote the constants passed for them.
    for (const [pd, a] of this.ty.indexBindings.get(e.id) ?? []) subst.set(pd, this.inContextArg(a));
    // Arguments, by parameter.
    const argTerms = new Map<DefId, Binding>();
    const ordered: Formula[] = [];
    const sorts: Sort[] = [];
    for (const p of sig.tparams) {
      if (p.k !== 'const') continue;
      const a = subst.get(p.def);
      if (a === undefined || a.k !== 'const') throw new Unlowerable('an uninstantiated index');
      const term = this.constArgTerm(a.value, env);
      argTerms.set(p.def, { term, type: this.inContext(p.type) });
      ordered.push(term);
      sorts.push(this.sortOf(this.inContext(p.type)));
    }
    // The values the callee sees on exit: an `inout` parameter's is a fresh value of its type, distinct from
    // the one passed, so that an `ensures` relating the two (`built(b) == built(old(b)) + 1`) is a fact about
    // the change and not a contradiction.
    const postTerms = new Map<DefId, Binding>(argTerms);
    sig.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      const a = e.args.find((x) => x.name.text === p.name);
      if (pd === undefined || a === undefined) throw new Unlowerable(`missing argument ${p.name}`);
      const type = this.inContext(substitute(p.type, subst));
      let term: Formula;
      try {
        term = this.lower(a.value, env);
      } catch (err) {
        if (!(err instanceof Unlowerable)) throw err;
        // An argument the verifier cannot read (a float expression) is an arbitrary value of its type.
        term = this.freshConst(`arg_${p.name}`, this.sortOf(type));
        this.terms.set(a.value.id, term);
      }
      argTerms.set(pd, { term, type });
      ordered.push(term);
      sorts.push(this.sortOf(type));
      if (!p.inout) {
        postTerms.set(pd, { term, type });
        return;
      }
      const post = this.freshConst(`post_${p.name}`, this.sortOf(type));
      postTerms.set(pd, { term: post, type });
      const target = a.value.kind === 'Name' ? this.t.refs.get(a.value.id) : undefined;
      if (target !== undefined && target.k === 'def') this.rebound.push({ def: target.def, term: post });
    });
    for (const [pd, b] of postTerms) if (argTerms.get(pd)?.term !== b.term) this.typeFacts(b.term, b.type, postTerms);
    const ret = this.inContext(substitute(sig.ret, subst));
    const paramTypes = new Map<string, Type>();
    sig.params.forEach((p) => paramTypes.set(p.name, this.inContext(substitute(p.type, subst))));
    this.calls.set(e.id, { args: argTerms, paramTypes, subst });
    const pure = sig.effects.values().every((x) => x.k === 'prim' && x.name === 'alloc');
    let result: Formula;
    const q = this.t.qualifiedName(fnDef.id);
    const xsParam = sig.paramDefs[sig.params.findIndex((p) => p.name === 'xs')];
    const iParam = sig.paramDefs[sig.params.findIndex((p) => p.name === 'i')];
    const xsArg = xsParam === undefined ? undefined : argTerms.get(xsParam);
    const iArg = iParam === undefined ? undefined : argTerms.get(iParam);
    if (q === 'std.list.get' && xsArg !== undefined && iArg !== undefined) {
      // An element read is the list's projection (§5.1 structural measures; the same function the loops use).
      result = this.listGet(xsArg.term, xsArg.type, iArg.term);
    } else if (q === 'std.list.len' && xsArg !== undefined) {
      result = this.listLen(xsArg.term, xsArg.type);
    } else if (pure && !hasInout(sig)) {
      // One uninterpreted function per instantiation, named by its sorts so that instantiations never clash.
      const retSort = this.sortOf(ret);
      const name = this.declareFn(`${this.t.qualifiedName(fnDef.id)}[${[...sorts, retSort].map((s) => (s.k === 'sort' ? s.name : s.k)).join(',')}]`, sorts, retSort);
      result = app(name, ordered, retSort);
    } else {
      result = this.freshConst(`call_${fnDef.name}`, this.sortOf(ret));
    }
    this.substStack.push(subst);
    try {
      this.calleeFacts(fnDef, sig, postTerms, argTerms, result, ret);
    } finally {
      this.substStack.pop();
    }
    return result;
  }

  private opaqueResult(type: Type, prefix: string): Formula {
    const term = this.freshConst(prefix, this.sortOf(type));
    this.typeFacts(term, type);
    return term;
  }

  /**
   * The callee's ensures clauses and return refinements, instantiated for this application: `args` binds
   * each parameter to its value on exit, `pre` to the value passed (what `old(param)` denotes).
   */
  private calleeFacts(fnDef: Def, sig: Signature, args: Map<DefId, Binding>, pre: Map<DefId, Binding>, result: Formula, ret: Type): void {
    const m = this.mutation;
    this.typeFacts(result, m !== null && m.k === 'widen-return' && m.fn === fnDef.id ? stripRefinements(ret) : ret, args);
    // A contract that calls its own function (`ensures compare(a, a) == 0`) is stated once, not unfolded forever.
    if (this.expanding.has(fnDef.id)) return;
    this.expanding.add(fnDef.id);
    try {
      this.calleeContracts(fnDef, sig, args, pre, result);
    } finally {
      this.expanding.delete(fnDef.id);
    }
  }

  private calleeContracts(fnDef: Def, sig: Signature, args: Map<DefId, Binding>, pre: Map<DefId, Binding>, result: Formula): void {
    const m = this.mutation;
    const savedResult = this.result;
    const savedOlds = this.olds;
    this.result = result;
    this.olds = new Map([...pre].filter(([d]) => this.t.def(d).kind === 'param').map(([d, b]) => [d, b.term] as const));
    try {
      for (const c of sig.contracts) {
        if (c.clause !== 'ensures') continue;
        if (m !== null && m.k === 'drop-ensures' && m.fn === fnDef.id && m.clause === c.id) continue;
        try {
          this.axioms.push(this.lower(c.expr, args));
        } catch (err) {
          if (!(err instanceof Unlowerable)) throw err;
          // An ensures clause the verifier cannot read gives no fact.
        }
      }
    } finally {
      this.result = savedResult;
      this.olds = savedOlds;
    }
    void fnDef;
  }

  // -------------------------------------------------------------------------
  // Type-derived facts
  // -------------------------------------------------------------------------

  /**
   * Facts a well-typed value of `type` satisfies: its refinements, recursively
   * through fields and elements. `env` resolves the names a refinement may
   * mention (earlier parameters, §3.2); sibling fields are added for records
   * and variants (§3.3).
   */
  typeFacts(term: Formula, type: Type, env: Env = new Map()): void {
    if (this.typeFactDepth > 3) return;
    // Nothing to assert within reach: the walk through fields and elements is skipped, not merely fruitless.
    if (!this.hasFacts(type, 3 - this.typeFactDepth)) return;
    this.typeFactDepth += 1;
    try {
      let cur = type;
      while (cur.k === 'refined') {
        const pred = this.t.node(cur.pred);
        if (isExpr(pred)) {
          const savedIt = this.it;
          this.it = term;
          try {
            this.axioms.push(this.lower(pred, env));
          } catch (err) {
            if (!(err instanceof Unlowerable)) throw err;
          } finally {
            this.it = savedIt;
          }
        }
        cur = cur.base;
      }
      const s = cur;
      if (s.k === 'record') {
        const subst = this.substOfType(s);
        const wf = this.mutation !== null && this.mutation.k === 'widen-field' && this.mutation.record === s.def ? this.mutation.field : null;
        const fields = (this.ty.fields.get(s.def) ?? []).map((f) => ({ f, ft: f.name === wf ? stripRefinements(substitute(f.type, subst)) : substitute(f.type, subst) }));
        const siblings = new Map<DefId, Binding>(env);
        for (const { f, ft } of fields) siblings.set(f.def, { term: this.projectionOf(term, s, s.def, f.name, ft), type: ft });
        for (const { f, ft } of fields) {
          const fs = stripRefinements(ft);
          if (fs.k === 'prim' && fs.name === 'Float') continue;
          try {
            this.typeFacts(this.projectionOf(term, s, s.def, f.name, ft), ft, siblings);
          } catch (err) {
            if (!(err instanceof Unlowerable)) throw err;
          }
        }
      } else if (s.k === 'union') {
        const subst = this.substOfType(s);
        for (const v of this.ty.variants.get(s.def) ?? []) {
          const fields = (this.ty.fields.get(v) ?? []).map((f) => ({ f, ft: substitute(f.type, subst) }));
          const siblings = new Map<DefId, Binding>(env);
          for (const { f, ft } of fields) siblings.set(f.def, { term: this.projectionOf(term, s, v, f.name, ft), type: ft });
          for (const { f, ft } of fields) {
            try {
              const guard = this.isVariant(term, s, v);
              const before = this.axioms.length;
              this.typeFacts(this.projectionOf(term, s, v, f.name, ft), ft, siblings);
              const added = this.axioms.splice(before);
              for (const a of added) this.axioms.push(implies(guard, a));
            } catch (err) {
              if (!(err instanceof Unlowerable)) throw err;
            }
          }
        }
      } else if (s.k === 'opaque' && this.t.qualifiedName(s.def) === 'std.list.List') {
        const a0 = s.args[0];
        if (a0 === undefined || a0.k !== 'type') return;
        try {
          const len = this.listLen(term, s);
          this.fresh += 1;
          const idx = variable(`tf_i_${this.fresh}`, INT);
          const before = this.axioms.length;
          this.typeFacts(this.listGet(term, s, idx), a0.type);
          const added = this.axioms.splice(before);
          if (added.length > 0) {
            const inRange = and(app('<=', [int(0), idx], BOOL), app('<', [idx, len], BOOL));
            this.axioms.push({ k: 'quant', quant: 'forall', vars: [{ name: idx.k === 'var' ? idx.name : 'i', sort: INT }], body: implies(inRange, and(...added)) });
          }
        } catch (err) {
          if (!(err instanceof Unlowerable)) throw err;
        }
      }
    } finally {
      this.typeFactDepth -= 1;
    }
  }

  /**
   * Whether `typeFacts` on a value of `type` would assert anything within
   * `remaining` further levels: a refinement on the type itself, or one
   * reachable through record fields, variant fields and list elements. A
   * list's length bound is a sort axiom (`listFns`) and counts for nothing.
   * Memoised by type and depth. Effects: the memo only.
   */
  private hasFacts(type: Type, remaining: number): boolean {
    if (type.k === 'refined') return true;
    if (remaining <= 0) return false;
    const key = `${this.typeKey(type)}@${remaining}`;
    const known = this.factsMemo.get(key);
    if (known !== undefined) return known;
    let out = false;
    if (type.k === 'record') {
      const subst = this.substOfType(type);
      for (const f of this.ty.fields.get(type.def) ?? []) {
        const ft = substitute(f.type, subst);
        const fs = stripRefinements(ft);
        if (fs.k === 'prim' && fs.name === 'Float') continue;
        if (this.hasFacts(ft, remaining - 1)) out = true;
      }
    } else if (type.k === 'union') {
      const subst = this.substOfType(type);
      for (const v of this.ty.variants.get(type.def) ?? []) for (const f of this.ty.fields.get(v) ?? []) if (this.hasFacts(substitute(f.type, subst), remaining - 1)) out = true;
    } else if (type.k === 'opaque' && this.t.qualifiedName(type.def) === 'std.list.List') {
      const a0 = type.args[0];
      if (a0 !== undefined && a0.k === 'type') out = this.hasFacts(a0.type, remaining - 1);
    }
    this.factsMemo.set(key, out);
    return out;
  }

  /** A key identifying a type up to its refinements, for `hasFacts`. Effects: none. */
  private typeKey(t: Type): string {
    switch (t.k) {
      case 'prim':
        return t.name;
      case 'refined':
        return `${this.typeKey(t.base)}?${t.pred}`;
      case 'record':
      case 'union':
      case 'opaque':
      case 'capability':
        return `${t.def}[${t.args.map((a) => this.argKey(a)).join(',')}]`;
      case 'param':
        return `P${t.def}`;
      case 'fn':
      case 'typeinfo':
      case 'spec':
      case 'error':
        return t.k;
    }
  }

  private argKey(a: TypeArg): string {
    if (a.k === 'type') return this.typeKey(a.type);
    if (a.k === 'effects') return 'e';
    const v = a.value;
    switch (v.k) {
      case 'int':
      case 'duration':
        return v.v.toString();
      case 'float':
        return String(v.v);
      case 'bool':
        return v.v ? 'true' : 'false';
      case 'text':
        return `t:${v.v}`;
      case 'unit':
        return 'Unit';
      case 'variant':
        return `v${v.def}`;
      case 'sym':
        return `s${v.def}`;
      case 'error':
        return 'err';
    }
  }
}

function hasInout(sig: Signature): boolean {
  return sig.params.some((p) => p.inout);
}

/** Structural equality of formulas. Effects: none. */
export function formulaEquals(a: Formula, b: Formula): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'int':
      return b.k === 'int' && a.v === b.v;
    case 'bool':
      return b.k === 'bool' && a.v === b.v;
    case 'var':
      return b.k === 'var' && a.name === b.name;
    case 'app':
      return b.k === 'app' && a.fn === b.fn && a.args.length === b.args.length && a.args.every((x, i) => formulaEquals(x, b.args[i] ?? x));
    case 'ite':
      return b.k === 'ite' && formulaEquals(a.cond, b.cond) && formulaEquals(a.then, b.then) && formulaEquals(a.else, b.else);
    case 'quant':
      return false;
  }
}
