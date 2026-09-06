/**
 * Specialisation for the native target (impl spec §6.1; docs/CHANGES.md
 * item 174): a native slot carries no type, so generic code is compiled once
 * per instantiation. After the shared lowering, every call to a generic
 * function is retargeted to a copy of that function specialised to the
 * call's type arguments, and the copy's own calls are specialised in turn,
 * until the set is closed (finite by spec §3.6: polymorphic recursion is
 * refused). Inside a copy the type parameters are concrete, so equality,
 * `old(...)`, `TypeInfo` and `Dict` keys resolve to the concrete type.
 *
 * A copy is named `f[T1, T2]` after its type arguments (const arguments are
 * values, not specialised; effect arguments are erased). Generic functions
 * themselves are dropped from the modules: nothing calls them after this.
 * Copies are appended to the module that declared the function, in
 * discovery order, which the JavaScript target never sees: this step runs
 * only inside `emitNative`.
 */
import type { Context } from '../context.js';
import type { DefId } from '../resolve/defs.js';
import { substitute, typeToString, type Type, type TypeArg } from '../types/type.js';
import type { Signature } from '../types/tables.js';
import type { IrArm, IrBlock, IrDecoder, IrDomain, IrExpr, IrFn, IrGen, IrItem, IrModule, IrStmt, IrTests } from './ir.js';

type Subst = ReadonlyMap<DefId, TypeArg>;

interface Pending {
  readonly module: IrModule;
  readonly fn: IrFn;
  readonly subst: Subst;
  readonly name: string;
}

/** Whether a function has type parameters (not const or effect parameters). Effects: none. */
function isGeneric(sig: Signature): boolean {
  return sig.tparams.some((p) => p.k === 'type');
}

/**
 * Specialises every generic function reached from the modules' functions,
 * constants and examples.
 * Preconditions: `modules` are the shared lowering's output for the whole program.
 * Effects: none (returns new modules).
 */
export function specialise(ctx: Context, modules: readonly IrModule[]): IrModule[] {
  return new Specialiser(ctx, modules).run();
}

class Specialiser {
  /** Generic functions by emitted name (`module.name`). */
  private readonly generic = new Map<string, { readonly module: IrModule; readonly fn: IrFn }>();
  /** Specialisations made or queued, by their emitted name. */
  private readonly seen = new Set<string>();
  private readonly queue: Pending[] = [];
  /** Specialisations per module name, in discovery order. */
  private readonly added = new Map<string, IrFn[]>();

  constructor(
    private readonly ctx: Context,
    private readonly modules: readonly IrModule[],
  ) {}

  run(): IrModule[] {
    for (const m of this.modules) {
      for (const item of m.items) {
        if (item.k === 'fn' && item.body !== null && item.intrinsic === null && isGeneric(item.sig)) this.generic.set(this.key(m, item.name), { module: m, fn: item });
      }
    }
    const empty: Subst = new Map();
    // Rewrite what is not generic first: it discovers the instantiations the program uses.
    const rewritten = new Map<string, { items: IrItem[]; tests: IrTests | null }>();
    for (const m of this.modules) {
      const items: IrItem[] = [];
      for (const item of m.items) {
        if (item.k === 'fn') {
          if (this.generic.has(this.key(m, item.name))) continue;
          items.push(this.fn(item, empty, item.name));
        } else if (item.k === 'impl') {
          items.push({ ...item, fns: item.fns.map((f) => this.fn(f, empty, f.name)), entries: item.entries.map((e) => ({ name: e.name, fn: this.fn(e.fn, empty, e.fn.name) })) });
        } else if (item.k === 'const') {
          items.push({ ...item, value: this.expr(item.value, empty) });
        } else {
          items.push(item);
        }
      }
      const tests: IrTests | null =
        m.tests === null
          ? null
          : {
              examples: m.tests.examples.map((ex) => ({ name: ex.name, body: this.block(ex.body, empty) })),
              properties: m.tests.properties.map((p) => ({ label: p.label, params: p.params.map((q) => ({ name: q.name, gen: this.gen(q.gen, empty) })), body: this.block(p.body, empty) })),
            };
      rewritten.set(m.module.name, { items, tests });
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) break;
      const copy = this.fn(next.fn, next.subst, next.name);
      const list = this.added.get(next.module.module.name) ?? [];
      list.push(copy);
      this.added.set(next.module.module.name, list);
    }
    return this.modules.map((m) => {
      const r = rewritten.get(m.module.name);
      const items = r === undefined ? [...m.items] : r.items;
      return { ...m, items: [...items, ...(this.added.get(m.module.name) ?? [])], tests: r === undefined ? m.tests : r.tests };
    });
  }

  private key(m: IrModule, name: string): string {
    return `${m.module.name}.${name}`;
  }

  /** The specialised name for `fn` at `targs`, queueing the copy on first sight. */
  private instantiate(module: IrModule, fn: IrFn, targs: readonly TypeArg[]): string {
    const subst = new Map<DefId, TypeArg>();
    const shown: string[] = [];
    fn.sig.tparams.forEach((p, i) => {
      const a = targs[i];
      if (p.k !== 'type' || a === undefined || a.k !== 'type') return;
      subst.set(p.def, a);
      shown.push(typeToString(a.type, this.ctx.resolve));
    });
    const name = `${fn.name}[${shown.join(', ')}]`;
    const k = this.key(module, name);
    if (!this.seen.has(k)) {
      this.seen.add(k);
      this.queue.push({ module, fn, subst, name });
    }
    return name;
  }

  private type(t: Type, s: Subst): Type {
    return s.size === 0 ? t : substitute(t, s);
  }

  private fnType(t: Extract<Type, { k: 'fn' }>, s: Subst): Extract<Type, { k: 'fn' }> {
    const out = this.type(t, s);
    return out.k === 'fn' ? out : t;
  }

  private targs(targs: readonly TypeArg[], s: Subst): TypeArg[] {
    return targs.map((a) => (a.k === 'type' ? { k: 'type', type: this.type(a.type, s) } : a));
  }

  private sig(sig: Signature, s: Subst): Signature {
    if (s.size === 0) return sig;
    return { ...sig, params: sig.params.map((p) => ({ ...p, type: this.type(p.type, s) })), ret: this.type(sig.ret, s) };
  }

  private fn(f: IrFn, s: Subst, name: string): IrFn {
    return {
      ...f,
      name,
      sig: this.sig(f.sig, s),
      constParams: f.constParams.map((c) => ({ ...c, type: this.type(c.type, s) })),
      params: f.params.map((p) => ({ ...p, type: this.type(p.type, s) })),
      ret: this.type(f.ret, s),
      entry: this.block(f.entry, s),
      body: f.body === null ? null : this.block(f.body, s),
    };
  }

  private block(b: IrBlock, s: Subst): IrStmt[] {
    return b.map((st) => this.stmt(st, s));
  }

  private stmt(st: IrStmt, s: Subst): IrStmt {
    switch (st.k) {
      case 'let':
        return { ...st, type: this.type(st.type, s), value: this.expr(st.value, s) };
      case 'assign':
        return { ...st, type: this.type(st.type, s), value: this.expr(st.value, s) };
      case 'return':
        return { ...st, value: this.expr(st.value, s) };
      case 'if':
        return { ...st, cond: this.expr(st.cond, s), then: this.block(st.then, s), else: st.else === null ? null : this.block(st.else, s) };
      case 'match':
        return { ...st, type: this.type(st.type, s), scrutinee: this.expr(st.scrutinee, s), arms: st.arms.map((a) => this.arm(a, s)) };
      case 'loop':
        return { ...st, cond: this.expr(st.cond, s), body: this.block(st.body, s) };
      case 'for-range':
        return { ...st, lo: this.expr(st.lo, s), hi: this.expr(st.hi, s), body: this.block(st.body, s) };
      case 'for-each':
        return { ...st, type: this.type(st.type, s), list: this.expr(st.list, s), body: this.block(st.body, s) };
      case 'check':
        return { ...st, cond: this.expr(st.cond, s) };
      case 'assert':
        return { ...st, cond: this.expr(st.cond, s) };
      case 'expr':
        return { ...st, expr: this.expr(st.expr, s) };
      case 'call-inout':
        return {
          ...st,
          result: st.result === null ? null : { name: st.result.name, type: this.type(st.result.type, s) },
          call: this.expr(st.call, s),
          targets: st.targets.map((t) => ({ name: t.name, type: this.type(t.type, s) })),
        };
      case 'unreachable':
      case 'comment':
        return st;
      case 'reject':
        return { ...st, cond: this.expr(st.cond, s) };
    }
  }

  private arm(a: IrArm, s: Subst): IrArm {
    return {
      test: a.test === null ? null : this.expr(a.test, s),
      bindings: a.bindings.map((b) => ({ name: b.name, type: this.type(b.type, s), value: this.expr(b.value, s) })),
      guard: a.guard === null ? null : this.expr(a.guard, s),
      body: this.block(a.body, s),
    };
  }

  private decoder(d: IrDecoder, s: Subst): IrDecoder {
    return { ...d, type: this.type(d.type, s), checks: this.block(d.checks, s) };
  }

  private domain(d: IrDomain, s: Subst): IrDomain {
    switch (d.k) {
      case 'range':
        return { k: 'range', lo: this.expr(d.lo, s), hi: this.expr(d.hi, s) };
      case 'list':
        return { k: 'list', expr: this.expr(d.expr, s) };
      case 'oklist':
        return { k: 'oklist', expr: this.expr(d.expr, s) };
      case 'bools':
        return d;
    }
  }

  private gen(g: IrGen, s: Subst): IrGen {
    return { ...g, filters: g.filters.map((f) => ({ it: f.it, cond: this.expr(f.cond, s) })) };
  }

  private fields(fields: readonly { readonly name: string; readonly value: IrExpr }[], s: Subst): { readonly name: string; readonly value: IrExpr }[] {
    return fields.map((f) => ({ name: f.name, value: this.expr(f.value, s) }));
  }

  private expr(e: IrExpr, s: Subst): IrExpr {
    switch (e.k) {
      case 'int':
      case 'float':
      case 'text':
      case 'bool':
      case 'unit':
      case 'typeinfo':
      case 'const':
      case 'value':
      case 'dict-param':
        return e;
      case 'local':
        return { ...e, type: this.type(e.type, s) };
      case 'global':
        return { ...e, type: this.type(e.type, s) };
      case 'fnref':
        return { ...e, sig: this.sig(e.sig, s) };
      case 'call': {
        const targs = this.targs(e.targs, s);
        let target = e.target;
        if (target.k === 'fn') {
          const g = this.generic.get(`${this.ctx.resolve.moduleOf(target.def.module).name}.${target.name}`);
          if (g !== undefined) target = { k: 'fn', def: target.def, name: this.instantiate(g.module, g.fn, targs) };
        } else {
          target = { k: 'dict', dict: this.expr(target.dict, s), name: target.name };
        }
        const base = { ...e, targs, target, sig: this.sig(e.sig, s), dicts: e.dicts.map((d) => this.expr(d, s)), consts: e.consts.map((c) => this.expr(c, s)), args: e.args.map((a) => this.expr(a, s)), type: this.type(e.type, s) };
        return e.decoder === undefined ? base : { ...base, decoder: this.decoder(e.decoder, s) };
      }
      case 'call-value':
        return { ...e, callee: this.expr(e.callee, s), fnType: this.fnType(e.fnType, s), args: e.args.map((a) => this.expr(a, s)), type: this.type(e.type, s) };
      case 'record':
      case 'variant':
        return { ...e, type: this.type(e.type, s), fields: this.fields(e.fields, s) };
      case 'update':
        return { ...e, base: this.expr(e.base, s), type: this.type(e.type, s), fields: this.fields(e.fields, s) };
      case 'field':
        return { ...e, object: this.expr(e.object, s), type: this.type(e.type, s) };
      case 'list':
        return { ...e, elems: e.elems.map((x) => this.expr(x, s)), type: this.type(e.type, s) };
      case 'concat':
        return { ...e, left: this.expr(e.left, s), right: this.expr(e.right, s), type: this.type(e.type, s) };
      case 'intop':
      case 'floatop':
      case 'cmp':
      case 'implies':
        return { ...e, left: this.expr(e.left, s), right: this.expr(e.right, s) };
      case 'eq':
        return { ...e, left: this.expr(e.left, s), right: this.expr(e.right, s), type: this.type(e.type, s) };
      case 'neg':
      case 'not':
        return { ...e, operand: this.expr(e.operand, s) };
      case 'and':
      case 'or':
        return { ...e, operands: e.operands.map((x) => this.expr(x, s)) };
      case 'is-variant':
        return { ...e, subject: this.expr(e.subject, s), type: this.type(e.type, s) };
      case 'try':
        return {
          ...e,
          operand: this.expr(e.operand, s),
          else: e.else === null ? null : { name: e.else.name, errorType: this.type(e.else.errorType, s), value: this.expr(e.else.value, s) },
          type: this.type(e.type, s),
        };
      case 'recover':
        return { ...e, body: this.block(e.body, s), value: this.expr(e.value, s), type: this.type(e.type, s) };
      case 'quantifier':
        return { ...e, binder: this.type(e.binder, s), domain: this.domain(e.domain, s), where: e.where === null ? null : this.expr(e.where, s), body: this.expr(e.body, s) };
      case 'closure':
        return { ...e, params: e.params.map((p) => ({ ...p, type: this.type(p.type, s) })), fnType: e.fnType === null ? null : this.fnType(e.fnType, s), entry: this.block(e.entry, s), body: this.block(e.body, s) };
      case 'fake':
        return { ...e, fields: this.fields(e.fields, s), type: this.type(e.type, s) };
      case 'checked':
        return { ...e, value: this.expr(e.value, s), type: this.type(e.type, s), checks: this.block(e.checks, s) };
      case 'dict':
        return { ...e, target: this.type(e.target, s) };
      case 'snapshot':
        return { ...e, value: this.expr(e.value, s), type: this.type(e.type, s) };
    }
  }
}
