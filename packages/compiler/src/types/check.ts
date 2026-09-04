/**
 * The types pass (impl spec §4, pass 4; language spec §3–§5, §10.1).
 *
 * Elaborates every signature and declaration into `Type`s, then checks every
 * body bidirectionally: an expression is checked against an expected type
 * where one is known (a `let` annotation, a parameter, a return type) and
 * inferred otherwise. Only base types are compared here; a flow into a
 * refined position is recorded as an obligation site for later milestones.
 *
 * Generic instantiation takes type arguments from an explicit `[...]` list,
 * then from the expected type, then from the arguments. A type parameter
 * that stays unbound is an error: nothing is inferred onto a declaration.
 */
import { evalBasic } from '../consteval/basic.js';
import type { Context } from '../context.js';
import { EffectSet, type Effect } from '../effects/set.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Def, DefId, ModuleRecord, ResolveTables } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { coverage, type ArmShape, type Scrutinee } from './exhaustive.js';
import type { FieldInfo, Signature, TParamInfo, TypeTables } from './tables.js';
import {
  assignable,
  BOOL,
  constEquals,
  DURATION,
  ERROR,
  FLOAT,
  INT,
  isRefined,
  prim,
  sameBase,
  stripRefinements,
  substitute,
  TEXT,
  TYPEINFO,
  typeToString,
  UNIT,
  type ConstValue,
  type FnParam,
  type Restriction,
  type Type,
  type TypeArg,
} from './type.js';

interface FnCtx {
  /** Return type; null in assertion blocks (example, property, law) and recover blocks. */
  readonly ret: Type | null;
  readonly assertion: boolean;
  readonly recover: boolean;
  readonly frame: number;
  /** A `verify` block (§20.2): assertions yield its Bool, and `try ... else` yields the else value. */
  readonly verify?: boolean;
}

type Subst = Map<DefId, TypeArg>;

/**
 * Pass 4: elaborate signatures and check every body.
 * Preconditions: `resolvePass` has run without diagnostics.
 * Effects: writes `ctx.types`; reports E0310 and E0321–E0341, E0111, E0330.
 */
export function typesPass(ctx: Context): void {
  new Checker(ctx).run();
}

class Checker {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private currentDef: string | null = null;
  private currentModule: ModuleRecord | null = null;
  private readonly itStack: Type[] = [];
  private readonly fnStack: FnCtx[] = [];
  private readonly typeMemo = new Map<A.NodeId, Type>();
  private readonly constMemo = new Map<DefId, ConstValue | null>();
  private readonly busy = new Set<DefId>();
  /** Implementations per interface. */
  private readonly impls = new Map<DefId, { target: Type; node: A.ImplDecl }[]>();

  constructor(private readonly ctx: Context) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
  }

  // -------------------------------------------------------------------------
  // Driver
  // -------------------------------------------------------------------------

  run(): void {
    for (const m of this.t.modules) {
      this.currentModule = m;
      for (const item of m.module.items) this.elaborateItem(item);
    }
    for (const m of this.t.modules) {
      this.currentModule = m;
      for (const item of m.module.items) {
        this.currentDef = 'name' in item ? item.name.text : item.iface.text;
        this.checkItem(item);
        this.currentDef = null;
      }
    }
  }

  private report(code: Code, span: Span, detail: string): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail] }));
  }

  private show(t: Type): string {
    return typeToString(t, this.t);
  }

  private defOf(node: A.NodeBase): DefId {
    const d = this.t.defOf.get(node.id);
    if (d === undefined) throw new Error(`no definition for node ${node.id}`);
    return d;
  }

  private nodeOf<K extends A.Node['kind']>(def: Def, kind: K): Extract<A.Node, { kind: K }> {
    const n = this.t.node(def.node);
    if (n.kind !== kind) throw new Error(`definition ${def.name} is a ${n.kind}, expected ${kind}`);
    return n as Extract<A.Node, { kind: K }>;
  }

  private get fn(): FnCtx | null {
    return this.fnStack[this.fnStack.length - 1] ?? null;
  }

  private inFn<T>(f: FnCtx, body: () => T): T {
    this.fnStack.push(f);
    try {
      return body();
    } finally {
      this.fnStack.pop();
    }
  }

  // -------------------------------------------------------------------------
  // Standard library types
  // -------------------------------------------------------------------------

  private stdType(moduleName: string, typeName: string): DefId | null {
    const m = this.t.byName.get(moduleName);
    if (m === undefined) return null;
    return this.t.membersOf(m).types.get(typeName) ?? null;
  }

  private listOf(elem: Type): Type {
    const def = this.stdType('std.list', 'List');
    return def === null ? ERROR : { k: 'opaque', def, args: [{ k: 'type', type: elem }] };
  }

  private resultOf(value: Type, error: Type): Type {
    const def = this.stdType('std.results', 'Result');
    return def === null ? ERROR : { k: 'union', def, args: [{ k: 'type', type: value }, { k: 'type', type: error }] };
  }

  private panickedType(): Type {
    const def = this.stdType('std.results', 'Panicked');
    return def === null ? ERROR : { k: 'record', def, args: [] };
  }

  /** `Result[T, E]` → [T, E]; `Option[T]` → [T, Unit]; else null. */
  private unwrapFallible(t: Type): { value: Type; error: Type; option: boolean } | null {
    const s = stripRefinements(t);
    if (s.k !== 'union') return null;
    const a0 = s.args[0];
    const a1 = s.args[1];
    if (s.def === this.stdType('std.results', 'Result') && a0?.k === 'type' && a1?.k === 'type') return { value: a0.type, error: a1.type, option: false };
    if (s.def === this.stdType('std.option', 'Option') && a0?.k === 'type') return { value: a0.type, error: UNIT, option: true };
    return null;
  }

  // -------------------------------------------------------------------------
  // Elaboration: types
  // -------------------------------------------------------------------------

  private effectSetOf(refs: readonly A.EffectRef[]): EffectSet {
    const out: Effect[] = [];
    for (const r of refs) {
      const res = this.t.refs.get(r.id);
      if (res !== undefined && res.k === 'effect') out.push(res.effect);
    }
    return EffectSet.of(out);
  }

  typeOf(t: A.Type): Type {
    const memo = this.typeMemo.get(t.id);
    if (memo !== undefined) return memo;
    const result = this.computeType(t);
    this.typeMemo.set(t.id, result);
    return result;
  }

  private computeType(t: A.Type): Type {
    if (t.kind === 'FnType') {
      const params: FnParam[] = t.params.map((p) => ({ name: p.name.text, inout: p.inout, type: this.typeOf(p.type) }));
      return { k: 'fn', params, ret: this.typeOf(t.ret), effects: this.effectSetOf(t.effects) };
    }
    const res = this.t.refs.get(t.id);
    if (res === undefined) return ERROR;
    let base: Type;
    if (res.k === 'prim') {
      if (t.args.length > 0) this.report('E0324', t.span, `\`${res.name}\` takes no type arguments`);
      base = res.name === 'TypeInfo' ? TYPEINFO : res.name === 'Spec' ? { k: 'spec' } : prim(res.name);
    } else if (res.k === 'def') {
      const def = this.t.def(res.def);
      switch (def.kind) {
        case 'alias':
          if (t.args.length > 0) this.report('E0324', t.span, `\`${def.name}\` is a type alias and takes no type arguments`);
          base = this.aliasType(def);
          break;
        case 'type-param':
          if (t.args.length > 0) this.report('E0324', t.span, `type parameter \`${def.name}\` takes no type arguments`);
          base = { k: 'param', def: def.id };
          break;
        case 'record':
        case 'union':
        case 'intrinsic-type':
        case 'capability':
          base = this.instantiate(def, t.args, t.span);
          break;
        case 'interface':
          this.report('E0106', t.name.span, `\`${def.name}\` is an interface; write it as a bound (\`[T: ${def.name}]\`), not a type`);
          base = ERROR;
          break;
        case 'variant':
          this.report('E0106', t.name.span, `\`${def.name}\` is a variant, not a type`);
          base = ERROR;
          break;
        default:
          base = ERROR;
      }
    } else {
      base = ERROR;
    }
    if (t.where === null) return base;
    this.itStack.push(base);
    try {
      this.expr(t.where, BOOL);
    } finally {
      this.itStack.pop();
    }
    return { k: 'refined', base, pred: t.where.id, alias: null };
  }

  private aliasType(def: Def): Type {
    const memo = this.ty.aliases.get(def.id);
    if (memo !== undefined) return memo;
    if (this.busy.has(def.id)) {
      this.report('E0106', def.span, `type alias \`${def.name}\` refers to itself`);
      return ERROR;
    }
    this.busy.add(def.id);
    const node = this.nodeOf(def, 'TypeAlias');
    let type = this.typeOf(node.type);
    if (type.k === 'refined') type = { ...type, alias: def.id };
    this.busy.delete(def.id);
    this.ty.aliases.set(def.id, type);
    return type;
  }

  typeParamsOf(def: Def): readonly TParamInfo[] {
    const memo = this.ty.typeParams.get(def.id);
    if (memo !== undefined) return memo;
    const node = this.t.node(def.node);
    let tparams: readonly A.TParam[] = [];
    if (node.kind === 'FnDecl' || node.kind === 'RecordDecl' || node.kind === 'UnionDecl' || node.kind === 'IntrinsicType' || node.kind === 'CapabilityDecl') tparams = node.tparams;
    const out: TParamInfo[] = [];
    this.ty.typeParams.set(def.id, out);
    for (const p of tparams) {
      const pd = this.defOf(p);
      switch (p.kind) {
        case 'TypeParam': {
          const bound = this.t.refs.get(p.id);
          out.push({ k: 'type', def: pd, bound: bound !== undefined && bound.k === 'def' ? bound.def : null });
          break;
        }
        case 'ConstParam': {
          const type = this.typeOf(p.type);
          this.ty.declTypes.set(pd, type);
          out.push({ k: 'const', def: pd, type });
          break;
        }
        case 'EffectParam':
          out.push({ k: 'effect', def: pd });
          break;
      }
    }
    return out;
  }

  /** The type parameter of an interface declaration. */
  private ifaceParam(iface: Def): DefId {
    const d = this.t.defs.find((x) => x.kind === 'type-param' && x.node === iface.node);
    if (d === undefined) throw new Error(`interface ${iface.name} has no type parameter`);
    return d.id;
  }

  private typeArgOf(a: A.TypeArg, param: TParamInfo | null): TypeArg | null {
    if (a.kind === 'TypeArgType') {
      const res = this.t.refs.get(a.type.id);
      if (res !== undefined && res.k === 'def' && this.t.def(res.def).kind === 'variant' && a.type.kind === 'NamedType') {
        return { k: 'const', value: { k: 'variant', def: res.def } };
      }
      const type = this.typeOf(a.type);
      if (param !== null && param.k === 'const') {
        this.report('E0324', a.span, `\`${this.t.def(param.def).name}\` is a const parameter; a type was given`);
        return null;
      }
      return { k: 'type', type };
    }
    const v = this.evalConst(a.expr);
    if (v === null) {
      this.report('E0337', a.span, 'a type index must be a literal, a `const`, or a parameter');
      return { k: 'const', value: { k: 'error' } };
    }
    if (param !== null && param.k === 'type') {
      this.report('E0324', a.span, `\`${this.t.def(param.def).name}\` is a type parameter; a value was given`);
      return null;
    }
    if (param !== null && param.k === 'const') {
      const vt = this.constType(v);
      if (vt !== null && !assignable(vt, param.type)) {
        this.report('E0321', a.span, `index \`${this.t.def(param.def).name}\` has type ${this.show(param.type)}, but this value has type ${this.show(vt)}`);
      }
    }
    return { k: 'const', value: v };
  }

  private constType(v: ConstValue): Type | null {
    switch (v.k) {
      case 'int':
        return INT;
      case 'float':
        return FLOAT;
      case 'bool':
        return BOOL;
      case 'text':
        return TEXT;
      case 'duration':
        return DURATION;
      case 'unit':
        return UNIT;
      case 'variant': {
        const parent = this.t.def(v.def).parent;
        return parent === null ? null : { k: 'union', def: parent, args: [] };
      }
      case 'sym':
        return this.ty.declTypes.get(v.def) ?? null;
      case 'error':
        return null;
    }
  }

  private instantiate(def: Def, args: readonly A.TypeArg[], span: Span): Type {
    const tparams = this.typeParamsOf(def);
    const out: TypeArg[] = [];
    const restrictions: Restriction[] = [];
    let positional = 0;
    for (const a of args) {
      if (a.label !== null) {
        const idx = tparams.findIndex((p) => this.t.def(p.def).name === a.label?.text);
        if (idx >= 0) {
          const v = this.typeArgOf(a, tparams[idx] ?? null);
          if (v !== null) out[idx] = v;
        } else if (def.kind === 'capability') {
          const v = this.typeArgOf(a, null);
          if (v !== null && v.k === 'const') restrictions.push({ label: a.label.text, value: v.value });
          else if (v !== null) this.report('E0324', a.span, `a capability restriction must be a constant value`);
        } else {
          this.report('E0324', a.span, `\`${def.name}\` has no type parameter \`${a.label.text}\``);
        }
        continue;
      }
      const p = tparams[positional];
      if (p === undefined) {
        this.report('E0324', a.span, `\`${def.name}\` takes ${tparams.length} type argument${tparams.length === 1 ? '' : 's'}`);
        positional += 1;
        continue;
      }
      const v = this.typeArgOf(a, p);
      if (v !== null) out[positional] = v;
      positional += 1;
    }
    const filled: TypeArg[] = [];
    let missing = false;
    tparams.forEach((p, i) => {
      const v = out[i];
      if (v === undefined) {
        missing = true;
        filled.push(p.k === 'type' ? { k: 'type', type: ERROR } : { k: 'const', value: { k: 'unit' } });
      } else {
        filled.push(v);
      }
    });
    if (missing && args.length > 0) this.report('E0324', span, `\`${def.name}\` takes ${tparams.length} type argument${tparams.length === 1 ? '' : 's'}`);
    else if (missing) this.report('E0324', span, `\`${def.name}\` needs ${tparams.length} type argument${tparams.length === 1 ? '' : 's'}`);
    switch (def.kind) {
      case 'record':
        return { k: 'record', def: def.id, args: filled };
      case 'union':
        return { k: 'union', def: def.id, args: filled };
      case 'capability':
        return { k: 'capability', def: def.id, args: filled, restrictions };
      default:
        return { k: 'opaque', def: def.id, args: filled };
    }
  }

  fieldsOf(def: Def): readonly FieldInfo[] {
    const memo = this.ty.fields.get(def.id);
    if (memo !== undefined) return memo;
    const node = this.t.node(def.node);
    const fields = node.kind === 'RecordDecl' || node.kind === 'Variant' ? node.fields : [];
    const out: FieldInfo[] = [];
    this.ty.fields.set(def.id, out);
    for (const f of fields) {
      const fd = this.defOf(f);
      const type = this.typeOf(f.type);
      this.ty.declTypes.set(fd, type);
      out.push({ def: fd, name: f.name.text, type });
    }
    return out;
  }

  variantsOf(union: Def): readonly DefId[] {
    const memo = this.ty.variants.get(union.id);
    if (memo !== undefined) return memo;
    const node = this.nodeOf(union, 'UnionDecl');
    const out = node.variants.map((v) => this.defOf(v));
    this.ty.variants.set(union.id, out);
    return out;
  }

  // -------------------------------------------------------------------------
  // Elaboration: signatures and constants
  // -------------------------------------------------------------------------

  signatureOf(def: Def): Signature {
    const memo = this.ty.signatures.get(def.id);
    if (memo !== undefined) return memo;
    const node = this.t.node(def.node);
    let tparams: readonly TParamInfo[] = [];
    let params: readonly A.Param[] = [];
    let ret: A.Type | null = null;
    let effects: readonly A.EffectRef[] = [];
    let contracts: readonly A.Contract[] = [];
    let constFn = false;
    let intrinsic = false;
    if (node.kind === 'FnDecl') {
      tparams = this.typeParamsOf(def);
      params = node.params;
      ret = node.ret;
      effects = node.effects;
      contracts = node.contracts;
      constFn = node.constFn;
      intrinsic = node.intrinsic;
    } else if (node.kind === 'IfaceFn') {
      params = node.params;
      ret = node.ret;
      effects = node.effects;
      contracts = node.contracts;
    } else if (node.kind === 'Law') {
      params = node.params;
    } else {
      throw new Error(`${def.name} has no signature`);
    }
    const fnParams: FnParam[] = [];
    const paramDefs: DefId[] = [];
    for (const p of params) {
      const pd = this.t.defOf.get(p.id);
      const type = this.typeOf(p.type);
      if (pd !== undefined) {
        this.ty.declTypes.set(pd, type);
        paramDefs.push(pd);
      }
      fnParams.push({ name: p.name.text, inout: p.inout, type });
    }
    const sig: Signature = {
      def: def.id,
      tparams,
      params: fnParams,
      paramDefs,
      ret: ret === null ? BOOL : this.typeOf(ret),
      effects: this.effectSetOf(effects),
      contracts,
      constFn,
      intrinsic,
    };
    this.ty.signatures.set(def.id, sig);
    return sig;
  }

  /** The value of a `const` definition, or null when it is not a constant expression. */
  constOf(def: DefId): ConstValue | null {
    const memo = this.constMemo.get(def);
    if (memo !== undefined) return memo;
    if (this.busy.has(def)) return null;
    this.busy.add(def);
    const node = this.nodeOf(this.t.def(def), 'ConstDecl');
    const v = this.evalConst(node.value);
    this.busy.delete(def);
    this.constMemo.set(def, v);
    return v;
  }

  private evalConst(e: A.Expr): ConstValue | null {
    return evalBasic(e, { resolve: this.t, constOf: (d) => this.constOf(d) });
  }

  private elaborateItem(item: A.Item): void {
    this.currentDef = 'name' in item ? item.name.text : item.iface.text;
    switch (item.kind) {
      case 'FnDecl':
        if (item.vis.sealed) this.report('E0335', item.name.span, '`sealed` applies to records and unions only');
        this.signatureOf(this.t.def(this.defOf(item)));
        break;
      case 'TypeAlias':
        if (item.vis.sealed) this.report('E0335', item.name.span, '`sealed` applies to records and unions only');
        this.aliasType(this.t.def(this.defOf(item)));
        break;
      case 'IntrinsicType':
      case 'CapabilityDecl':
        this.typeParamsOf(this.t.def(this.defOf(item)));
        break;
      case 'ConstDecl': {
        const def = this.t.def(this.defOf(item));
        const type = this.typeOf(item.type);
        this.ty.declTypes.set(def.id, type);
        break;
      }
      case 'RecordDecl': {
        const def = this.t.def(this.defOf(item));
        this.typeParamsOf(def);
        this.fieldsOf(def);
        break;
      }
      case 'UnionDecl': {
        const def = this.t.def(this.defOf(item));
        this.typeParamsOf(def);
        for (const v of this.variantsOf(def)) this.fieldsOf(this.t.def(v));
        break;
      }
      case 'InterfaceDecl':
        if (item.vis.sealed) this.report('E0335', item.name.span, '`sealed` applies to records and unions only');
        for (const m of item.items) this.signatureOf(this.t.def(this.defOf(m)));
        break;
      case 'ImplDecl': {
        const iface = this.t.refs.get(item.id);
        const target = this.typeOf(item.target);
        if (iface !== undefined && iface.k === 'def') {
          const list = this.impls.get(iface.def) ?? [];
          if (list.some((x) => sameBase(x.target, target))) this.report('E0107', item.iface.span, `\`${item.iface.text}\` is already implemented for ${this.show(target)}`);
          list.push({ target, node: item });
          this.impls.set(iface.def, list);
          this.ty.impls.set(iface.def, [...(this.ty.impls.get(iface.def) ?? []), { target, def: this.defOf(item) }]);
        }
        for (const f of item.fns) this.signatureOf(this.t.def(this.defOf(f)));
        break;
      }
      case 'PropertyDecl':
        for (const p of item.params) this.ty.declTypes.set(this.defOf(p), this.typeOf(p.type));
        break;
      case 'ClaimDecl':
      case 'PathDecl':
      case 'PolicyDecl':
      case 'ExampleDecl':
        break;
    }
    this.currentDef = null;
  }

  // -------------------------------------------------------------------------
  // Checking: items
  // -------------------------------------------------------------------------

  private checkItem(item: A.Item): void {
    switch (item.kind) {
      case 'FnDecl':
        this.checkFn(item);
        break;
      case 'ConstDecl': {
        const type = this.ty.declTypes.get(this.defOf(item)) ?? ERROR;
        this.inFn({ ret: null, assertion: false, recover: false, frame: 0 }, () => this.expr(item.value, type));
        break;
      }
      case 'CapabilityDecl':
        for (const g of item.grants) {
          if (g.when) this.inFn({ ret: null, assertion: false, recover: false, frame: 0 }, () => this.expr(g.when as A.Expr, BOOL));
        }
        break;
      case 'InterfaceDecl':
        for (const m of item.items) {
          this.currentDef = `${item.name.text}.${m.name.text}`;
          const sig = this.signatureOf(this.t.def(this.defOf(m)));
          if (m.kind === 'IfaceFn') this.checkContracts(sig);
          else this.checkAssertionBlock(m.body);
        }
        break;
      case 'ImplDecl':
        this.checkImpl(item);
        break;
      case 'ExampleDecl':
        this.checkAssertionBlock(item.body);
        break;
      case 'PropertyDecl':
        this.checkAssertionBlock(item.body);
        break;
      case 'TypeAlias':
      case 'IntrinsicType':
      case 'RecordDecl':
      case 'UnionDecl':
      case 'ClaimDecl':
      case 'PathDecl':
      case 'PolicyDecl':
        break;
    }
  }

  private checkFn(f: A.FnDecl): void {
    const def = this.t.def(this.defOf(f));
    const sig = this.signatureOf(def);
    this.checkContracts(sig);
    if (f.body === null) return;
    const body = f.body;
    this.inFn({ ret: sig.ret, assertion: false, recover: false, frame: 0 }, () => {
      this.block(body);
      if (!sameBase(sig.ret, UNIT) && !this.blockReturns(body)) {
        this.report('E0331', f.name.span, `\`${f.name.text}\` returns ${this.show(sig.ret)} but not every path ends in \`return\``);
      }
    });
  }

  private checkContracts(sig: Signature): void {
    for (const c of sig.contracts) {
      this.inFn({ ret: sig.ret, assertion: false, recover: false, frame: 0 }, () => this.expr(c.expr, c.clause === 'decreases' ? INT : BOOL));
    }
  }

  /** A `verify` block (§20.2): capability parameters, declared effects, an assertion body yielding Bool. */
  private checkVerify(v: A.VerifyBlock): void {
    const params: FnParam[] = [];
    for (const p of v.params) {
      const type = this.typeOf(p.type);
      this.ty.declTypes.set(this.defOf(p), type);
      params.push({ name: p.name.text, type, inout: false });
      if (stripRefinements(type).k !== 'capability') {
        this.report('E0208', p.span, `verify parameters are capabilities supplied by the environment (§20.2); \`${p.name.text}\` is ${this.show(type)}`);
      }
    }
    this.ty.verifies.set(v.id, { params, effects: this.effectSetOf(v.effects) });
    this.inFn({ ret: BOOL, assertion: true, recover: false, frame: 0, verify: true }, () => this.block(v.body));
  }

  private checkAssertionBlock(b: A.Block): void {
    this.inFn({ ret: null, assertion: true, recover: false, frame: 0 }, () => this.block(b));
  }

  private checkImpl(impl: A.ImplDecl): void {
    const ifaceRes = this.t.refs.get(impl.id);
    if (ifaceRes === undefined || ifaceRes.k !== 'def') return;
    const iface = this.t.def(ifaceRes.def);
    const target = this.typeOf(impl.target);
    const tp = this.ifaceParam(iface);
    const subst: Subst = new Map([[tp, { k: 'type', type: target }]]);
    const ifaceFns = this.t.defs.filter((d) => d.parent === iface.id && d.kind === 'iface-fn');
    const implFns = impl.fns.map((f) => ({ node: f, def: this.t.def(this.defOf(f)) }));
    for (const want of ifaceFns) {
      const have = implFns.find((x) => x.def.name === want.name);
      if (have === undefined) {
        this.report('E0334', impl.iface.span, `impl ${iface.name}[${this.show(target)}] is missing \`${want.name}\``);
        continue;
      }
      const ws = this.signatureOf(want);
      const hs = this.signatureOf(have.def);
      const problems: string[] = [];
      if (ws.params.length !== hs.params.length) problems.push(`expected ${ws.params.length} parameters, found ${hs.params.length}`);
      else {
        ws.params.forEach((wp, i) => {
          const hp = hs.params[i];
          if (hp === undefined) return;
          const wt = substitute(wp.type, subst);
          if (wp.name !== hp.name) problems.push(`parameter ${i + 1} is named \`${wp.name}\` in the interface, \`${hp.name}\` here`);
          else if (wp.inout !== hp.inout) problems.push(`parameter \`${wp.name}\` differs in \`inout\``);
          else if (!sameBase(wt, hp.type)) problems.push(`parameter \`${wp.name}\` has type ${this.show(wt)} in the interface, ${this.show(hp.type)} here`);
        });
      }
      const wr = substitute(ws.ret, subst);
      if (!sameBase(wr, hs.ret)) problems.push(`returns ${this.show(wr)} in the interface, ${this.show(hs.ret)} here`);
      if (hs.tparams.length > 0) problems.push('an impl function takes no type parameters');
      for (const p of problems) this.report('E0334', have.node.name.span, `\`${want.name}\`: ${p}`);
    }
    for (const have of implFns) {
      if (!ifaceFns.some((w) => w.name === have.def.name)) this.report('E0334', have.node.name.span, `interface \`${iface.name}\` has no function \`${have.def.name}\``);
    }
    for (const f of impl.fns) {
      this.currentDef = `${impl.iface.text}.${f.name.text}`;
      this.checkFn(f);
    }
  }

  /** True iff an implementation of `iface` exists for `target`, or `target` is a type parameter with that bound. */
  private implemented(iface: DefId, target: Type): boolean {
    const s = stripRefinements(target);
    if (s.k === 'error') return true;
    if (s.k === 'param') {
      const info = [...this.ty.typeParams.values()].flat().find((p) => p.def === s.def);
      return info !== undefined && info.k === 'type' && info.bound === iface;
    }
    return (this.impls.get(iface) ?? []).some((x) => sameBase(x.target, s));
  }

  // -------------------------------------------------------------------------
  // Checking: statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): void {
    let returned = false;
    for (const s of b.stmts) {
      if (returned) {
        this.report('E0332', s.span, 'this statement follows a `return` on every path');
        returned = false;
      }
      this.stmt(s);
      if (this.stmtReturns(s)) returned = true;
    }
  }

  private stmtReturns(s: A.Stmt): boolean {
    switch (s.kind) {
      case 'Return':
        return true;
      case 'If':
        return s.else !== null && this.blockReturns(s.then) && this.blockReturns(s.else);
      case 'Match':
        return s.arms.length > 0 && s.arms.every((a) => (a.body.kind === 'Block' ? this.blockReturns(a.body) : this.stmtReturns(a.body)));
      default:
        return false;
    }
  }

  private blockReturns(b: A.Block): boolean {
    return b.stmts.some((s) => this.stmtReturns(s));
  }

  private stmt(s: A.Stmt): void {
    const fn = this.fn;
    switch (s.kind) {
      case 'Let':
      case 'Var': {
        const type = this.typeOf(s.type);
        this.ty.declTypes.set(this.defOf(s), type);
        this.expr(s.value, type);
        return;
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        if (res === undefined || res.k !== 'def') return;
        const def = this.t.def(res.def);
        if (def.kind !== 'var' && !(def.kind === 'param' && def.inout)) {
          this.report('E0328', s.name.span, `\`${s.name.text}\` is ${describeBinding(def)}; only a \`var\` or an \`inout\` parameter can be assigned`);
        }
        this.expr(s.value, this.ty.declTypes.get(def.id) ?? ERROR);
        return;
      }
      case 'Return': {
        if (fn === null || fn.ret === null) {
          this.report('E0321', s.span, fn?.recover ? '`return` is not allowed inside `recover`; the block\'s last expression is its value' : '`return` is not allowed here');
          this.infer(s.value);
          return;
        }
        this.expr(s.value, fn.ret);
        return;
      }
      case 'If':
        this.expr(s.cond, BOOL);
        this.block(s.then);
        if (s.else) this.block(s.else);
        return;
      case 'Match':
        this.match(s);
        return;
      case 'Loop':
        this.expr(s.cond, BOOL);
        for (const c of s.clauses) this.expr(c.expr, c.clause === 'invariant' ? BOOL : INT);
        this.block(s.body);
        return;
      case 'For': {
        const declared = this.typeOf(s.type);
        this.ty.declTypes.set(this.defOf(s), declared);
        if (s.domain.kind === 'RangeDomain') {
          if (!sameBase(declared, INT)) this.report('E0321', s.type.span, `a range iterates Int values, not ${this.show(declared)}`);
          this.expr(s.domain.lo, INT);
          this.expr(s.domain.hi, INT);
        } else {
          const elem = this.elementType(this.infer(s.domain.expr), s.domain.expr.span);
          if (elem !== null) this.coerce(elem, declared, s.type.span, 'loop variable');
        }
        this.block(s.body);
        return;
      }
      case 'Assume':
        if (s.verify !== null) this.checkVerify(s.verify);
        return;
      case 'ExprStmt': {
        const t = this.infer(s.expr);
        if (fn !== null && fn.assertion) {
          if (!assignable(t, BOOL)) this.report('E0321', s.span, `an assertion must be Bool, found ${this.show(t)}`);
          return;
        }
        if (fn !== null && fn.recover) return;
        if (!assignable(t, UNIT)) this.report('E0339', s.span, `this call returns ${this.show(t)}; bind it with \`let\` or return it`);
        return;
      }
    }
  }

  /** The element type of a `List[T]`, or null (reported). */
  private elementType(t: Type, span: Span): Type | null {
    const s = stripRefinements(t);
    if (s.k === 'error') return ERROR;
    const listDef = this.stdType('std.list', 'List');
    const a0 = s.k === 'opaque' ? s.args[0] : undefined;
    if (s.k === 'opaque' && s.def === listDef && a0?.k === 'type') return a0.type;
    this.report('E0321', span, `\`for\` iterates a range or a List, not ${this.show(t)}`);
    return null;
  }

  private match(s: A.Match): void {
    const scrutinee = this.infer(s.scrutinee);
    const st = stripRefinements(scrutinee);
    let shape: Scrutinee;
    if (st.k === 'union') shape = { kind: 'union', variants: this.variantsOf(this.t.def(st.def)) };
    else if (st.k === 'prim' && st.name === 'Bool') shape = { kind: 'bool' };
    else if (st.k === 'error') shape = { kind: 'other' };
    else if (st.k === 'prim' && (st.name === 'Int' || st.name === 'Text' || st.name === 'Float' || st.name === 'Duration')) shape = { kind: 'other' };
    else {
      this.report('E0321', s.scrutinee.span, `\`match\` needs a union, Bool, Int, Text, Float or Duration, not ${this.show(scrutinee)}`);
      shape = { kind: 'other' };
    }
    const shapes: ArmShape[] = [];
    for (const arm of s.arms) {
      shapes.push(this.pattern(arm.pattern, scrutinee, arm.guard !== null));
      if (arm.guard) this.expr(arm.guard, BOOL);
      if (arm.body.kind === 'Block') this.block(arm.body);
      else this.stmt(arm.body);
    }
    if (st.k === 'error') return;
    const cov = coverage(shape, shapes, (v) => this.t.def(v).name);
    for (const i of cov.unreachable) {
      const arm = s.arms[i];
      if (arm !== undefined) this.report('E0327', arm.pattern.span, 'every value this arm could match is handled by an earlier arm');
    }
    if (cov.needsCatchAll) this.report('E0326', s.scrutinee.span, `a \`match\` on ${this.show(scrutinee)} needs a \`_\` arm`);
    else if (cov.missing.length > 0) this.report('E0326', s.scrutinee.span, `missing ${cov.missing.map((m) => `\`${m}\``).join(', ')}`);
  }

  /** Types the bindings of `p` against `scrutinee` and returns its coverage shape. */
  private pattern(p: A.Pattern, scrutinee: Type, guarded: boolean): ArmShape {
    const st = stripRefinements(scrutinee);
    switch (p.kind) {
      case 'WildcardPat':
        return { kind: 'all', guarded };
      case 'BindPat':
        this.ty.declTypes.set(this.defOf(p), scrutinee);
        return { kind: 'all', guarded };
      case 'LitPat': {
        const lt = this.infer(p.literal);
        if (!assignable(lt, scrutinee)) this.report('E0341', p.span, `a ${this.show(lt)} literal cannot match ${this.show(scrutinee)}`);
        if (p.literal.kind === 'BoolLit') return { kind: 'bool', value: p.literal.value, guarded };
        return { kind: 'lit', guarded };
      }
      case 'VariantPat': {
        const res = this.t.refs.get(p.id);
        if (res === undefined || res.k !== 'def') return { kind: 'all', guarded: true };
        const variant = this.t.def(res.def);
        const union = variant.parent === null ? null : this.t.def(variant.parent);
        if (st.k === 'error') return { kind: 'variant', variant: variant.id, guarded };
        if (union === null || st.k !== 'union' || st.def !== union.id) {
          this.report('E0341', p.name.span, `\`${variant.name}\` is a variant of ${union === null ? '?' : union.name}, but the scrutinee has type ${this.show(scrutinee)}`);
          return { kind: 'variant', variant: variant.id, guarded: true };
        }
        const subst = this.substOf(union, st.args);
        const fields = this.fieldsOf(variant);
        // A bare variant name matches any payload, like `Variant(..)`.
        if (p.fields === null) return { kind: 'variant', variant: variant.id, guarded };
        let i = 0;
        let rest = false;
        for (const pf of p.fields) {
          if (rest) {
            this.report('E0310', pf.span, '`..` must be the last pattern field');
            break;
          }
          if (pf.kind === 'PatFieldRest') {
            rest = true;
            continue;
          }
          const f = fields[i];
          if (f === undefined) {
            this.report('E0310', pf.span, `\`${variant.name}\` has only ${fields.length} field${fields.length === 1 ? '' : 's'}`);
            break;
          }
          if (pf.kind === 'PatFieldName') {
            if (pf.name.text !== f.name) this.report('E0310', pf.name.span, `field ${i + 1} of \`${variant.name}\` is \`${f.name}\`; patterns cannot rename`);
            this.ty.declTypes.set(this.defOf(pf), substitute(f.type, subst));
          }
          i += 1;
        }
        if (!rest && i < fields.length) this.report('E0310', p.span, `\`${variant.name}\` has ${fields.length} fields; list them all or end with \`..\``);
        return { kind: 'variant', variant: variant.id, guarded };
      }
    }
  }

  private substOf(def: Def, args: readonly TypeArg[]): Subst {
    const subst: Subst = new Map();
    this.typeParamsOf(def).forEach((p, i) => {
      const a = args[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    return subst;
  }

  // -------------------------------------------------------------------------
  // Checking: expressions
  // -------------------------------------------------------------------------

  private infer(e: A.Expr): Type {
    return this.expr(e, null);
  }

  /**
   * Types `e`; when `expected` is given the result must be assignable to it.
   * Records the expression's type and returns it (`ERROR` after a report).
   */
  expr(e: A.Expr, expected: Type | null): Type {
    const t = this.exprInner(e, expected);
    const result = expected === null ? t : this.coerce(t, expected, e.span, 'expression', e.id);
    this.ty.exprTypes.set(e.id, result);
    return result;
  }

  /** Checks that `actual` flows into `expected`, recording a refinement obligation at `at` when it does. */
  private coerce(actual: Type, expected: Type, span: Span, what: string, at: A.NodeId | null = null): Type {
    if (actual.k === 'error' || expected.k === 'error') return actual.k === 'error' ? ERROR : actual;
    if (!assignable(actual, expected)) {
      this.report('E0321', span, `expected ${this.show(expected)}, found ${this.show(actual)}${what === 'expression' ? '' : ` (${what})`}`);
      return ERROR;
    }
    if (at !== null && isRefined(expected) && !sameRefinement(actual, expected)) this.ty.refinementFlows.push({ at, from: actual, to: expected });
    return actual;
  }

  private exprInner(e: A.Expr, expected: Type | null): Type {
    switch (e.kind) {
      case 'IntLit':
        return INT;
      case 'FloatLit':
        return FLOAT;
      case 'TextLit':
        return TEXT;
      case 'BoolLit':
        return BOOL;
      case 'DurationLit':
        return DURATION;
      case 'Name':
        return this.nameType(e);
      case 'It': {
        const it = this.itStack[this.itStack.length - 1];
        return it ?? ERROR;
      }
      case 'ResultRef':
        return this.fn?.ret ?? ERROR;
      case 'Old': {
        const res = this.t.refs.get(e.id);
        return res !== undefined && res.k === 'def' ? (this.ty.declTypes.get(res.def) ?? ERROR) : ERROR;
      }
      case 'Ctor':
        return this.ctor(e, expected);
      case 'RecordUpdate':
        return this.recordUpdate(e);
      case 'ListLit':
        return this.listLit(e, expected);
      case 'Try':
        return this.tryExpr(e);
      case 'Recover':
        return this.recover(e);
      case 'Quantifier':
        return this.quantifier(e);
      case 'Closure':
        return this.closure(e);
      case 'Fake':
        return this.fake(e, expected);
      case 'Hole':
        this.ty.holes.set(e.id, expected);
        return ERROR;
      case 'FieldAccess':
        return this.fieldAccess(e);
      case 'Call':
        return this.call(e, expected);
      case 'Unary': {
        if (e.op === 'not') {
          this.expr(e.operand, BOOL);
          return BOOL;
        }
        const t = this.infer(e.operand);
        if (!isNumeric(t)) {
          if (t.k !== 'error') this.report('E0340', e.span, `unary \`-\` needs Int, Float or Duration, not ${this.show(t)}`);
          return ERROR;
        }
        return stripRefinements(t);
      }
      case 'Binary':
        return this.binary(e);
      case 'And':
      case 'Or':
        for (const o of e.operands) this.expr(o, BOOL);
        return BOOL;
      case 'Is': {
        const t = this.infer(e.expr);
        this.pattern(e.pattern, t, false);
        return BOOL;
      }
    }
  }

  private nameType(e: A.Name): Type {
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') return ERROR;
    const def = this.t.def(res.def);
    if (def.kind === 'fn') {
      const sig = this.signatureOf(def);
      if (sig.tparams.length > 0) {
        this.report('E0324', e.span, `\`${def.name}\` is generic; a generic function cannot be used as a value`);
        return ERROR;
      }
      return { k: 'fn', params: sig.params, ret: sig.ret, effects: sig.effects };
    }
    if (def.kind === 'const') {
      const t = this.ty.declTypes.get(def.id);
      if (t === undefined) {
        const node = this.nodeOf(def, 'ConstDecl');
        const ct = this.typeOf(node.type);
        this.ty.declTypes.set(def.id, ct);
        return ct;
      }
      return t;
    }
    const t = this.ty.declTypes.get(def.id) ?? ERROR;
    const fn = this.fn;
    if (fn !== null && def.frame >= 0 && def.frame < fn.frame && stripRefinements(t).k === 'capability') {
      this.report('E0330', e.span, `\`${def.name}\` is a capability; closures may not capture capabilities (§8)`);
    }
    return t;
  }

  private binary(e: A.Binary): Type {
    switch (e.op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%': {
        const l = this.infer(e.left);
        if (l.k === 'error') {
          this.infer(e.right);
          return ERROR;
        }
        if (!isNumeric(l)) {
          this.report('E0340', e.left.span, `\`${e.op}\` needs Int, Float or Duration operands, not ${this.show(l)}`);
          this.infer(e.right);
          return ERROR;
        }
        const base = stripRefinements(l);
        this.expr(e.right, base);
        return base;
      }
      case '++': {
        const l = this.infer(e.left);
        if (l.k === 'error') {
          this.infer(e.right);
          return ERROR;
        }
        const base = stripRefinements(l);
        const isList = base.k === 'opaque' && base.def === this.stdType('std.list', 'List');
        if (!sameBase(base, TEXT) && !isList) {
          this.report('E0340', e.left.span, `\`++\` joins Text or List values, not ${this.show(l)}`);
          this.infer(e.right);
          return ERROR;
        }
        this.expr(e.right, base);
        return base;
      }
      case '==':
      case '!=': {
        const l = this.infer(e.left);
        if (stripRefinements(l).k === 'fn') this.report('E0340', e.span, 'function values cannot be compared (§3.7)');
        this.expr(e.right, l.k === 'error' ? l : stripRefinements(l));
        return BOOL;
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const l = this.infer(e.left);
        if (l.k !== 'error' && !isNumeric(l)) {
          this.report('E0340', e.left.span, `\`${e.op}\` compares Int, Float or Duration values, not ${this.show(l)}`);
          this.infer(e.right);
          return BOOL;
        }
        this.expr(e.right, l.k === 'error' ? l : stripRefinements(l));
        return BOOL;
      }
      case 'implies':
        this.expr(e.left, BOOL);
        this.expr(e.right, BOOL);
        return BOOL;
    }
  }

  private ctor(e: A.Ctor, expected: Type | null): Type {
    const res = this.t.refs.get(e.id);
    if (res === undefined) return ERROR;
    if (res.k === 'unit') return UNIT;
    if (res.k === 'type-value') return TYPEINFO;
    if (res.k !== 'def') return ERROR;
    const def = this.t.def(res.def);
    if (def.kind === 'variant') {
      const union = def.parent === null ? null : this.t.def(def.parent);
      if (union === null) return ERROR;
      if (e.fields !== null) {
        this.report('E0322', e.span, `\`${def.name}\` is a variant; give its fields as named arguments in parentheses`);
        return ERROR;
      }
      const subst = this.bindFromExpected(union, expected);
      const fields = this.fieldsOf(def);
      this.matchNamed(e.args ?? [], fields.map((f) => ({ name: f.name, inout: false, type: f.type })), subst, this.typeParamsOf(union), e.span, `variant \`${def.name}\``);
      const args = this.finishArgs(union, subst, e.span);
      return { k: 'union', def: union.id, args };
    }
    if (def.kind === 'record') {
      if (e.args !== null) {
        this.report('E0322', e.span, `\`${def.name}\` is a record; give its fields in braces`);
        return ERROR;
      }
      const subst = this.bindFromExpected(def, expected);
      const fields = this.fieldsOf(def);
      const inits = (e.fields ?? []).map((f): A.Arg => ({ id: f.id, kind: 'Arg', span: f.span, name: f.name, inout: false, value: f.value }));
      this.matchNamed(inits, fields.map((f) => ({ name: f.name, inout: false, type: f.type })), subst, this.typeParamsOf(def), e.span, `record \`${def.name}\``);
      const args = this.finishArgs(def, subst, e.span);
      return { k: 'record', def: def.id, args };
    }
    return ERROR;
  }

  /** Binds a generic declaration's type parameters from an expected instance of the same declaration. */
  private bindFromExpected(def: Def, expected: Type | null): Subst {
    const subst: Subst = new Map();
    if (expected === null) return subst;
    const s = stripRefinements(expected);
    if ((s.k === 'record' || s.k === 'union' || s.k === 'opaque') && s.def === def.id) {
      this.typeParamsOf(def).forEach((p, i) => {
        const a = s.args[i];
        if (a !== undefined) subst.set(p.def, a);
      });
    }
    return subst;
  }

  /** After argument checking: every type parameter must be bound. */
  private finishArgs(def: Def, subst: Subst, span: Span): TypeArg[] {
    const out: TypeArg[] = [];
    for (const p of this.typeParamsOf(def)) {
      const b = subst.get(p.def);
      if (b === undefined) {
        this.report('E0324', span, `cannot determine \`${this.t.def(p.def).name}\` of \`${def.name}\`; annotate the binding or pass the type argument`);
        out.push(p.k === 'type' ? { k: 'type', type: ERROR } : { k: 'const', value: { k: 'unit' } });
      } else {
        out.push(b);
      }
    }
    return out;
  }

  /**
   * Matches named arguments to parameters, checking each argument against its
   * parameter's type once the parameter's type variables are bound and
   * inferring the argument to bind them otherwise.
   */
  private matchNamed(args: readonly A.Arg[], params: readonly FnParam[], subst: Subst, tparams: readonly TParamInfo[], span: Span, what: string): void {
    const tvars = new Set(tparams.map((p) => p.def));
    const seen = new Set<string>();
    const inoutVars = new Set<DefId>();
    for (const a of args) {
      const p = params.find((x) => x.name === a.name.text);
      if (p === undefined) {
        this.report('E0322', a.name.span, `${what} has no parameter \`${a.name.text}\``);
        this.infer(a.value);
        continue;
      }
      seen.add(p.name);
      if (p.inout !== a.inout) {
        this.report('E0329', a.span, p.inout ? `\`${p.name}\` is an \`inout\` parameter; write \`${p.name}: inout ${exprText(a.value)}\`` : `\`${p.name}\` is not an \`inout\` parameter`);
      }
      if (a.inout) this.checkInoutArg(a, inoutVars);
      const pt = substitute(p.type, subst);
      if (hasUnbound(pt, tvars, subst)) {
        const actual = this.infer(a.value);
        if (!this.unify(pt, actual, subst, tvars)) {
          this.report('E0321', a.value.span, `expected ${this.show(substitute(pt, subst))}, found ${this.show(actual)}`);
        }
      } else {
        this.expr(a.value, pt);
      }
    }
    const missing = params.filter((p) => !seen.has(p.name)).map((p) => `\`${p.name}\``);
    if (missing.length > 0) this.report('E0322', span, `${what} is missing ${missing.join(', ')}`);
  }

  private checkInoutArg(a: A.Arg, inoutVars: Set<DefId>): void {
    const v = a.value;
    const res = v.kind === 'Name' ? this.t.refs.get(v.id) : undefined;
    const def = res !== undefined && res.k === 'def' ? this.t.def(res.def) : null;
    if (def === null || !(def.kind === 'var' || (def.kind === 'param' && def.inout))) {
      this.report('E0329', v.span, 'an `inout` argument must be a `var` or an `inout` parameter');
      return;
    }
    if (inoutVars.has(def.id)) this.report('E0329', v.span, `\`${def.name}\` is passed \`inout\` twice in one call`);
    inoutVars.add(def.id);
  }

  /** Structural unification binding type variables in `tvars`. */
  private unify(pattern: Type, actual: Type, subst: Subst, tvars: ReadonlySet<DefId>): boolean {
    const p = stripRefinements(pattern);
    const a = stripRefinements(actual);
    if (a.k === 'error' || p.k === 'error') return true;
    if (p.k === 'param' && tvars.has(p.def)) {
      const bound = subst.get(p.def);
      if (bound === undefined) {
        subst.set(p.def, { k: 'type', type: actual });
        return true;
      }
      return bound.k === 'type' && assignable(actual, bound.type);
    }
    if (p.k !== a.k) return false;
    switch (p.k) {
      case 'prim':
        return a.k === 'prim' && a.name === p.name;
      case 'record':
      case 'union':
      case 'opaque':
      case 'capability': {
        if (a.k !== p.k || a.def !== p.def || a.args.length !== p.args.length) return false;
        for (let i = 0; i < p.args.length; i++) {
          const pa = p.args[i];
          const aa = a.args[i];
          if (pa === undefined || aa === undefined) return false;
          if (pa.k === 'type' && aa.k === 'type') {
            if (!this.unify(pa.type, aa.type, subst, tvars)) return false;
          } else if (pa.k === 'const' && aa.k === 'const') {
            if (pa.value.k === 'sym' && tvars.has(pa.value.def)) {
              const bound = subst.get(pa.value.def);
              if (bound === undefined) subst.set(pa.value.def, aa);
              else if (bound.k !== 'const' || !constEquals(bound.value, aa.value)) return false;
            } else if (!constEquals(pa.value, aa.value)) return false;
          } else {
            return false;
          }
        }
        return true;
      }
      case 'fn': {
        if (a.k !== 'fn' || a.params.length !== p.params.length) return false;
        for (let i = 0; i < p.params.length; i++) {
          const pp = p.params[i];
          const ap = a.params[i];
          if (pp === undefined || ap === undefined || pp.inout !== ap.inout || !this.unify(pp.type, ap.type, subst, tvars)) return false;
        }
        if (!this.unify(p.ret, a.ret, subst, tvars)) return false;
        // An effect parameter of the pattern binds to the actual effects not accounted for by concrete ones.
        const concrete = EffectSet.of(p.effects.values().filter((e) => e.k !== 'param' || !tvars.has(e.def)));
        for (const e of p.effects.values()) {
          if (e.k === 'param' && tvars.has(e.def) && !subst.has(e.def)) {
            subst.set(e.def, { k: 'effects', effects: EffectSet.of(a.effects.values().filter((x) => !concrete.has(x))) });
          }
        }
        return true;
      }
      case 'param':
        return a.k === 'param' && a.def === p.def;
      default:
        return sameBase(p, a);
    }
  }

  private recordUpdate(e: A.RecordUpdate): Type {
    const base = this.infer(e.base);
    const s = stripRefinements(base);
    if (s.k === 'error') {
      for (const f of e.fields) this.infer(f.value);
      return ERROR;
    }
    if (s.k !== 'record') {
      this.report('E0321', e.base.span, `\`with\` updates a record, not ${this.show(base)}`);
      for (const f of e.fields) this.infer(f.value);
      return ERROR;
    }
    const def = this.t.def(s.def);
    if (def.sealed && this.currentModule !== null && def.module !== this.currentModule.id && !this.currentModule.module.test) {
      this.report('E0111', e.span, `\`${this.t.qualifiedName(def.id)}\` is sealed; \`with\` is allowed only in module \`${this.t.moduleOf(def.module).name}\``);
    }
    const subst = this.substOf(def, s.args);
    const fields = this.fieldsOf(def);
    for (const f of e.fields) {
      const field = fields.find((x) => x.name === f.name.text);
      if (field === undefined) {
        this.report('E0325', f.name.span, `\`${def.name}\` has no field \`${f.name.text}\``);
        this.infer(f.value);
        continue;
      }
      this.expr(f.value, substitute(field.type, subst));
    }
    return s;
  }

  private listLit(e: A.ListLit, expected: Type | null): Type {
    const exp = expected === null ? null : stripRefinements(expected);
    const listDef = this.stdType('std.list', 'List');
    const expElem = exp !== null && exp.k === 'opaque' && exp.def === listDef && exp.args[0]?.k === 'type' ? exp.args[0].type : null;
    if (expElem !== null) {
      for (const x of e.elems) this.expr(x, expElem);
      return this.listOf(expElem);
    }
    const first = e.elems[0];
    if (first === undefined) {
      if (exp === null) this.report('E0324', e.span, 'cannot determine the element type of an empty list; annotate the binding');
      return exp === null ? ERROR : this.listOf(ERROR);
    }
    const elem = stripRefinements(this.infer(first));
    for (const x of e.elems.slice(1)) this.expr(x, elem);
    return this.listOf(elem);
  }

  private tryExpr(e: A.Try): Type {
    const inner = this.infer(e.expr);
    const fallible = this.unwrapFallible(inner);
    if (fallible === null) {
      if (inner.k !== 'error') this.report('E0321', e.expr.span, `\`try\` unwraps a Result or Option, not ${this.show(inner)}`);
      if (e.else) this.infer(e.else.expr);
      return ERROR;
    }
    const fn = this.fn;
    if (fn !== null && fn.verify === true) {
      // In a verify block the else value is the block's Bool result (§20.2).
      if (e.else === null) {
        this.report('E0321', e.span, '`try` in a verify block needs an `else` yielding the Bool result');
        return fallible.value;
      }
      if (e.else.name.text !== '_') this.ty.declTypes.set(this.defOf(e.else), fallible.error);
      this.expr(e.else.expr, BOOL);
      return fallible.value;
    }
    const outer = fn !== null && fn.ret !== null ? this.unwrapFallible(fn.ret) : null;
    if (outer === null) {
      this.report('E0321', e.span, fn === null || fn.ret === null ? '`try` is allowed only in a function returning Result or Option' : `\`try\` needs the enclosing function to return Result or Option, not ${this.show(fn.ret)}`);
      if (e.else) this.infer(e.else.expr);
      return fallible.value;
    }
    if (e.else === null) {
      if (fallible.option !== outer.option) {
        this.report('E0321', e.span, `\`try\` on ${fallible.option ? 'an Option' : 'a Result'} inside a function returning ${outer.option ? 'Option' : 'Result'} needs an \`else\``);
      } else if (!fallible.option && !sameBase(fallible.error, outer.error)) {
        this.report('E0321', e.span, `the error type ${this.show(fallible.error)} differs from the function's ${this.show(outer.error)}; add \`else e: ...\` to convert it`);
      }
      return fallible.value;
    }
    if (e.else.name.text !== '_') this.ty.declTypes.set(this.defOf(e.else), fallible.error);
    this.expr(e.else.expr, outer.error);
    return fallible.value;
  }

  private recover(e: A.Recover): Type {
    const last = e.body.stmts[e.body.stmts.length - 1];
    let value: Type = ERROR;
    this.inFn({ ret: null, assertion: false, recover: true, frame: this.fn?.frame ?? 0 }, () => {
      for (const s of e.body.stmts) {
        if (s === last && s.kind === 'ExprStmt') value = this.infer(s.expr);
        else this.stmt(s);
      }
    });
    if (last === undefined || last.kind !== 'ExprStmt') this.report('E0321', e.span, 'a `recover` block ends in the expression whose value it yields');
    return this.resultOf(value, this.panickedType());
  }

  private quantifier(e: A.Quantifier): Type {
    const binder = this.typeOf(e.type);
    this.ty.declTypes.set(this.defOf(e), binder);
    const base = stripRefinements(binder);
    if (e.domain === null) {
      const finite = (base.k === 'prim' && base.name === 'Bool') || (base.k === 'union' && this.variantsOf(this.t.def(base.def)).every((v) => this.fieldsOf(this.t.def(v)).length === 0));
      if (!finite && base.k !== 'error') this.report('E0338', e.span, `quantify over a range or a list: ${this.show(binder)} is not a finite type (§5.3)`);
    } else if (e.domain.kind === 'RangeDomain') {
      if (!sameBase(base, INT)) this.report('E0321', e.type.span, `a range binds an Int, not ${this.show(binder)}`);
      this.expr(e.domain.lo, INT);
      this.expr(e.domain.hi, INT);
    } else {
      // In a contract, a domain of type Result[List[T], E] or Option[List[T]] ranges over the
      // contained list and the formula holds vacuously for Err / None (§5.3).
      const domType = this.infer(e.domain.expr);
      const inner = this.unwrapFallible(domType);
      const elem = this.elementType(inner === null ? domType : inner.value, e.domain.expr.span);
      if (elem !== null) this.coerce(elem, binder, e.type.span, 'binder');
    }
    if (e.where) this.expr(e.where, BOOL);
    this.expr(e.body, BOOL);
    return BOOL;
  }

  private closure(e: A.Closure): Type {
    const params: FnParam[] = e.params.map((p) => {
      const type = this.typeOf(p.type);
      this.ty.declTypes.set(this.defOf(p), type);
      return { name: p.name.text, inout: p.inout, type };
    });
    const ret = this.typeOf(e.ret);
    const frame = (this.fn?.frame ?? 0) + 1;
    this.inFn({ ret, assertion: false, recover: false, frame }, () => {
      this.block(e.body);
      if (!sameBase(ret, UNIT) && !this.blockReturns(e.body)) this.report('E0331', e.span, `this closure returns ${this.show(ret)} but not every path ends in \`return\``);
    });
    return { k: 'fn', params, ret, effects: this.effectSetOf(e.effects) };
  }

  private fake(e: A.Fake, expected: Type | null): Type {
    for (const f of e.fields) this.infer(f.value);
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') return ERROR;
    const def = this.t.def(res.def);
    if (def.kind !== 'capability') {
      this.report('E0321', e.capability.span, `\`fake\` constructs a capability, not ${def.kind} \`${def.name}\``);
      return ERROR;
    }
    const exp = expected === null ? null : stripRefinements(expected);
    if (exp !== null && exp.k === 'capability' && exp.def === def.id) return exp;
    return this.instantiate(def, [], e.span);
  }

  private fieldAccess(e: A.FieldAccess): Type {
    const res = this.t.refs.get(e.id);
    if (res !== undefined) return this.resolvedValueType(res, e.span);
    const obj = this.infer(e.object);
    const s = stripRefinements(obj);
    if (s.k === 'error') return ERROR;
    if (s.k !== 'record') {
      this.report('E0325', e.name.span, `${this.show(obj)} has no fields${s.k === 'union' ? '; match on it to reach a variant\'s fields' : ''}`);
      return ERROR;
    }
    const def = this.t.def(s.def);
    const field = this.fieldsOf(def).find((f) => f.name === e.name.text);
    if (field === undefined) {
      this.report('E0325', e.name.span, `\`${def.name}\` has no field \`${e.name.text}\``);
      return ERROR;
    }
    return substitute(field.type, this.substOf(def, s.args));
  }

  /** The type of a resolved module member or companion function used as a value. */
  private resolvedValueType(res: NonNullable<ReturnType<ResolveTables['refs']['get']>>, span: Span): Type {
    let def: Def | null = null;
    if (res.k === 'def') def = this.t.def(res.def);
    else if (res.k === 'companion') def = this.t.def(res.fn);
    else if (res.k === 'iface-fn') {
      this.report('E0323', span, 'an interface function must be called');
      return ERROR;
    } else if (res.k === 'unit') return UNIT;
    else if (res.k === 'type-value') return TYPEINFO;
    if (def === null) return ERROR;
    if (def.kind === 'fn') {
      const sig = this.signatureOf(def);
      if (sig.tparams.length > 0) {
        this.report('E0324', span, `\`${def.name}\` is generic; a generic function cannot be used as a value`);
        return ERROR;
      }
      return { k: 'fn', params: sig.params, ret: sig.ret, effects: sig.effects };
    }
    if (def.kind === 'const') {
      const t = this.ty.declTypes.get(def.id);
      if (t !== undefined) return t;
      const node = this.nodeOf(def, 'ConstDecl');
      const ct = this.typeOf(node.type);
      this.ty.declTypes.set(def.id, ct);
      return ct;
    }
    return this.ty.declTypes.get(def.id) ?? ERROR;
  }

  private call(e: A.Call, expected: Type | null): Type {
    const res = this.t.refs.get(e.callee.id);
    if (res !== undefined && (res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn')) {
      const fnDef = this.t.def(res.k === 'def' ? res.def : res.fn);
      if (fnDef.kind === 'fn' || fnDef.kind === 'iface-fn') {
        this.ty.exprTypes.set(e.callee.id, ERROR);
        return this.callSignature(e, fnDef, res.k === 'iface-fn' ? res.iface : null, expected);
      }
    }
    const calleeType = this.infer(e.callee);
    const s = stripRefinements(calleeType);
    if (s.k === 'error') {
      for (const a of e.args) this.infer(a.value);
      return ERROR;
    }
    if (s.k !== 'fn') {
      this.report('E0323', e.callee.span, `${this.show(calleeType)} is not a function`);
      for (const a of e.args) this.infer(a.value);
      return ERROR;
    }
    if (e.targs !== null) this.report('E0324', e.span, 'a function value takes no type arguments');
    this.matchNamed(e.args, s.params, new Map(), [], e.span, 'this function');
    return s.ret;
  }

  private callSignature(e: A.Call, fnDef: Def, iface: DefId | null, expected: Type | null): Type {
    const sig = this.signatureOf(fnDef);
    const tparams: TParamInfo[] = [...sig.tparams];
    let ifaceParam: DefId | null = null;
    if (iface !== null) {
      ifaceParam = this.ifaceParam(this.t.def(iface));
      tparams.push({ k: 'type', def: ifaceParam, bound: iface });
    }
    const subst: Subst = new Map();
    const tvars = new Set(tparams.map((p) => p.def));
    if (e.targs !== null) {
      let positional = 0;
      for (const a of e.targs) {
        let p: TParamInfo | undefined;
        if (a.label !== null) {
          p = tparams.find((x) => this.t.def(x.def).name === a.label?.text);
          if (p === undefined) this.report('E0324', a.span, `\`${fnDef.name}\` has no type parameter \`${a.label.text}\``);
        } else {
          p = tparams[positional];
          positional += 1;
          if (p === undefined) this.report('E0324', a.span, `\`${fnDef.name}\` takes ${tparams.length} type argument${tparams.length === 1 ? '' : 's'}`);
        }
        if (p === undefined) continue;
        const v = this.typeArgOf(a, p);
        if (v !== null) subst.set(p.def, v);
      }
    }
    if (expected !== null) this.unify(sig.ret, expected, subst, tvars);
    this.matchNamed(e.args, sig.params, subst, tparams, e.span, `\`${fnDef.name}\``);
    for (const p of tparams) {
      if (subst.has(p.def)) continue;
      if (p.k === 'effect') {
        // An effect parameter no argument mentions is instantiated empty.
        subst.set(p.def, { k: 'effects', effects: EffectSet.empty() });
        continue;
      }
      this.report('E0324', e.span, `cannot determine type argument \`${this.t.def(p.def).name}\` of \`${fnDef.name}\`; pass it explicitly`);
      subst.set(p.def, p.k === 'type' ? { k: 'type', type: ERROR } : { k: 'const', value: { k: 'unit' } });
    }
    for (const p of tparams) {
      if (p.k !== 'type' || p.bound === null) continue;
      const b = subst.get(p.def);
      if (b !== undefined && b.k === 'type' && !this.implemented(p.bound, b.type)) {
        this.report('E0333', e.span, `${this.show(b.type)} does not implement \`${this.t.def(p.bound).name}\` (required by \`${this.t.def(p.def).name}\` of \`${fnDef.name}\`)`);
      }
    }
    // Parameters used as indices in the return type are replaced by the constant passed for them.
    const indexSubst: Subst = new Map();
    sig.paramDefs.forEach((pd, i) => {
      const p = sig.params[i];
      const a = e.args.find((x) => x.name.text === p?.name);
      if (a === undefined) return;
      const v = this.evalConst(a.value);
      if (v !== null) indexSubst.set(pd, { k: 'const', value: v });
      else if (mentionsSym(sig.ret, pd)) {
        this.report('E0337', a.value.span, `\`${p?.name ?? ''}\` is used as a type index in the result; pass a literal, a \`const\` or a parameter`);
        indexSubst.set(pd, { k: 'const', value: { k: 'error' } });
      }
    });
    const ret = substitute(substitute(sig.ret, subst), indexSubst);
    this.ty.instantiations.set(e.id, tparams.map((p) => subst.get(p.def) ?? { k: 'type', type: ERROR }));
    this.ty.indexBindings.set(e.id, indexSubst);
    this.ty.effectBindings.set(e.id, new Map(tparams.flatMap((p) => {
      const b = subst.get(p.def);
      return p.k === 'effect' && b !== undefined && b.k === 'effects' ? [[p.def, b.effects] as const] : [];
    })));
    return ret;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNumeric(t: Type): boolean {
  const s = stripRefinements(t);
  return s.k === 'prim' && (s.name === 'Int' || s.name === 'Float' || s.name === 'Duration');
}

function sameRefinement(a: Type, b: Type): boolean {
  return a.k === 'refined' && b.k === 'refined' && a.pred === b.pred;
}

function describeBinding(def: Def): string {
  switch (def.kind) {
    case 'let':
      return 'a `let` binding';
    case 'param':
      return 'a parameter';
    case 'for':
      return 'a loop variable';
    case 'const':
      return 'a constant';
    default:
      return `a ${def.kind}`;
  }
}

function exprText(e: A.Expr): string {
  return e.kind === 'Name' ? e.name.text : '…';
}

/** True iff `t` mentions a type variable in `tvars` that `subst` has not bound. */
function hasUnbound(t: Type, tvars: ReadonlySet<DefId>, subst: Subst): boolean {
  switch (t.k) {
    case 'param':
      return tvars.has(t.def) && !subst.has(t.def);
    case 'refined':
      return hasUnbound(t.base, tvars, subst);
    case 'record':
    case 'union':
    case 'opaque':
    case 'capability':
      return t.args.some((a) => (a.k === 'type' ? hasUnbound(a.type, tvars, subst) : a.k === 'const' && a.value.k === 'sym' && tvars.has(a.value.def) && !subst.has(a.value.def)));
    case 'fn':
      return t.params.some((p) => hasUnbound(p.type, tvars, subst)) || hasUnbound(t.ret, tvars, subst) || t.effects.values().some((e) => e.k === 'param' && tvars.has(e.def) && !subst.has(e.def));
    default:
      return false;
  }
}

/** True iff `t` uses parameter `def` as a type index. */
function mentionsSym(t: Type, def: DefId): boolean {
  switch (t.k) {
    case 'refined':
      return mentionsSym(t.base, def);
    case 'record':
    case 'union':
    case 'opaque':
    case 'capability':
      return t.args.some((a) => (a.k === 'type' ? mentionsSym(a.type, def) : a.k === 'const' && a.value.k === 'sym' && a.value.def === def));
    case 'fn':
      return t.params.some((p) => mentionsSym(p.type, def)) || mentionsSym(t.ret, def);
    default:
      return false;
  }
}

