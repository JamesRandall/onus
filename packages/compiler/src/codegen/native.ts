/**
 * The native emitter (impl spec §6, M11; language spec §19): renders the
 * target-neutral form of `ir.ts` as LLVM IR text for `clang` to compile and
 * link against the C runtime in `packages/runtime/native/`.
 *
 * Representation:
 *   - `Int`/`Duration` are `i64`, `Float` is `double`, `Bool` is `i1`;
 *   - everything else is a pointer: `Text` to `{ len, bytes }`, records to
 *     an array of 64-bit slots, variants to `{ tag, slots... }`, lists and
 *     grids to runtime objects. A slot holds any value bit-for-bit, so
 *     generic code (type parameters, intrinsics) moves slots and the caller
 *     converts at the boundary;
 *   - `inout` parameters are pointers to the caller's slot;
 *   - a `proved` obligation emits nothing; a `checked` one is a branch to
 *     `onus_panic`; `Int` arithmetic uses the overflow intrinsics; `try` is
 *     a branch that returns the error from the enclosing function.
 *
 * Programs reaching a construct outside the v0 native subset are refused
 * with `E0800 primitive unavailable on target` (§19.1): closures and
 * function values, interfaces, quantifiers at runtime, `recover`, `fake`,
 * `TypeInfo`, `old(...)`, structural equality on aggregates, `Map`, `Bytes`,
 * `sql`, and `Text` operations that need grapheme tables.
 */
import type { ClaimTables } from '../claims/tables.js';
import type { Value } from '../consteval/values.js';
import type { Context } from '../context.js';
import type { Def, DefId, ResolveTables } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type { TypeTables } from '../types/tables.js';
import { stripRefinements, substitute, typeToString, type Type, type TypeArg } from '../types/type.js';
import type { IrBlock, IrDecoder, IrExpr, IrFn, IrModule, IrStmt, ObRef } from './ir.js';

/** A construct the native backend does not compile in v0, at the definition that uses it. */
export interface Unsupported {
  readonly def: string;
  readonly span: Span;
  readonly what: string;
}

export interface NativeProgram {
  readonly ll: string;
  readonly unsupported: readonly Unsupported[];
  /** The entry module's `main`, when it has one. */
  readonly hasMain: boolean;
  /** Example names, module-qualified, in run order. */
  readonly examples: readonly string[];
}

type LlType = 'i64' | 'double' | 'i1' | 'ptr';

interface Val {
  readonly v: string;
  readonly t: LlType;
}

class UnsupportedError extends Error {
  constructor(readonly what: string) {
    super(what);
  }
}

/**
 * Emits one program: every lowered module, an entry `main`, and an examples
 * runner selected by `--onus-examples`.
 * Effects: none (returns text).
 */
export interface NativeOptions {
  /** `libpq` is available: `std.sql` compiles; otherwise it is E0800. */
  readonly sql: boolean;
}

export function emitNative(ctx: Context, modules: readonly IrModule[], entry: IrModule | null, opts: NativeOptions = { sql: true }): NativeProgram {
  return new NativeEmitter(ctx, modules, entry, opts).run();
}

class NativeEmitter {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private readonly claims: ClaimTables;
  /** The `std.host.js` claim: functions carrying it run only on the JavaScript host (§19.2). */
  private readonly hostJs: DefId | null;
  private readonly globals: string[] = [];
  private readonly strings = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  /** A compile-time aggregate value (a `const` list, record or variant) built at the point of use. */
  private constValue(v: Value): Val {
    switch (v.k) {
      case 'int':
      case 'duration':
        return { v: String(Math.trunc(v.v)), t: 'i64' };
      case 'bool':
        return { v: v.v ? '1' : '0', t: 'i1' };
      case 'float':
        return { v: doubleLiteral(v.v), t: 'double' };
      case 'text':
        return { v: this.textConst(v.v), t: 'ptr' };
      case 'unit':
        return { v: '0', t: 'i64' };
      case 'list': {
        const list = this.tmp();
        this.emit(`${list} = call ptr @onus_rt_list_new(i64 ${v.items.length})`);
        v.items.forEach((x, i) => this.emit(`call void @onus_rt_list_set(ptr ${list}, i64 ${i}, i64 ${this.toSlot(this.constValue(x))})`));
        return { v: list, t: 'ptr' };
      }
      case 'record': {
        const fields = this.ty.fields.get(v.def) ?? [];
        const obj = this.tmp();
        this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * Math.max(1, fields.length)})`);
        fields.forEach((f, i) => {
          const x = v.fields.get(f.name);
          if (x !== undefined) this.storeSlot(obj, i, this.toSlot(this.constValue(x)));
        });
        return { v: obj, t: 'ptr' };
      }
      case 'variant': {
        const union = this.t.def(v.def).parent;
        const fields = this.ty.fields.get(v.def) ?? [];
        const obj = this.tmp();
        this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * (1 + fields.length)})`);
        this.storeSlot(obj, 0, String(union === null ? 0 : this.variantIndex(union, v.def)));
        fields.forEach((f, i) => {
          const x = v.fields.get(f.name);
          if (x !== undefined) this.storeSlot(obj, 1 + i, this.toSlot(this.constValue(x)));
        });
        return { v: obj, t: 'ptr' };
      }
      case 'bytes':
      case 'typeinfo':
        throw new UnsupportedError(`\`${v.k}\` compile-time values`);
    }
  }

  /** Constants emitted as lazily filled slots (aggregates and computed values), by definition. */
  private readonly lazyConsts = new Set<DefId>();
  /** Whether a constant will be emitted lazily: its value is not a scalar literal. */
  private aggregateConst(def: DefId): boolean {
    for (const m of this.modules) {
      for (const item of m.items) {
        if (item.k !== 'const' || item.def.id !== def) continue;
        const v = item.value;
        return !(v.k === 'value' && (v.value.k === 'int' || v.value.k === 'duration' || v.value.k === 'float' || v.value.k === 'bool' || v.value.k === 'text'));
      }
    }
    return false;
  }
  /** Structural comparers generated so far, by type text (see `eqFn`). */
  private readonly eqFns = new Map<string, string>();
  private readonly declared = new Set<string>();
  private readonly fns: string[] = [];
  private readonly unsupported: Unsupported[] = [];
  private readonly examples: { name: string; fn: string }[] = [];
  private counter = 0;
  // Per-function state.
  private lines: string[] = [];
  private allocas: string[] = [];
  private locals = new Map<string, { ptr: string; t: LlType; type: Type }>();
  private block = 'entry';
  private terminated = false;
  private fnRetLl: LlType | 'void' = 'i64';

  constructor(
    ctx: Context,
    private readonly modules: readonly IrModule[],
    private readonly entry: IrModule | null,
    private readonly opts: NativeOptions,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
    this.claims = ctx.claims;
    const host = ctx.resolve.modules.find((m) => m.name === 'std.host');
    this.hostJs = host === undefined ? null : (ctx.resolve.membersOf(host.id).claims.get('js') ?? null);
  }

  run(): NativeProgram {
    // Only what the program reaches is compiled, so an unsupported construct in an unreached library function costs nothing (§19.1).
    const reachable = this.reachable();
    for (const m of this.modules) {
      for (const item of m.items) {
        if (item.k === 'fn') {
          if (reachable.has(item.def.id)) this.fnItem(m, item);
        } else if (item.k === 'impl') {
          for (const f of item.fns) if (reachable.has(f.def.id)) this.fnItem(m, f);
        } else if (item.k === 'const') {
          if (reachable.has(item.def.id)) this.constItem(m, item.def, item.type, item.value);
        }
      }
      if (m.tests !== null && !m.module.isStd) {
        for (const ex of m.tests.examples) this.exampleFn(m, ex.name, ex.body);
      }
    }
    const hasMain = this.entry !== null && this.entry.main !== null;
    this.mainFn();
    const head = [
      '; Generated by onus (native target). Do not edit.',
      ...this.globals,
      ...[...this.declared].sort(),
      'declare void @onus_panic(ptr, ptr, ptr, ptr)',
      'declare void @onus_unreachable()',
      'declare ptr @onus_alloc(i64)',
      'declare ptr @onus_rt_text_concat(ptr, ptr)',
      'declare i1 @onus_rt_text_eq(ptr, ptr)',
      'declare ptr @onus_rt_list_new(i64)',
      'declare i64 @onus_rt_list_len(ptr)',
      'declare i64 @onus_rt_list_get(ptr, i64)',
      'declare void @onus_rt_list_set(ptr, i64, i64)',
      'declare ptr @onus_rt_list_concat(ptr, ptr)',
      'declare ptr @onus_args(i32, ptr)',
      'declare i32 @onus_start(i32, ptr)',
      'declare i32 @onus_finish(ptr)',
      'declare void @onus_report_example(ptr, i1)',
      'declare i32 @onus_examples_done()',
      'declare ptr @onus_root(ptr)',
      'declare { i64, i1 } @llvm.sadd.with.overflow.i64(i64, i64)',
      'declare { i64, i1 } @llvm.ssub.with.overflow.i64(i64, i64)',
      'declare { i64, i1 } @llvm.smul.with.overflow.i64(i64, i64)',
      '',
    ];
    return { ll: `${head.join('\n')}\n${this.fns.join('\n')}`, unsupported: this.unsupported, hasMain, examples: this.examples.map((e) => e.name) };
  }

  /** Definitions reachable from the entry's `main` and the non-library examples, over calls, function references and constants. */
  private reachable(): Set<DefId> {
    const byDef = new Map<DefId, IrFn>();
    const consts = new Map<DefId, IrExpr>();
    for (const m of this.modules) {
      for (const item of m.items) {
        if (item.k === 'fn') byDef.set(item.def.id, item);
        else if (item.k === 'impl') for (const f of item.fns) byDef.set(f.def.id, f);
        else if (item.k === 'const') consts.set(item.def.id, item.value);
      }
    }
    const seen = new Set<DefId>();
    const queue: DefId[] = [];
    const visitBlock = (b: IrBlock): void => {
      for (const s of b) visitStmt(s);
    };
    const visitStmt = (s: IrStmt): void => {
      switch (s.k) {
        case 'let':
        case 'assign':
        case 'return':
          visitExpr(s.value);
          return;
        case 'expr':
          visitExpr(s.expr);
          return;
        case 'if':
          visitExpr(s.cond);
          visitBlock(s.then);
          if (s.else !== null) visitBlock(s.else);
          return;
        case 'match':
          visitExpr(s.scrutinee);
          for (const a of s.arms) {
            if (a.test !== null) visitExpr(a.test);
            for (const b of a.bindings) visitExpr(b.value);
            if (a.guard !== null) visitExpr(a.guard);
            visitBlock(a.body);
          }
          return;
        case 'loop':
          visitExpr(s.cond);
          visitBlock(s.body);
          return;
        case 'for-range':
          visitExpr(s.lo);
          visitExpr(s.hi);
          visitBlock(s.body);
          return;
        case 'for-each':
          visitExpr(s.list);
          visitBlock(s.body);
          return;
        case 'check':
        case 'assert':
          visitExpr(s.cond);
          return;
        case 'call-inout':
          visitExpr(s.call);
          return;
        case 'unreachable':
        case 'comment':
          return;
      }
    };
    const visitExpr = (e: IrExpr): void => {
      switch (e.k) {
        case 'call':
          if (e.target.k === 'fn') queue.push(e.target.def.id);
          else visitExpr(e.target.dict);
          for (const x of [...e.dicts, ...e.consts, ...e.args]) visitExpr(x);
          return;
        case 'fnref':
          queue.push(e.def.id);
          return;
        case 'global':
          queue.push(e.def.id);
          return;
        case 'call-value':
          visitExpr(e.callee);
          for (const x of e.args) visitExpr(x);
          return;
        case 'record':
        case 'variant':
        case 'fake':
          for (const f of e.fields) visitExpr(f.value);
          return;
        case 'update':
          visitExpr(e.base);
          for (const f of e.fields) visitExpr(f.value);
          return;
        case 'field':
        case 'not':
        case 'snapshot':
          visitExpr(e.k === 'field' ? e.object : e.k === 'not' ? e.operand : e.value);
          return;
        case 'list':
        case 'and':
        case 'or':
          for (const x of e.k === 'list' ? e.elems : e.operands) visitExpr(x);
          return;
        case 'concat':
        case 'intop':
        case 'floatop':
        case 'cmp':
        case 'eq':
        case 'implies':
          visitExpr(e.left);
          visitExpr(e.right);
          return;
        case 'neg':
          visitExpr(e.operand);
          return;
        case 'is-variant':
          visitExpr(e.subject);
          return;
        case 'try':
          visitExpr(e.operand);
          if (e.else !== null) visitExpr(e.else.value);
          return;
        case 'recover':
          visitBlock(e.body);
          visitExpr(e.value);
          return;
        case 'quantifier':
          if (e.domain.k === 'range') {
            visitExpr(e.domain.lo);
            visitExpr(e.domain.hi);
          } else if (e.domain.k !== 'bools') visitExpr(e.domain.expr);
          if (e.where !== null) visitExpr(e.where);
          visitExpr(e.body);
          return;
        case 'closure':
          visitBlock(e.entry);
          visitBlock(e.body);
          return;
        case 'checked':
          visitExpr(e.value);
          visitBlock(e.checks);
          return;
        default:
          return;
      }
    };
    if (this.entry !== null && this.entry.main !== null) {
      const main = this.entry.items.find((i): i is IrFn => i.k === 'fn' && i.def.name === 'main');
      if (main !== undefined) queue.push(main.def.id);
    }
    for (const m of this.modules) if (m.tests !== null && !m.module.isStd) for (const ex of m.tests.examples) visitBlock(ex.body);
    while (queue.length > 0) {
      const d = queue.pop();
      if (d === undefined || seen.has(d)) continue;
      seen.add(d);
      const fn = byDef.get(d);
      if (fn !== undefined) {
        visitBlock(fn.entry);
        if (fn.body !== null) visitBlock(fn.body);
      }
      const c = consts.get(d);
      if (c !== undefined) visitExpr(c);
    }
    return seen;
  }

  /** A function carrying `host.js` runs only on the JavaScript host (§19.2); `std.sql` needs `libpq`. */
  private requireNative(def: Def): void {
    if (this.hostJs !== null && this.claims.carries(def.id, this.hostJs)) {
      throw new UnsupportedError(`\`${this.t.qualifiedName(def.id)}\`, which claims \`host.js\` and runs only on the JavaScript host`);
    }
    if (!this.opts.sql && def.intrinsic && this.t.qualifiedName(def.id).startsWith('std.sql.')) {
      throw new UnsupportedError(`\`${this.t.qualifiedName(def.id)}\`, which needs libpq, not found on this machine`);
    }
  }

  /** Emits a nested function while another is being emitted. */
  private nested(emit: () => void): void {
    const saved = { lines: this.lines, allocas: this.allocas, locals: this.locals, block: this.block, terminated: this.terminated, fnRetLl: this.fnRetLl };
    this.beginFn();
    try {
      emit();
    } finally {
      this.lines = saved.lines;
      this.allocas = saved.allocas;
      this.locals = saved.locals;
      this.block = saved.block;
      this.terminated = saved.terminated;
      this.fnRetLl = saved.fnRetLl;
    }
  }

  /** A row decoder as `@decode$N(ptr raw, ptr column) -> ptr`: the record, or null with the rejected column's name stored. */
  private decoderFn(d: IrDecoder): string {
    const name = `@"decode$${(this.counter += 1)}"`;
    this.declare('declare i64 @onus_sql_column(ptr, ptr, i64)');
    this.nested(() => {
      this.fnRetLl = 'ptr';
      const rec = stripRefinements(d.type);
      if (rec.k !== 'record') throw new UnsupportedError('a row decoder for a non-record');
      const fields = this.ty.fields.get(rec.def) ?? [];
      const obj = this.tmp();
      this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * Math.max(1, fields.length)})`);
      for (const f of d.fields) {
        const idx = fields.findIndex((x) => x.name === f.name);
        const kind = { Int: 0, Duration: 0, Text: 1, Float: 2, Bool: 3 }[f.kind] ?? 4;
        const slot = this.tmp();
        this.emit(`${slot} = call i64 @onus_sql_column(ptr %raw, ptr ${this.textConst(f.name)}, i64 ${kind})`);
        this.storeSlot(obj, idx < 0 ? 0 : idx, slot);
      }
      const ptr = this.alloca(d.it, 'ptr', d.type);
      this.emit(`store ptr ${obj}, ptr ${ptr}`);
      this.blockStmts(d.checks);
      if (!this.terminated) this.emit(`ret ptr ${obj}`);
      this.finishFn(`define ptr ${name}(ptr %raw, ptr %column) {`, '');
    });
    return name;
  }

  // -------------------------------------------------------------------------
  // Names, types, constants
  // -------------------------------------------------------------------------

  private fnName(module: string, name: string): string {
    return `@"${module}.${name}"`;
  }

  private tmp(): string {
    this.counter += 1;
    return `%t${this.counter}`;
  }

  private label(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  private ll(type: Type): LlType {
    const s = stripRefinements(type);
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Int':
          case 'Duration':
          case 'Unit':
            return 'i64';
          case 'Float':
            return 'double';
          case 'Bool':
            return 'i1';
          case 'Text':
            return 'ptr';
          case 'TypeInfo':
            return 'ptr';
          case 'Bytes':
          case 'Spec':
            throw new UnsupportedError(`\`${s.name}\` values`);
        }
        break;
      case 'record':
      case 'union':
      case 'capability':
        return 'ptr';
      case 'opaque': {
        const q = this.t.qualifiedName(s.def);
        if (q === 'std.list.List' || q === 'std.list.Builder' || q === 'std.grid.Grid' || q === 'std.sql.Select' || q === 'std.sql.Param' || q === 'std.sql.Statement') return 'ptr';
        throw new UnsupportedError(`\`${this.t.def(s.def).name}\` values`);
      }
      case 'param':
        return 'i64';
      case 'fn':
        throw new UnsupportedError('function values');
      case 'typeinfo':
        return 'ptr';
      case 'spec':
        throw new UnsupportedError('`Spec` values');
      case 'error':
      case 'refined':
        return 'i64';
    }
    return 'i64';
  }

  /** A value as a 64-bit slot. */
  private toSlot(v: Val): string {
    switch (v.t) {
      case 'i64':
        return v.v;
      case 'double': {
        const r = this.tmp();
        this.emit(`${r} = bitcast double ${v.v} to i64`);
        return r;
      }
      case 'i1': {
        const r = this.tmp();
        this.emit(`${r} = zext i1 ${v.v} to i64`);
        return r;
      }
      case 'ptr': {
        const r = this.tmp();
        this.emit(`${r} = ptrtoint ptr ${v.v} to i64`);
        return r;
      }
    }
  }

  /** A slot read as `t`. */
  private fromSlot(slot: string, t: LlType): Val {
    switch (t) {
      case 'i64':
        return { v: slot, t };
      case 'double': {
        const r = this.tmp();
        this.emit(`${r} = bitcast i64 ${slot} to double`);
        return { v: r, t };
      }
      case 'i1': {
        const r = this.tmp();
        this.emit(`${r} = icmp ne i64 ${slot}, 0`);
        return { v: r, t };
      }
      case 'ptr': {
        const r = this.tmp();
        this.emit(`${r} = inttoptr i64 ${slot} to ptr`);
        return { v: r, t };
      }
    }
  }

  /** Converts a value to the representation of `to` (slot for type parameters). */
  private coerce(v: Val, to: LlType): Val {
    if (v.t === to) return v;
    return this.fromSlot(this.toSlot(v), to);
  }

  private cstring(s: string): string {
    const existing = this.strings.get(s);
    if (existing !== undefined) return existing;
    const name = `@s${this.strings.size + 1}`;
    const bytes = new TextEncoder().encode(s);
    this.globals.push(`${name} = private unnamed_addr constant [${bytes.length + 1} x i8] c"${escapeBytes(bytes)}\\00"`);
    this.strings.set(s, name);
    return name;
  }

  private textConst(s: string): string {
    const existing = this.texts.get(s);
    if (existing !== undefined) return existing;
    const name = `@txt${this.texts.size + 1}`;
    const bytes = new TextEncoder().encode(s);
    this.globals.push(`${name} = private unnamed_addr constant { i64, [${bytes.length + 1} x i8] } { i64 ${bytes.length}, [${bytes.length + 1} x i8] c"${escapeBytes(bytes)}\\00" }`);
    this.texts.set(s, name);
    return name;
  }

  private declare(sig: string): void {
    this.declared.add(sig);
  }

  private emit(line: string): void {
    this.lines.push(`  ${line}`);
  }

  private startBlock(name: string): void {
    this.lines.push(`${name}:`);
    this.block = name;
    this.terminated = false;
  }

  private br(target: string): void {
    if (this.terminated) return;
    this.emit(`br label %${target}`);
    this.terminated = true;
  }

  private condBr(cond: string, then: string, otherwise: string): void {
    this.emit(`br i1 ${cond}, label %${then}, label %${otherwise}`);
    this.terminated = true;
  }

  private alloca(name: string, t: LlType, type: Type): string {
    const ptr = `%"${name}.addr${this.counter += 1}"`;
    this.allocas.push(`  ${ptr} = alloca ${t}`);
    this.locals.set(name, { ptr, t, type });
    return ptr;
  }

  private panic(ob: ObRef): void {
    this.emit(`call void @onus_panic(ptr ${this.cstring(ob.kind)}, ptr ${this.cstring(ob.text)}, ptr ${this.cstring(ob.at)}, ptr ${this.cstring(ob.def)})`);
    this.emit('unreachable');
    this.terminated = true;
  }

  private variantIndex(union: DefId, variant: DefId): number {
    const i = (this.ty.variants.get(union) ?? []).indexOf(variant);
    return i < 0 ? 0 : i;
  }

  private unionDefOf(type: Type): DefId | null {
    const s = stripRefinements(type);
    return s.k === 'union' ? s.def : null;
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  private beginFn(): void {
    this.lines = [];
    this.allocas = [];
    this.locals = new Map();
    this.block = 'entry';
    this.terminated = false;
  }

  private finishFn(header: string, tail: string): void {
    // The entry block is labelled so that a branch or phi from the function's first statements can name it.
    this.fns.push(header, 'entry:', ...this.allocas, ...this.lines, tail, '}', '');
  }

  private fnItem(m: IrModule, f: IrFn): void {
    if (f.intrinsic !== null || f.body === null) return;
    const name = this.fnName(m.module.name, f.name);
    try {
      this.requireNative(f.def);
      if (f.dictParams.length > 0) throw new UnsupportedError('functions with interface-bounded type parameters');
      this.beginFn();
      const params: string[] = [];
      const stores: { name: string; t: LlType; type: Type; inout: boolean }[] = [];
      for (const c of f.constParams) {
        const t = this.ll(c.type);
        params.push(`${t} %"p.${c.name}"`);
        stores.push({ name: c.name, t, type: c.type, inout: false });
      }
      for (const p of f.params) {
        const t = this.ll(p.type);
        params.push(`${p.inout ? 'ptr' : t} %"p.${p.name}"`);
        stores.push({ name: p.name, t, type: p.type, inout: p.inout });
      }
      const ret = this.ll(f.ret);
      this.fnRetLl = ret;
      for (const s of stores) {
        if (s.inout) this.locals.set(s.name, { ptr: `%"p.${s.name}"`, t: s.t, type: s.type });
        else {
          const ptr = this.alloca(s.name, s.t, s.type);
          this.emit(`store ${s.t} %"p.${s.name}", ptr ${ptr}`);
        }
      }
      this.blockStmts(f.entry);
      this.blockStmts(f.body);
      if (!this.terminated) this.emit(ret === 'i64' ? 'ret i64 0' : ret === 'double' ? 'ret double 0.0' : ret === 'i1' ? 'ret i1 0' : 'ret ptr null');
      this.finishFn(`define ${ret} ${name}(${params.join(', ')}) {`, '');
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      this.unsupported.push({ def: this.t.qualifiedName(f.def.id), span: f.def.span, what: e.what });
    }
  }

  private constItem(m: IrModule, def: Def, type: Type, value: IrExpr): void {
    const name = this.fnName(m.module.name, def.name);
    try {
      const t = this.ll(type);
      const literal = value.k === 'value' ? value.value : null;
      if (literal !== null && (literal.k === 'int' || literal.k === 'duration')) this.globals.push(`${name} = constant i64 ${Math.trunc(literal.v)}`);
      else if (literal !== null && literal.k === 'float') this.globals.push(`${name} = constant double ${doubleLiteral(literal.v)}`);
      else if (literal !== null && literal.k === 'bool') this.globals.push(`${name} = constant i1 ${literal.v ? 1 : 0}`);
      else if (literal !== null && literal.k === 'text') this.globals.push(`${name} = constant ptr ${this.textConst(literal.v)}`);
      else {
        // An aggregate or computed constant: a slot filled on first use by a getter that evaluates the expression once.
        this.lazyConsts.add(def.id);
        this.globals.push(`${name} = global i64 0`);
        const getter = `${name.slice(0, -1)}$get"`;
        this.nested(() => {
          this.fnRetLl = 'i64';
          const cur = this.tmp();
          this.emit(`${cur} = load i64, ptr ${name}`);
          const empty = this.tmp();
          this.emit(`${empty} = icmp eq i64 ${cur}, 0`);
          const init = this.label('cinit');
          const done = this.label('cdone');
          this.condBr(empty, init, done);
          this.startBlock(init);
          const slot = this.toSlot(this.coerce(this.expr(value), t));
          this.emit(`store i64 ${slot}, ptr ${name}`);
          this.br(done);
          this.startBlock(done);
          const out = this.tmp();
          this.emit(`${out} = load i64, ptr ${name}`);
          this.emit(`ret i64 ${out}`);
          this.finishFn(`define i64 ${getter}() {`, '');
        });
      }
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      this.unsupported.push({ def: this.t.qualifiedName(def.id), span: def.span, what: e.what });
    }
  }

  private exampleFn(m: IrModule, name: string, body: IrBlock): void {
    const fn = `@"${m.module.name}.example.${name}"`;
    try {
      this.beginFn();
      this.fnRetLl = 'i1';
      this.blockStmts(body);
      if (!this.terminated) this.emit('ret i1 1');
      this.finishFn(`define i1 ${fn}() {`, '');
      this.examples.push({ name: `${m.module.name}.${name}`, fn });
    } catch (e) {
      if (!(e instanceof UnsupportedError)) throw e;
      const def = this.t.membersOf(m.module.id).tests.get(name);
      this.unsupported.push({ def: `${m.module.name}.${name}`, span: def === undefined ? m.module.module.span : this.t.def(def).span, what: e.what });
    }
  }

  /** `main(argc, argv)`: the program, or every example under `--onus-examples`. */
  private mainFn(): void {
    this.beginFn();
    this.fnRetLl = 'i64';
    this.emit('%mode = call i32 @onus_start(i32 %argc, ptr %argv)');
    this.emit('%isExamples = icmp eq i32 %mode, 1');
    this.condBr('%isExamples', 'examples', 'program');
    this.startBlock('examples');
    for (const ex of this.examples) {
      const ok = this.tmp();
      this.emit(`${ok} = call i1 ${ex.fn}()`);
      this.emit(`call void @onus_report_example(ptr ${this.cstring(ex.name)}, i1 ${ok})`);
    }
    this.emit('%exampleCode = call i32 @onus_examples_done()');
    this.emit('ret i32 %exampleCode');
    this.terminated = true;
    this.startBlock('program');
    const entry = this.entry;
    if (entry === null || entry.main === null) {
      this.emit('ret i32 0');
    } else {
      const mainFn = entry.items.find((i): i is IrFn => i.k === 'fn' && i.def.name === 'main');
      if (mainFn === undefined) this.emit('ret i32 0');
      else {
        const args: string[] = [];
        for (const p of mainFn.params) {
          const root = entry.main.roots[p.name];
          if (p.name === entry.main.args) args.push('ptr %args');
          else if (root !== undefined) args.push(`ptr ${this.rootCall(root)}`);
          else args.push('ptr null');
        }
        this.emit('%args = call ptr @onus_args(i32 %argc, ptr %argv)');
        // Root calls were emitted by rootCall in order; assemble the call.
        this.emit(`%result = call ${this.ll(mainFn.ret)} ${this.fnName(entry.module.name, mainFn.name)}(${args.join(', ')})`);
        this.emit('%code = call i32 @onus_finish(ptr %result)');
        this.emit('ret i32 %code');
      }
    }
    this.terminated = true;
    this.finishFn('define i32 @main(i32 %argc, ptr %argv) {', '');
  }

  private rootCall(kind: string): string {
    const r = this.tmp();
    this.emit(`${r} = call ptr @onus_root(ptr ${this.cstring(kind)})`);
    return r;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private blockStmts(b: IrBlock): void {
    for (const s of b) {
      if (this.terminated) return;
      this.stmt(s);
    }
  }

  private stmt(s: IrStmt): void {
    switch (s.k) {
      case 'let': {
        const t = this.ll(s.type);
        const v = this.coerce(this.expr(s.value), t);
        const ptr = this.alloca(s.name, t, s.type);
        this.emit(`store ${t} ${v.v}, ptr ${ptr}`);
        return;
      }
      case 'assign': {
        const local = this.locals.get(s.name);
        if (local === undefined) throw new Error(`unknown local ${s.name}`);
        const v = this.coerce(this.expr(s.value), local.t);
        this.emit(`store ${local.t} ${v.v}, ptr ${local.ptr}`);
        return;
      }
      case 'return': {
        if (this.fnRetLl === 'void') {
          this.emit('ret void');
          this.terminated = true;
          return;
        }
        const v = this.coerce(this.expr(s.value), this.fnRetLl);
        this.emit(`ret ${v.t} ${v.v}`);
        this.terminated = true;
        return;
      }
      case 'if': {
        const c = this.coerce(this.expr(s.cond), 'i1');
        const thenL = this.label('then');
        const elseL = this.label('else');
        const endL = this.label('endif');
        this.condBr(c.v, thenL, s.else === null ? endL : elseL);
        this.startBlock(thenL);
        this.blockStmts(s.then);
        this.br(endL);
        if (s.else !== null) {
          this.startBlock(elseL);
          this.blockStmts(s.else);
          this.br(endL);
        }
        this.startBlock(endL);
        return;
      }
      case 'match': {
        const t = this.ll(s.type);
        const v = this.coerce(this.expr(s.scrutinee), t);
        const ptr = this.alloca(s.tmp, t, s.type);
        this.emit(`store ${t} ${v.v}, ptr ${ptr}`);
        const endL = this.label('endmatch');
        for (const arm of s.arms) {
          const bodyL = this.label('arm');
          const nextL = this.label('next');
          if (arm.test !== null) {
            const c = this.coerce(this.expr(arm.test), 'i1');
            this.condBr(c.v, bodyL, nextL);
          } else this.br(bodyL);
          this.startBlock(bodyL);
          for (const b of arm.bindings) {
            const bt = this.ll(b.type);
            const bv = this.coerce(this.expr(b.value), bt);
            const bp = this.alloca(b.name, bt, b.type);
            this.emit(`store ${bt} ${bv.v}, ptr ${bp}`);
          }
          if (arm.guard !== null) {
            const g = this.coerce(this.expr(arm.guard), 'i1');
            const guardedL = this.label('guarded');
            this.condBr(g.v, guardedL, nextL);
            this.startBlock(guardedL);
          }
          this.blockStmts(arm.body);
          this.br(endL);
          this.startBlock(nextL);
        }
        this.emit('call void @onus_unreachable()');
        this.emit('unreachable');
        this.terminated = true;
        this.startBlock(endL);
        return;
      }
      case 'loop': {
        const condL = this.label('loop');
        const bodyL = this.label('body');
        const endL = this.label('endloop');
        this.br(condL);
        this.startBlock(condL);
        const c = this.coerce(this.expr(s.cond), 'i1');
        this.condBr(c.v, bodyL, endL);
        this.startBlock(bodyL);
        this.blockStmts(s.body);
        this.br(condL);
        this.startBlock(endL);
        return;
      }
      case 'for-range': {
        const lo = this.coerce(this.expr(s.lo), 'i64');
        const hi = this.coerce(this.expr(s.hi), 'i64');
        const ptr = this.alloca(s.name, 'i64', { k: 'prim', name: 'Int' });
        this.emit(`store i64 ${lo.v}, ptr ${ptr}`);
        const condL = this.label('for');
        const bodyL = this.label('body');
        const endL = this.label('endfor');
        this.br(condL);
        this.startBlock(condL);
        const i = this.tmp();
        this.emit(`${i} = load i64, ptr ${ptr}`);
        const c = this.tmp();
        this.emit(`${c} = icmp slt i64 ${i}, ${hi.v}`);
        this.condBr(c, bodyL, endL);
        this.startBlock(bodyL);
        this.blockStmts(s.body);
        if (!this.terminated) {
          const cur = this.tmp();
          this.emit(`${cur} = load i64, ptr ${ptr}`);
          const next = this.tmp();
          this.emit(`${next} = add i64 ${cur}, 1`);
          this.emit(`store i64 ${next}, ptr ${ptr}`);
        }
        this.br(condL);
        this.startBlock(endL);
        return;
      }
      case 'for-each': {
        const list = this.coerce(this.expr(s.list), 'ptr');
        const len = this.tmp();
        this.emit(`${len} = call i64 @onus_rt_list_len(ptr ${list.v})`);
        const idx = this.alloca('$idx', 'i64', { k: 'prim', name: 'Int' });
        this.emit(`store i64 0, ptr ${idx}`);
        const et = this.ll(s.type);
        const elem = this.alloca(s.name, et, s.type);
        const condL = this.label('foreach');
        const bodyL = this.label('body');
        const endL = this.label('endforeach');
        this.br(condL);
        this.startBlock(condL);
        const i = this.tmp();
        this.emit(`${i} = load i64, ptr ${idx}`);
        const c = this.tmp();
        this.emit(`${c} = icmp slt i64 ${i}, ${len}`);
        this.condBr(c, bodyL, endL);
        this.startBlock(bodyL);
        const slot = this.tmp();
        this.emit(`${slot} = call i64 @onus_rt_list_get(ptr ${list.v}, i64 ${i})`);
        const ev = this.fromSlot(slot, et);
        this.emit(`store ${et} ${ev.v}, ptr ${elem}`);
        const next = this.tmp();
        this.emit(`${next} = add i64 ${i}, 1`);
        this.emit(`store i64 ${next}, ptr ${idx}`);
        this.blockStmts(s.body);
        this.br(condL);
        this.startBlock(endL);
        return;
      }
      case 'check': {
        const c = this.coerce(this.expr(s.cond), 'i1');
        const okL = this.label('ok');
        const failL = this.label('fail');
        this.condBr(c.v, okL, failL);
        this.startBlock(failL);
        this.panic(s.ob);
        this.startBlock(okL);
        return;
      }
      case 'assert': {
        const c = this.coerce(this.expr(s.cond), 'i1');
        const okL = this.label('ok');
        const failL = this.label('fail');
        this.condBr(c.v, okL, failL);
        this.startBlock(failL);
        this.emit('ret i1 0');
        this.terminated = true;
        this.startBlock(okL);
        return;
      }
      case 'expr':
        this.expr(s.expr);
        return;
      case 'call-inout': {
        const v = this.expr(s.call);
        if (s.result !== null) {
          const t = this.ll(s.result.type);
          const ptr = this.alloca(s.result.name, t, s.result.type);
          this.emit(`store ${t} ${this.coerce(v, t).v}, ptr ${ptr}`);
        }
        return;
      }
      case 'unreachable':
        this.emit('call void @onus_unreachable()');
        this.emit('unreachable');
        this.terminated = true;
        return;
      case 'comment':
        this.emit(`; ${s.text}`);
        return;
      case 'reject': {
        const c = this.coerce(this.expr(s.cond), 'i1');
        const okL = this.label('accept');
        const failL = this.label('reject');
        this.condBr(c.v, okL, failL);
        this.startBlock(failL);
        this.emit(`store ptr ${this.textConst(s.column)}, ptr %column`);
        this.emit('ret ptr null');
        this.terminated = true;
        this.startBlock(okL);
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private expr(e: IrExpr): Val {
    switch (e.k) {
      case 'int':
        return { v: e.v.toString(), t: 'i64' };
      case 'float':
        return { v: doubleLiteral(e.v), t: 'double' };
      case 'text':
        return { v: this.textConst(e.v), t: 'ptr' };
      case 'bool':
        return { v: e.v ? '1' : '0', t: 'i1' };
      case 'unit':
        return { v: '0', t: 'i64' };
      case 'local': {
        const local = this.locals.get(e.name);
        if (local === undefined) throw new Error(`unknown local ${e.name}`);
        const r = this.tmp();
        this.emit(`${r} = load ${local.t}, ptr ${local.ptr}`);
        return { v: r, t: local.t };
      }
      case 'global': {
        const t = this.ll(e.type);
        const name = this.fnName(this.t.moduleOf(e.def.module).name, e.def.name);
        if (this.lazyConsts.has(e.def.id) || this.aggregateConst(e.def.id)) {
          const slot = this.tmp();
          this.emit(`${slot} = call i64 ${name.slice(0, -1)}$get"()`);
          return this.fromSlot(slot, t);
        }
        const r = this.tmp();
        this.emit(`${r} = load ${t}, ptr ${name}`);
        return { v: r, t };
      }
      case 'call':
        return this.call(e);
      case 'record': {
        const fields = this.ty.fields.get(e.def.id) ?? [];
        const obj = this.tmp();
        this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * Math.max(1, fields.length)})`);
        for (const f of e.fields) {
          const idx = fields.findIndex((x) => x.name === f.name);
          this.storeSlot(obj, idx < 0 ? 0 : idx, this.toSlot(this.expr(f.value)));
        }
        return { v: obj, t: 'ptr' };
      }
      case 'variant': {
        const union = e.def.parent;
        const fields = this.ty.fields.get(e.def.id) ?? [];
        const obj = this.tmp();
        this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * (1 + fields.length)})`);
        this.storeSlot(obj, 0, String(union === null ? 0 : this.variantIndex(union, e.def.id)));
        for (const f of e.fields) {
          const idx = fields.findIndex((x) => x.name === f.name);
          this.storeSlot(obj, 1 + (idx < 0 ? 0 : idx), this.toSlot(this.expr(f.value)));
        }
        return { v: obj, t: 'ptr' };
      }
      case 'update': {
        const fields = this.ty.fields.get(e.def.id) ?? [];
        const base = this.coerce(this.expr(e.base), 'ptr');
        const obj = this.tmp();
        this.emit(`${obj} = call ptr @onus_alloc(i64 ${8 * Math.max(1, fields.length)})`);
        fields.forEach((_, i) => this.storeSlot(obj, i, this.loadSlot(base.v, i)));
        for (const f of e.fields) {
          const idx = fields.findIndex((x) => x.name === f.name);
          this.storeSlot(obj, idx < 0 ? 0 : idx, this.toSlot(this.expr(f.value)));
        }
        return { v: obj, t: 'ptr' };
      }
      case 'field': {
        const obj = this.coerce(this.expr(e.object), 'ptr');
        const owner = e.owner;
        if (owner === null) throw new UnsupportedError('field access on a value of unknown shape');
        const fields = this.ty.fields.get(owner.id) ?? [];
        const idx = fields.findIndex((f) => f.name === e.name);
        const base = owner.kind === 'variant' ? 1 : 0;
        return this.fromSlot(this.loadSlot(obj.v, base + (idx < 0 ? 0 : idx)), this.ll(e.type));
      }
      case 'list': {
        const list = this.tmp();
        this.emit(`${list} = call ptr @onus_rt_list_new(i64 ${e.elems.length})`);
        e.elems.forEach((x, i) => this.emit(`call void @onus_rt_list_set(ptr ${list}, i64 ${i}, i64 ${this.toSlot(this.expr(x))})`));
        return { v: list, t: 'ptr' };
      }
      case 'concat': {
        const l = this.coerce(this.expr(e.left), 'ptr');
        const r = this.coerce(this.expr(e.right), 'ptr');
        const out = this.tmp();
        this.emit(`${out} = call ptr @${e.text ? 'onus_rt_text_concat' : 'onus_rt_list_concat'}(ptr ${l.v}, ptr ${r.v})`);
        return { v: out, t: 'ptr' };
      }
      case 'intop':
        return this.intop(e.op, this.coerce(this.expr(e.left), 'i64'), this.coerce(this.expr(e.right), 'i64'), e.ob);
      case 'floatop': {
        const l = this.coerce(this.expr(e.left), 'double');
        const r = this.coerce(this.expr(e.right), 'double');
        const op = { '+': 'fadd', '-': 'fsub', '*': 'fmul', '/': 'fdiv', '%': 'frem' }[e.op];
        const out = this.tmp();
        this.emit(`${out} = ${op} double ${l.v}, ${r.v}`);
        return { v: out, t: 'double' };
      }
      case 'neg': {
        if (e.float) {
          const v = this.coerce(this.expr(e.operand), 'double');
          const out = this.tmp();
          this.emit(`${out} = fneg double ${v.v}`);
          return { v: out, t: 'double' };
        }
        return this.intop('-', { v: '0', t: 'i64' }, this.coerce(this.expr(e.operand), 'i64'), e.ob);
      }
      case 'cmp': {
        const out = this.tmp();
        if (e.float) {
          const l = this.coerce(this.expr(e.left), 'double');
          const r = this.coerce(this.expr(e.right), 'double');
          this.emit(`${out} = fcmp ${{ '<': 'olt', '<=': 'ole', '>': 'ogt', '>=': 'oge' }[e.op]} double ${l.v}, ${r.v}`);
        } else {
          const l = this.coerce(this.expr(e.left), 'i64');
          const r = this.coerce(this.expr(e.right), 'i64');
          this.emit(`${out} = icmp ${{ '<': 'slt', '<=': 'sle', '>': 'sgt', '>=': 'sge' }[e.op]} i64 ${l.v}, ${r.v}`);
        }
        return { v: out, t: 'i1' };
      }
      case 'eq': {
        const s = stripRefinements(e.type);
        if (s.k === 'param') throw new UnsupportedError('equality on a value of a type parameter');
        if (s.k !== 'prim') {
          // Structural equality (§19.1): a comparer generated per type, over slots.
          const fn = this.eqFn(s);
          const l = this.toSlot(this.expr(e.left));
          const r = this.toSlot(this.expr(e.right));
          const same = this.tmp();
          this.emit(`${same} = call i1 ${fn}(i64 ${l}, i64 ${r})`);
          if (!e.negate) return { v: same, t: 'i1' };
          const out = this.tmp();
          this.emit(`${out} = xor i1 ${same}, true`);
          return { v: out, t: 'i1' };
        }
        const out = this.tmp();
        if (s.name === 'Float') {
          const l = this.coerce(this.expr(e.left), 'double');
          const r = this.coerce(this.expr(e.right), 'double');
          this.emit(`${out} = fcmp ${e.negate ? 'une' : 'oeq'} double ${l.v}, ${r.v}`);
        } else if (s.name === 'Text') {
          const l = this.coerce(this.expr(e.left), 'ptr');
          const r = this.coerce(this.expr(e.right), 'ptr');
          const eq = this.tmp();
          this.emit(`${eq} = call i1 @onus_rt_text_eq(ptr ${l.v}, ptr ${r.v})`);
          this.emit(`${out} = ${e.negate ? `xor i1 ${eq}, 1` : `and i1 ${eq}, 1`}`);
        } else {
          const l = this.toSlot(this.expr(e.left));
          const r = this.toSlot(this.expr(e.right));
          this.emit(`${out} = icmp ${e.negate ? 'ne' : 'eq'} i64 ${l}, ${r}`);
        }
        return { v: out, t: 'i1' };
      }
      case 'not': {
        const v = this.coerce(this.expr(e.operand), 'i1');
        const out = this.tmp();
        this.emit(`${out} = xor i1 ${v.v}, 1`);
        return { v: out, t: 'i1' };
      }
      case 'and':
        return this.shortCircuit(e.operands, true);
      case 'or':
        return this.shortCircuit(e.operands, false);
      case 'implies':
        return this.shortCircuit([{ k: 'not', operand: e.left }, e.right], false);
      case 'is-variant': {
        const subject = this.coerce(this.expr(e.subject), 'ptr');
        const union = this.unionDefOf(e.type) ?? e.variant.parent;
        const tag = this.loadSlot(subject.v, 0);
        const out = this.tmp();
        this.emit(`${out} = icmp eq i64 ${tag}, ${union === null ? 0 : this.variantIndex(union, e.variant.id)}`);
        return { v: out, t: 'i1' };
      }
      case 'try':
        return this.tryExpr(e);
      case 'checked': {
        const t = this.ll(e.type);
        const v = this.coerce(this.expr(e.value), t);
        const ptr = this.alloca(e.it, t, e.type);
        this.emit(`store ${t} ${v.v}, ptr ${ptr}`);
        this.blockStmts(e.checks);
        return v;
      }
      case 'const': {
        const c = e.value;
        if (c.k === 'int' || c.k === 'duration') return { v: c.v.toString(), t: 'i64' };
        if (c.k === 'bool') return { v: c.v ? '1' : '0', t: 'i1' };
        if (c.k === 'float') return { v: doubleLiteral(c.v), t: 'double' };
        if (c.k === 'text') return { v: this.textConst(c.v), t: 'ptr' };
        if (c.k === 'variant') {
          // A constant variant (`ReadOnly` as a `const mode: DbMode`): a value of the union carrying its tag.
          const union = this.t.def(c.def).parent;
          const obj = this.tmp();
          this.emit(`${obj} = call ptr @onus_alloc(i64 8)`);
          this.storeSlot(obj, 0, String(union === null ? 0 : this.variantIndex(union, c.def)));
          return { v: obj, t: 'ptr' };
        }
        throw new UnsupportedError(`${c.k} type arguments`);
      }
      case 'value': {
        const c = e.value;
        if (c.k === 'int' || c.k === 'duration') return { v: String(Math.trunc(c.v)), t: 'i64' };
        if (c.k === 'bool') return { v: c.v ? '1' : '0', t: 'i1' };
        if (c.k === 'float') return { v: doubleLiteral(c.v), t: 'double' };
        if (c.k === 'text') return { v: this.textConst(c.v), t: 'ptr' };
        return this.constValue(e.value);
      }
      case 'fnref':
      case 'call-value':
      case 'closure':
        throw new UnsupportedError('function values and closures');
      case 'dict':
      case 'dict-param':
        throw new UnsupportedError('interfaces');
      case 'quantifier':
        throw new UnsupportedError('quantifiers evaluated at runtime');
      case 'recover':
        return this.recover(e);
      case 'fake':
        throw new UnsupportedError('`fake`');
      case 'typeinfo':
        // Inert natively: the decoder the compiler generates replaces what `TypeInfo` describes.
        return { v: 'null', t: 'ptr' };
      case 'snapshot':
        throw new UnsupportedError('`old(...)` in a checked postcondition');
    }
  }

  /**
   * `recover { ... }` (§10.2): the body becomes a function over the enclosing
   * locals, passed as an array of their addresses; the runtime runs it under
   * `setjmp`, and a panic inside `longjmp`s back to become `Err(Panicked)`.
   */
  private recover(e: Extract<IrExpr, { k: 'recover' }>): Val {
    const captured = [...this.locals.entries()];
    const name = `@"recover$${(this.counter += 1)}"`;
    this.declare('declare ptr @onus_recover(ptr, ptr)');
    this.nested(() => {
      this.fnRetLl = 'i64';
      captured.forEach(([local, info], i) => {
        const p = this.tmp();
        this.emit(`${p} = getelementptr ptr, ptr %env, i64 ${i}`);
        const ptr = this.tmp();
        this.emit(`${ptr} = load ptr, ptr ${p}`);
        this.locals.set(local, { ptr, t: info.t, type: info.type });
      });
      this.blockStmts(e.body);
      if (!this.terminated) {
        const v = this.toSlot(this.expr(e.value));
        this.emit(`ret i64 ${v}`);
      }
      this.finishFn(`define i64 ${name}(ptr %env) {`, '');
    });
    const env = this.tmp();
    this.emit(`${env} = call ptr @onus_alloc(i64 ${8 * Math.max(1, captured.length)})`);
    captured.forEach(([, info], i) => {
      const p = this.tmp();
      this.emit(`${p} = getelementptr ptr, ptr ${env}, i64 ${i}`);
      this.emit(`store ptr ${info.ptr}, ptr ${p}`);
    });
    const out = this.tmp();
    this.emit(`${out} = call ptr @onus_recover(ptr ${name}, ptr ${env})`);
    return { v: out, t: 'ptr' };
  }

  /**
   * The comparer `@eq$N(i64, i64) -> i1` for a type: prims by value, `Text`
   * by the runtime, records field by field, unions by tag then the variant's
   * fields, lists element by element through the runtime with the element
   * comparer. Generated once per type; recursive types refer to their own
   * name. Effects: emits a function.
   */
  private eqFn(type: Type): string {
    const s = stripRefinements(type);
    const key = typeToString(s, this.t);
    const existing = this.eqFns.get(key);
    if (existing !== undefined) return existing;
    const name = `@"eq$${(this.counter += 1)}"`;
    this.eqFns.set(key, name);
    this.nested(() => {
      this.fnRetLl = 'i1';
      const r = this.eqSlots(s, '%a', '%b');
      this.emit(`ret i1 ${r}`);
      this.finishFn(`define i1 ${name}(i64 %a, i64 %b) {`, '');
    });
    return name;
  }

  /** Whether two slots holding values of `type` are equal, as an i1 in the current block. */
  private eqSlots(type: Type, a: string, b: string): string {
    const s = stripRefinements(type);
    const out = this.tmp();
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Float': {
            const fa = this.fromSlot(a, 'double');
            const fb = this.fromSlot(b, 'double');
            this.emit(`${out} = fcmp oeq double ${fa.v}, ${fb.v}`);
            return out;
          }
          case 'Text': {
            const pa = this.fromSlot(a, 'ptr');
            const pb = this.fromSlot(b, 'ptr');
            this.emit(`${out} = call i1 @onus_rt_text_eq(ptr ${pa.v}, ptr ${pb.v})`);
            return out;
          }
          case 'Int':
          case 'Duration':
          case 'Unit':
          case 'Bool':
            this.emit(`${out} = icmp eq i64 ${a}, ${b}`);
            return out;
          default:
            throw new UnsupportedError(`equality on \`${s.name}\` values`);
        }
      case 'record': {
        const subst = this.substOf(s.def, s.args);
        const pa = this.fromSlot(a, 'ptr');
        const pb = this.fromSlot(b, 'ptr');
        let acc: string | null = null;
        (this.ty.fields.get(s.def) ?? []).forEach((f, i) => {
          const e = this.eqSlots(substitute(f.type, subst), this.loadSlot(pa.v, i), this.loadSlot(pb.v, i));
          if (acc === null) acc = e;
          else {
            const both = this.tmp();
            this.emit(`${both} = and i1 ${acc}, ${e}`);
            acc = both;
          }
        });
        this.emit(`${out} = ${acc === null ? 'icmp eq i1 true, true' : `and i1 ${acc}, true`}`);
        return out;
      }
      case 'union': {
        const subst = this.substOf(s.def, s.args);
        const pa = this.fromSlot(a, 'ptr');
        const pb = this.fromSlot(b, 'ptr');
        const ta = this.loadSlot(pa.v, 0);
        const tb = this.loadSlot(pb.v, 0);
        const sameTag = this.tmp();
        this.emit(`${sameTag} = icmp eq i64 ${ta}, ${tb}`);
        const dispatch = this.label('eqsw');
        const differ = this.label('eqno');
        const done = this.label('eqdone');
        this.condBr(sameTag, dispatch, differ);
        this.startBlock(dispatch);
        const variants = this.ty.variants.get(s.def) ?? [];
        const labels = variants.map(() => this.label('eqv'));
        this.emit(`switch i64 ${ta}, label %${differ} [${variants.map((v, i) => ` i64 ${this.variantIndex(s.def, v)}, label %${labels[i] ?? differ}`).join('')} ]`);
        this.terminated = true;
        const incoming: string[] = [];
        variants.forEach((v, i) => {
          this.startBlock(labels[i] ?? differ);
          let acc: string | null = null;
          (this.ty.fields.get(v) ?? []).forEach((f, j) => {
            const e = this.eqSlots(substitute(f.type, subst), this.loadSlot(pa.v, 1 + j), this.loadSlot(pb.v, 1 + j));
            if (acc === null) acc = e;
            else {
              const both = this.tmp();
              this.emit(`${both} = and i1 ${acc}, ${e}`);
              acc = both;
            }
          });
          incoming.push(`[ ${acc ?? 'true'}, %${this.block} ]`);
          this.br(done);
        });
        this.startBlock(differ);
        incoming.push(`[ false, %${this.block} ]`);
        this.br(done);
        this.startBlock(done);
        this.emit(`${out} = phi i1 ${incoming.join(', ')}`);
        return out;
      }
      case 'opaque': {
        const q = this.t.qualifiedName(s.def);
        const elem = s.args[0];
        if (q !== 'std.list.List' || elem === undefined || elem.k !== 'type') throw new UnsupportedError(`equality on \`${this.t.def(s.def).name}\` values`);
        this.declare('declare i1 @onus_rt_list_eq(ptr, ptr, ptr)');
        const fn = this.eqFn(elem.type);
        const pa = this.fromSlot(a, 'ptr');
        const pb = this.fromSlot(b, 'ptr');
        this.emit(`${out} = call i1 @onus_rt_list_eq(ptr ${pa.v}, ptr ${pb.v}, ptr ${fn})`);
        return out;
      }
      case 'param':
        throw new UnsupportedError('equality on a value of a type parameter');
      default:
        throw new UnsupportedError(`equality on \`${typeToString(s, this.t)}\` values`);
    }
  }

  /** The type arguments of a record or union type, by its parameters. */
  private substOf(def: DefId, args: readonly TypeArg[]): Map<DefId, TypeArg> {
    const params = this.ty.typeParams.get(def) ?? [];
    const subst = new Map<DefId, TypeArg>();
    params.forEach((p, i) => {
      const a = args[i];
      if (a !== undefined) subst.set(p.def, a);
    });
    return subst;
  }

  private loadSlot(obj: string, idx: number): string {
    const p = this.tmp();
    this.emit(`${p} = getelementptr i64, ptr ${obj}, i64 ${idx}`);
    const v = this.tmp();
    this.emit(`${v} = load i64, ptr ${p}`);
    return v;
  }

  private storeSlot(obj: string, idx: number, slot: string): void {
    const p = this.tmp();
    this.emit(`${p} = getelementptr i64, ptr ${obj}, i64 ${idx}`);
    this.emit(`store i64 ${slot}, ptr ${p}`);
  }

  private shortCircuit(operands: readonly IrExpr[], isAnd: boolean): Val {
    const endL = this.label('sc');
    const incoming: string[] = [];
    for (let i = 0; i < operands.length; i++) {
      const o = operands[i];
      if (o === undefined) continue;
      const v = this.coerce(this.expr(o), 'i1');
      if (i === operands.length - 1) {
        incoming.push(`[ ${v.v}, %${this.block} ]`);
        this.br(endL);
        break;
      }
      const nextL = this.label('scnext');
      incoming.push(`[ ${isAnd ? '0' : '1'}, %${this.block} ]`);
      if (isAnd) this.condBr(v.v, nextL, endL);
      else this.condBr(v.v, endL, nextL);
      this.startBlock(nextL);
    }
    this.startBlock(endL);
    const out = this.tmp();
    this.emit(`${out} = phi i1 ${incoming.join(', ')}`);
    return { v: out, t: 'i1' };
  }

  private intop(op: '+' | '-' | '*' | '/' | '%', l: Val, r: Val, ob: ObRef | null): Val {
    const out = this.tmp();
    if (op === '/' || op === '%') {
      if (ob !== null) {
        const zero = this.tmp();
        this.emit(`${zero} = icmp eq i64 ${r.v}, 0`);
        const okL = this.label('divok');
        const failL = this.label('divfail');
        this.condBr(zero, failL, okL);
        this.startBlock(failL);
        this.panic(ob);
        this.startBlock(okL);
      }
      this.emit(`${out} = ${op === '/' ? 'sdiv' : 'srem'} i64 ${l.v}, ${r.v}`);
      return { v: out, t: 'i64' };
    }
    if (ob === null) {
      this.emit(`${out} = ${{ '+': 'add', '-': 'sub', '*': 'mul' }[op]} i64 ${l.v}, ${r.v}`);
      return { v: out, t: 'i64' };
    }
    const pair = this.tmp();
    this.emit(`${pair} = call { i64, i1 } @llvm.${{ '+': 'sadd', '-': 'ssub', '*': 'smul' }[op]}.with.overflow.i64(i64 ${l.v}, i64 ${r.v})`);
    this.emit(`${out} = extractvalue { i64, i1 } ${pair}, 0`);
    const overflow = this.tmp();
    this.emit(`${overflow} = extractvalue { i64, i1 } ${pair}, 1`);
    const okL = this.label('arith');
    const failL = this.label('overflow');
    this.condBr(overflow, failL, okL);
    this.startBlock(failL);
    this.panic(ob);
    this.startBlock(okL);
    return { v: out, t: 'i64' };
  }

  private call(e: Extract<IrExpr, { k: 'call' }>): Val {
    if (e.target.k !== 'fn') throw new UnsupportedError('interface dispatch through a dictionary');
    const def = e.target.def;
    this.requireNative(def);
    const sig = e.sig;
    const retLl = this.ll(e.type);
    const args: string[] = [];
    if (def.intrinsic) {
      // Runtime primitives take and return 64-bit slots; `inout` parameters are pointers to slots.
      const q = this.t.qualifiedName(def.id);
      const cname = `@onus_${q.split('.').slice(1).join('_')}`;
      const paramTypes: string[] = [];
      for (const c of e.consts) {
        args.push(`i64 ${this.toSlot(this.expr(c))}`);
        paramTypes.push('i64');
      }
      sig.params.forEach((p, i) => {
        const a = e.args[i];
        if (a === undefined) return;
        if (p.inout) {
          args.push(`ptr ${this.addressOf(a)}`);
          paramTypes.push('ptr');
        } else {
          args.push(`i64 ${this.toSlot(this.expr(a))}`);
          paramTypes.push('i64');
        }
      });
      if (e.decoder !== undefined) {
        const fn = this.decoderFn(e.decoder);
        const slot = this.tmp();
        this.emit(`${slot} = ptrtoint ptr ${fn} to i64`);
        args.push(`i64 ${slot}`);
        paramTypes.push('i64');
      }
      this.declare(`declare i64 ${cname}(${paramTypes.join(', ')})`);
      const out = this.tmp();
      this.emit(`${out} = call i64 ${cname}(${args.join(', ')})`);
      return this.fromSlot(out, retLl);
    }
    const module = this.t.moduleOf(def.module).name;
    for (const c of e.consts) {
      const v = this.expr(c);
      args.push(`${v.t} ${v.v}`);
    }
    sig.params.forEach((p, i) => {
      const a = e.args[i];
      if (a === undefined) return;
      if (p.inout) args.push(`ptr ${this.addressOf(a)}`);
      else {
        const v = this.coerce(this.expr(a), this.ll(p.type));
        args.push(`${v.t} ${v.v}`);
      }
    });
    const calleeRet = this.ll(sig.ret);
    const out = this.tmp();
    this.emit(`${out} = call ${calleeRet} ${this.fnName(module, e.target.name)}(${args.join(', ')})`);
    return this.coerce({ v: out, t: calleeRet }, retLl);
  }

  /** The address of an `inout` argument's slot: the local's storage, whose element type must be the slot type. */
  private addressOf(a: IrExpr): string {
    if (a.k !== 'local') throw new UnsupportedError('an `inout` argument that is not a variable');
    const local = this.locals.get(a.name);
    if (local === undefined) throw new Error(`unknown local ${a.name}`);
    if (local.t !== 'i64' && local.t !== 'ptr') throw new UnsupportedError(`\`inout\` arguments of type ${local.t}`);
    return local.ptr;
  }

  private tryExpr(e: Extract<IrExpr, { k: 'try' }>): Val {
    const operand = this.coerce(this.expr(e.operand), 'ptr');
    const tag = this.loadSlot(operand.v, 0);
    const isOk = this.tmp();
    this.emit(`${isOk} = icmp eq i64 ${tag}, 0`);
    const okL = this.label('tryok');
    const failL = this.label('tryfail');
    this.condBr(isOk, okL, failL);
    this.startBlock(failL);
    if (e.raw) {
      const v = this.coerce(this.expr(e.else?.value ?? { k: 'bool', v: false }), 'i1');
      this.emit(`ret i1 ${v.v}`);
    } else if (e.else === null) {
      if (e.option && !e.outerOption) throw new UnsupportedError('`try` on an Option inside a function returning Result without an `else`');
      // The same error (or `None`) is the function's result.
      this.emit(`ret ptr ${operand.v}`);
    } else {
      if (e.else.name !== null) {
        const et = this.ll(e.else.errorType);
        const err = this.fromSlot(this.loadSlot(operand.v, 1), et);
        const ptr = this.alloca(e.else.name, et, e.else.errorType);
        this.emit(`store ${et} ${err.v}, ptr ${ptr}`);
      }
      const converted = this.toSlot(this.expr(e.else.value));
      const result = this.tmp();
      this.emit(`${result} = call ptr @onus_alloc(i64 16)`);
      this.storeSlot(result, 0, '1');
      this.storeSlot(result, 1, converted);
      this.emit(`ret ptr ${result}`);
    }
    this.terminated = true;
    this.startBlock(okL);
    if (e.option && e.else === null && e.outerOption) {
      // `Some` carries its value in slot 1 like `Ok`.
    }
    return this.fromSlot(this.loadSlot(operand.v, 1), this.ll(e.type));
  }
}

function escapeBytes(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) out += String.fromCharCode(b);
    else out += `\\${b.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

/** An exact LLVM double literal: the IEEE bits in hexadecimal. */
function doubleLiteral(v: number): string {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, v);
  const hi = buf.getUint32(0).toString(16).padStart(8, '0');
  const lo = buf.getUint32(4).toString(16).padStart(8, '0');
  return `0x${hi}${lo}`.toUpperCase().replace('0X', '0x');
}
