/**
 * Code generation (impl spec §6): one JavaScript (ESM) file per module,
 * emitted directly. The same emitter produces TypeScript when `ts` is set;
 * that output is a fixture-suite oracle only (it must pass `tsc --strict`
 * with no casts) and is never a user-facing path.
 *
 * Conventions of the generated code:
 *   - a function takes one object of named arguments (const type parameters
 *     included) and returns `[result, ...inout]` when it has `inout` params;
 *   - a runtime check is inserted for an obligation iff it is `checked`;
 *     the callee checks its own `requires` and parameter refinements on
 *     entry, on behalf of every call site;
 *   - `try` unwinds with `EarlyReturn`, caught by the enclosing function;
 *   - `match` is a labelled block of pattern tests in arm order;
 *   - a bounded type parameter `T: I` becomes a hidden dictionary argument
 *     `$dict_T`, and `I.f(...)` dispatches through it;
 *   - impl functions are named `Iface$Type$fn`; each impl also exports its
 *     dictionary `Iface$Type`.
 */
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import type { Value } from '../consteval/values.js';
import type { Def, DefId, ModuleId, ModuleRecord, ResolveTables } from '../resolve/defs.js';
import { lineColOf, type Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import { walk } from '../syntax/walk.js';
import type { Signature, TypeTables } from '../types/tables.js';
import { stripRefinements, substitute, type ConstValue, type Type, type TypeArg } from '../types/type.js';

export interface EmitOptions {
  readonly ts: boolean;
  /** Module specifier for the runtime package. */
  readonly runtime: string;
}

export interface EmittedModule {
  readonly module: ModuleRecord;
  readonly code: string;
  /** A vitest file for the module's examples, properties and laws, or null when it has none. */
  readonly tests: string | null;
  /** Root capabilities of `main`, when the module declares one. */
  readonly main: { readonly roots: Readonly<Record<string, string>>; readonly args: string } | null;
}

const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public',
  'arguments', 'eval', 'undefined', 'NaN', 'Infinity',
]);

const GLOBAL_TYPES = new Set(['Error', 'Map', 'Set', 'Object', 'Array', 'Promise', 'Date', 'Function', 'Symbol', 'Number', 'String', 'Boolean', 'Record', 'Partial', 'Readonly', 'Required', 'Pick', 'Omit']);

/** JavaScript precedence of an emitted expression, for minimal parentheses. */
const ATOM = 20;
const CALL = 17;
const UNARY = 14;
const MUL = 12;
const ADD = 11;
const CMP = 9;
const EQ = 8;
const AND = 4;
const OR = 3;
const ARROW = 2;

interface Piece {
  readonly code: string;
  readonly prec: number;
}

function piece(code: string, prec: number): Piece {
  return { code, prec };
}

function at(p: Piece, min: number): string {
  return p.prec >= min ? p.code : `(${p.code})`;
}

class Writer {
  private readonly lines: string[] = [];
  private depth = 0;

  line(s = ''): void {
    this.lines.push(s === '' ? '' : `${'  '.repeat(this.depth)}${s}`);
  }

  indent(): void {
    this.depth += 1;
  }

  dedent(): void {
    this.depth -= 1;
  }

  block(open: string, body: () => void, close = '}'): void {
    this.line(open);
    this.indent();
    body();
    this.dedent();
    this.line(close);
  }

  text(): string {
    return this.lines.join('\n');
  }
}

/** Per-function emission context. */
interface FnCtx {
  /** Names of `inout` parameters, in declaration order. */
  readonly inout: readonly string[];
  readonly ret: Type;
  readonly ensures: readonly A.Contract[];
  /** Parameters mentioned in `old(...)`. */
  readonly olds: ReadonlySet<string>;
  readonly def: Def;
  /** Dictionary parameter names by bounded type parameter def. */
  readonly dicts: ReadonlyMap<DefId, string>;
  /** `result` in an ensures clause. */
  result: string | null;
}

/**
 * Emits one module.
 * Preconditions: all passes through contracts ran without diagnostics.
 * Effects: none (returns text).
 */
export function emitModule(ctx: Context, m: ModuleRecord, opts: EmitOptions): EmittedModule {
  return new Emitter(ctx, m, opts).run();
}

class Emitter {
  private readonly t: ResolveTables;
  private readonly ty: TypeTables;
  private w = new Writer();
  private readonly imports = new Map<ModuleId, string>();
  private readonly obRefs = new Map<string, string>();
  private readonly obDecls: string[] = [];
  private fn: FnCtx | null = null;
  /** Substitutes `it` inside a refinement predicate. */
  private itName: string | null = null;
  /** Field defs of a record under construction → `$v.name`. */
  private fieldObject: { readonly record: DefId; readonly name: string } | null = null;
  private temp = 0;
  private selfAlias: string | null = null;
  /** Inside an impl: interface function def → emitted name. */
  private implFns: ReadonlyMap<DefId, string> = new Map();

  constructor(
    private readonly ctx: Context,
    private readonly m: ModuleRecord,
    private readonly opts: EmitOptions,
  ) {
    this.t = ctx.resolve;
    this.ty = ctx.types;
  }

  run(): EmittedModule {
    let main: EmittedModule['main'] = null;
    for (const item of this.m.module.items) {
      this.item(item);
      if (item.kind === 'FnDecl' && item.name.text === 'main' && item.vis.pub) main = this.mainSpec(item);
    }
    const body = this.w.text();
    const head = new Writer();
    head.line(`// Generated by onus from module ${this.m.name}. Do not edit.`);
    head.line(`import * as $rt from ${JSON.stringify(this.opts.runtime)};`);
    for (const [id, alias] of this.imports) head.line(`import * as ${alias} from ${JSON.stringify(this.relativeImport(id))};`);
    if (this.opts.ts && this.m.module.test) head.line('');
    head.line('');
    for (const d of this.obDecls) head.line(d);
    if (this.obDecls.length > 0) head.line('');
    const tests = this.testsFile();
    return { module: this.m, code: `${head.text()}${body}\n`, tests, main };
  }

  // -------------------------------------------------------------------------
  // Names and imports
  // -------------------------------------------------------------------------

  private relativeImport(id: ModuleId): string {
    const from = this.m.name.split('.');
    const to = this.t.moduleOf(id).name.split('.');
    const ups = from.length - 1;
    const prefix = ups === 0 ? './' : '../'.repeat(ups);
    return `${prefix}${to.join('/')}.js`;
  }

  private alias(id: ModuleId): string {
    if (id === this.m.id && this.selfAlias !== null) return this.selfAlias;
    const existing = this.imports.get(id);
    if (existing !== undefined) return existing;
    const alias = `$${this.t.moduleOf(id).name.replace(/\./g, '_')}`;
    this.imports.set(id, alias);
    return alias;
  }

  private local(name: string): string {
    return RESERVED.has(name) ? `${name}_` : name;
  }

  private typeName(name: string): string {
    return GLOBAL_TYPES.has(name) ? `${name}_` : name;
  }

  /** The emitted name of a module-level definition, qualified when it lives elsewhere. */
  private defName(def: Def): string {
    const base = def.parent !== null && this.t.def(def.parent).kind === 'impl' ? this.implFnName(def) : this.local(def.name);
    if (def.module === this.m.id && this.selfAlias === null) return base;
    return `${this.alias(def.module)}.${base}`;
  }

  private implFnName(def: Def): string {
    const impl = def.parent === null ? null : this.t.def(def.parent);
    if (impl === null) return this.local(def.name);
    const node = this.t.node(impl.node);
    const target = node.kind === 'ImplDecl' ? this.typeSlug(this.ty.exprTypes.get(node.target.id) ?? this.targetType(node)) : '';
    return `${impl.name}$${target}$${def.name}`;
  }

  private targetType(node: A.ImplDecl): Type {
    const res = this.t.refs.get(node.target.id);
    if (res !== undefined && res.k === 'prim') return { k: 'prim', name: res.name };
    if (res !== undefined && res.k === 'def') {
      const d = this.t.def(res.def);
      if (d.kind === 'record') return { k: 'record', def: d.id, args: [] };
      if (d.kind === 'union') return { k: 'union', def: d.id, args: [] };
      if (d.kind === 'alias') return this.ty.aliases.get(d.id) ?? { k: 'error' };
      if (d.kind === 'intrinsic-type') return { k: 'opaque', def: d.id, args: [] };
    }
    return { k: 'error' };
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

  private implDictName(iface: Def, target: Type): string {
    return `${iface.name}$${this.typeSlug(target)}`;
  }

  private tmp(prefix = 't'): string {
    this.temp += 1;
    return `$${prefix}${this.temp}`;
  }

  // -------------------------------------------------------------------------
  // Obligation references
  // -------------------------------------------------------------------------

  private where(span: Span): string {
    const f = this.ctx.fileOf(span);
    const p = lineColOf(f, span.start);
    return `${f.path}:${p.line}:${p.col}`;
  }

  private obRef(kind: string, text: string, span: Span, def: string): string {
    const key = `${kind}|${text}|${this.where(span)}|${def}`;
    const existing = this.obRefs.get(key);
    if (existing !== undefined) return existing;
    const name = `$ob${this.obRefs.size + 1}`;
    this.obRefs.set(key, name);
    const literal = `{ kind: ${JSON.stringify(kind)}, text: ${JSON.stringify(text)}, at: ${JSON.stringify(this.where(span))}, def: ${JSON.stringify(def)} }`;
    this.obDecls.push(this.opts.ts ? `const ${name}: $rt.ObligationRef = ${literal};` : `const ${name} = ${literal};`);
    return name;
  }

  private obRefOf(o: Obligation): string {
    const node = this.t.node(o.at);
    return this.obRef(o.kind, o.text, node.span, this.t.def(o.def).name);
  }

  // -------------------------------------------------------------------------
  // Types (TypeScript mode)
  // -------------------------------------------------------------------------

  private tsType(t: Type): string {
    const s = stripRefinements(t);
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Int':
          case 'Float':
          case 'Duration':
            return 'number';
          case 'Bool':
            return 'boolean';
          case 'Text':
            return 'string';
          case 'Unit':
            return 'undefined';
          case 'Bytes':
            return 'Uint8Array';
          case 'TypeInfo':
            return '$rt.TypeInfo';
          case 'Spec':
            return 'unknown';
        }
        break;
      case 'record':
      case 'union': {
        const def = this.t.def(s.def);
        const args = s.args.filter((a) => a.k === 'type').map((a) => (a.k === 'type' ? this.tsType(a.type) : ''));
        const name = def.module === this.m.id && this.selfAlias === null ? this.typeName(def.name) : `${this.alias(def.module)}.${this.typeName(def.name)}`;
        return args.length > 0 ? `${name}<${args.join(', ')}>` : name;
      }
      case 'opaque': {
        const q = this.t.qualifiedName(s.def);
        const targs = s.args.filter((a) => a.k === 'type').map((a) => (a.k === 'type' ? this.tsType(a.type) : ''));
        switch (q) {
          case 'std.list.List':
            return `readonly ${wrap(targs[0] ?? 'unknown')}[]`;
          case 'std.grid.Grid':
            return `$rt.grid.Grid<${targs[0] ?? 'unknown'}>`;
          case 'std.map.Map':
            return `$rt.map.Map<${targs[0] ?? 'unknown'}, ${targs[1] ?? 'unknown'}>`;
          case 'std.sql.Select':
            return `$rt.sql.Select<${targs[0] ?? 'unknown'}>`;
          case 'std.sql.Param':
            return '$rt.sql.Param';
          case 'std.sql.Statement':
            return '$rt.sql.Statement';
          default:
            return 'unknown';
        }
      }
      case 'capability': {
        const q = this.t.qualifiedName(s.def);
        if (q.startsWith('std.io.')) return `$rt.io.${this.t.def(s.def).name}`;
        if (q === 'std.sql.Db') return '$rt.sql.Db';
        return '$rt.Capability';
      }
      case 'fn':
        return `(${s.params.map((p) => `${this.local(p.name)}: ${this.tsType(p.type)}`).join(', ')}) => ${this.tsReturn(s.ret, s.params.filter((p) => p.inout).map((p) => p.type))}`;
      case 'param':
        return this.t.def(s.def).name;
      case 'typeinfo':
        return '$rt.TypeInfo';
      case 'spec':
        return 'unknown';
      case 'error':
        return 'never';
      case 'refined':
        return 'never';
    }
    return 'never';
  }

  private tsParams(params: readonly { readonly name: string; readonly type: Type }[], extra: readonly string[]): string {
    const fields = [...extra, ...params.map((p) => `${this.local(p.name)}: ${this.tsType(p.type)}`)];
    return fields.length === 0 ? 'Record<string, never>' : `{ ${fields.join('; ')} }`;
  }

  /** In TypeScript output, keeps a union-typed value at its declared type (see `$rt.widen`). */
  private widened(code: string, declared: Type): string {
    if (!this.opts.ts) return code;
    const s = stripRefinements(declared);
    return s.k === 'union' ? `$rt.widen<${this.tsType(declared)}>(${code})` : code;
  }

  private tsReturn(ret: Type, inout: readonly Type[]): string {
    const r = this.tsType(ret);
    return inout.length === 0 ? r : `[${[r, ...inout.map((t) => this.tsType(t))].join(', ')}]`;
  }

  private tsTypeParams(sig: Signature | null, extraDefs: readonly DefId[] = []): string {
    const names = [...(sig?.tparams.filter((p) => p.k === 'type').map((p) => this.t.def(p.def).name) ?? []), ...extraDefs.map((d) => this.t.def(d).name)];
    return names.length > 0 ? `<${names.join(', ')}>` : '';
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  private item(item: A.Item): void {
    switch (item.kind) {
      case 'FnDecl':
        this.fnDecl(item, null);
        break;
      case 'ConstDecl':
        this.constDecl(item);
        break;
      case 'TypeAlias':
        if (this.opts.ts) {
          const def = this.t.def(this.defOf(item));
          this.w.line(`export type ${this.typeName(def.name)} = ${this.tsType(this.ty.aliases.get(def.id) ?? { k: 'error' })};`);
          this.w.line('');
        }
        break;
      case 'IntrinsicType':
        if (this.opts.ts) this.intrinsicType(item);
        break;
      case 'RecordDecl':
        if (this.opts.ts) this.recordType(item);
        break;
      case 'UnionDecl':
        if (this.opts.ts) this.unionType(item);
        break;
      case 'InterfaceDecl':
        if (this.opts.ts) this.interfaceType(item);
        break;
      case 'ImplDecl':
        this.impl(item);
        break;
      case 'CapabilityDecl':
        if (this.opts.ts) {
          this.w.line(`export type ${this.typeName(item.name.text)} = $rt.Capability;`);
          this.w.line('');
        }
        break;
      case 'ClaimDecl':
      case 'PathDecl':
      case 'PolicyDecl':
      case 'ExampleDecl':
      case 'PropertyDecl':
        break;
    }
  }

  private defOf(node: A.NodeBase): DefId {
    const d = this.t.defOf.get(node.id);
    if (d === undefined) throw new Error(`no definition for node ${node.id}`);
    return d;
  }

  private intrinsicType(item: A.IntrinsicType): void {
    const def = this.t.def(this.defOf(item));
    const params = (this.ty.typeParams.get(def.id) ?? []).filter((p) => p.k === 'type').map((p) => this.t.def(p.def).name);
    const generic = params.length > 0 ? `<${params.join(', ')}>` : '';
    const q = this.t.qualifiedName(def.id);
    const body =
      q === 'std.list.List' ? `readonly ${params[0] ?? 'unknown'}[]` :
      q === 'std.grid.Grid' ? `$rt.grid.Grid<${params[0] ?? 'unknown'}>` :
      q === 'std.map.Map' ? `$rt.map.Map<${params[0] ?? 'unknown'}, ${params[1] ?? 'unknown'}>` :
      q === 'std.sql.Select' ? `$rt.sql.Select<${params[0] ?? 'unknown'}>` :
      q === 'std.sql.Param' ? '$rt.sql.Param' :
      q === 'std.sql.Statement' ? '$rt.sql.Statement' : 'unknown';
    this.w.line(`export type ${this.typeName(def.name)}${generic} = ${body};`);
    this.w.line('');
  }

  private recordType(item: A.RecordDecl): void {
    const def = this.t.def(this.defOf(item));
    const generic = this.tsTypeParams(null, (this.ty.typeParams.get(def.id) ?? []).filter((p) => p.k === 'type').map((p) => p.def));
    const fields = this.ty.fields.get(def.id) ?? [];
    this.w.block(`export interface ${this.typeName(def.name)}${generic} {`, () => {
      for (const f of fields) this.w.line(`readonly ${this.local(f.name)}: ${this.tsType(f.type)};`);
    });
    this.w.line('');
  }

  private unionType(item: A.UnionDecl): void {
    const def = this.t.def(this.defOf(item));
    const generic = this.tsTypeParams(null, (this.ty.typeParams.get(def.id) ?? []).filter((p) => p.k === 'type').map((p) => p.def));
    const variants = (this.ty.variants.get(def.id) ?? []).map((v) => {
      const fields = (this.ty.fields.get(v) ?? []).map((f) => `; readonly ${this.local(f.name)}: ${this.tsType(f.type)}`).join('');
      return `{ readonly tag: ${JSON.stringify(this.t.def(v).name)}${fields} }`;
    });
    this.w.line(`export type ${this.typeName(def.name)}${generic} =`);
    this.w.indent();
    variants.forEach((v, i) => this.w.line(`| ${v}${i === variants.length - 1 ? ';' : ''}`));
    this.w.dedent();
    this.w.line('');
  }

  private interfaceType(item: A.InterfaceDecl): void {
    const def = this.t.def(this.defOf(item));
    const tp = this.t.defs.find((d) => d.kind === 'type-param' && d.node === def.node);
    const generic = tp === undefined ? '' : `<${tp.name}>`;
    this.w.block(`export interface ${this.typeName(def.name)}${generic} {`, () => {
      for (const f of this.t.defs.filter((d) => d.parent === def.id && d.kind === 'iface-fn')) {
        const sig = this.ty.signatures.get(f.id);
        if (sig === undefined) continue;
        this.w.line(`readonly ${this.local(f.name)}: (args: ${this.tsParams(sig.params, [])}) => ${this.tsReturn(sig.ret, sig.params.filter((p) => p.inout).map((p) => p.type))};`);
      }
    });
    this.w.line('');
  }

  private constDecl(item: A.ConstDecl): void {
    const def = this.t.def(this.defOf(item));
    const value = this.ctx.consteval.constValues.get(def.id);
    const type = this.opts.ts ? `: ${this.tsType(this.ty.declTypes.get(def.id) ?? { k: 'error' })}` : '';
    const init = value !== undefined ? this.valueLiteral(value) : this.expr(item.value).code;
    this.w.line(`export const ${this.local(def.name)}${type} = ${init};`);
    this.w.line('');
  }

  private valueLiteral(v: Value): string {
    switch (v.k) {
      case 'int':
      case 'float':
      case 'duration':
        return String(v.v);
      case 'bool':
        return v.v ? 'true' : 'false';
      case 'text':
        return JSON.stringify(v.v);
      case 'unit':
        return 'undefined';
      case 'bytes':
        return `new Uint8Array([${[...v.v].join(', ')}])`;
      case 'list':
        return `[${v.items.map((x) => this.valueLiteral(x)).join(', ')}]`;
      case 'record':
        return `{ ${[...v.fields].map(([n, x]) => `${this.local(n)}: ${this.valueLiteral(x)}`).join(', ')} }`;
      case 'variant': {
        const parts = [`tag: ${JSON.stringify(this.t.def(v.def).name)}`, ...[...v.fields].map(([n, x]) => `${this.local(n)}: ${this.valueLiteral(x)}`)];
        return `{ ${parts.join(', ')} }`;
      }
      case 'typeinfo':
        return this.typeInfoLiteral(v.owner.k === 'def' ? v.owner.def : null, v.owner.k === 'prim' ? v.owner.name : null);
    }
  }

  private typeInfoLiteral(def: DefId | null, prim: string | null): string {
    if (def === null) return `$rt.typeInfo(${JSON.stringify(prim ?? '?')}, [])`;
    const d = this.t.def(def);
    const fields = (this.ty.fields.get(def) ?? []).map((f) => `{ name: ${JSON.stringify(f.name)}, type_name: ${JSON.stringify(this.typeSlug(f.type))} }`);
    return `$rt.typeInfo(${JSON.stringify(d.name)}, [${fields.join(', ')}])`;
  }

  private impl(item: A.ImplDecl): void {
    const ifaceRes = this.t.refs.get(item.id);
    if (ifaceRes === undefined || ifaceRes.k !== 'def') return;
    const iface = this.t.def(ifaceRes.def);
    const target = this.targetType(item);
    const map = new Map<DefId, string>();
    for (const f of item.fns) {
      const fd = this.t.def(this.defOf(f));
      const want = this.t.defs.find((d) => d.parent === iface.id && d.kind === 'iface-fn' && d.name === f.name.text);
      if (want !== undefined) map.set(want.id, this.implFnName(fd));
    }
    this.implFns = map;
    for (const f of item.fns) this.fnDecl(f, this.implFnName(this.t.def(this.defOf(f))));
    this.implFns = new Map();
    const dict = this.implDictName(iface, target);
    const entries = item.fns.map((f) => `${this.local(f.name.text)}: ${this.implFnName(this.t.def(this.defOf(f)))}`);
    const type = this.opts.ts ? `: ${this.tsIfaceDict(iface, target)}` : '';
    this.w.line(`export const ${dict}${type} = { ${entries.join(', ')} };`);
    this.w.line('');
  }

  private tsIfaceDict(iface: Def, target: Type): string {
    const name = iface.module === this.m.id ? this.typeName(iface.name) : `${this.alias(iface.module)}.${this.typeName(iface.name)}`;
    return `${name}<${this.tsType(target)}>`;
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  private fnDecl(f: A.FnDecl, emittedName: string | null): void {
    const def = this.t.def(this.defOf(f));
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return;
    const name = emittedName ?? this.local(def.name);
    const dicts = new Map<DefId, string>();
    for (const p of sig.tparams) if (p.k === 'type' && p.bound !== null) dicts.set(p.def, `$dict_${this.t.def(p.def).name}`);
    const constParams = sig.tparams.filter((p) => p.k === 'const').map((p) => this.t.def(p.def).name);
    const paramNames = [...dicts.values(), ...constParams.map((n) => this.local(n)), ...sig.params.map((p) => this.local(p.name))];
    const destructure = paramNames.length === 0 ? '$args' : `{ ${paramNames.join(', ')} }`;
    let tsSig = '';
    if (this.opts.ts) {
      const extra = [
        ...[...dicts].map(([d, n]) => {
          const bound = sig.tparams.find((p) => p.def === d);
          const b = bound !== undefined && bound.k === 'type' && bound.bound !== null ? this.t.def(bound.bound) : null;
          return `${n}: ${b === null ? 'unknown' : this.tsIfaceDict(b, { k: 'param', def: d })}`;
        }),
        ...sig.tparams.filter((p) => p.k === 'const').map((p) => `${this.local(this.t.def(p.def).name)}: ${this.tsType(p.k === 'const' ? p.type : { k: 'error' })}`),
      ];
      tsSig = `${this.tsTypeParams(sig)}(${destructure}: ${this.tsParams(sig.params, extra)}): ${this.tsReturn(sig.ret, sig.params.filter((p) => p.inout).map((p) => p.type))}`;
    } else {
      tsSig = `(${destructure})`;
    }
    const exported = 'export ';
    if (f.intrinsic) {
      this.w.block(`${exported}function ${name}${tsSig} {`, () => {
        const q = this.t.qualifiedName(def.id);
        const ns = q.split('.')[1] ?? '';
        const args = [...constParams, ...sig.params.map((p) => p.name)].map((n) => this.local(n));
        this.w.line(`return $rt.${ns}.${def.name}(${args.join(', ')});`);
      });
      this.w.line('');
      return;
    }
    if (f.body === null) return;
    const body = f.body;
    const olds = new Set<string>();
    for (const c of f.contracts) walk(c.expr, (n) => {
      if (n.kind === 'Old') olds.add(n.name.text);
      return true;
    });
    this.fn = { inout: sig.params.filter((p) => p.inout).map((p) => p.name), ret: sig.ret, ensures: f.contracts.filter((c) => c.clause === 'ensures'), olds, def, dicts, result: null };
    this.w.block(`${exported}function ${name}${tsSig} {`, () => {
      this.entryChecks(sig, f.contracts, def.name);
      for (const o of olds) this.w.line(`const $old_${o} = $rt.snapshot(${this.local(o)});`);
      this.bodyWithTry(body, () => {
        this.block(body);
        if (this.fn !== null && this.fn.inout.length > 0 && isUnit(sig.ret)) this.w.line(`return [undefined, ${this.fn.inout.map((p) => this.local(p)).join(', ')}];`);
      });
    });
    this.w.line('');
    this.fn = null;
  }

  /** Parameter refinements and non-pinned `requires` are checked by the callee on entry. */
  private entryChecks(sig: Signature, contracts: readonly A.Contract[], defName: string): void {
    sig.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      if (pd === undefined) return;
      const declared = this.ty.declTypes.get(pd);
      if (declared === undefined) return;
      const node = this.t.node(this.t.def(pd).node);
      for (const pred of this.refinementPreds(declared)) {
        const ref = this.obRef('refinement', printExpr(pred), node.span, defName);
        this.w.line(`$rt.check(${this.withIt(this.local(p.name), () => this.expr(pred).code)}, ${ref});`);
      }
    });
    for (const c of contracts) {
      if (c.clause !== 'requires' || c.proved) continue;
      const ref = this.obRef('requires', printExpr(c.expr), c.span, defName);
      this.w.line(`$rt.check(${this.expr(c.expr).code}, ${ref});`);
    }
  }

  private refinementPreds(t: Type): A.Expr[] {
    const out: A.Expr[] = [];
    let cur = t;
    while (cur.k === 'refined') {
      const n = this.t.node(cur.pred);
      if (isExprNode(n)) out.push(n);
      cur = cur.base;
    }
    return out;
  }

  private withIt<T>(it: string, f: () => T): T {
    const saved = this.itName;
    this.itName = it;
    try {
      return f();
    } finally {
      this.itName = saved;
    }
  }

  private bodyWithTry(body: A.Block, emit: () => void): void {
    if (!containsTry(body)) {
      emit();
      return;
    }
    this.w.block('try {', emit, '} catch ($e) {');
    this.w.indent();
    this.w.line('if ($e instanceof $rt.EarlyReturn) return $e.value;');
    this.w.line('throw $e;');
    this.w.dedent();
    this.w.line('}');
  }

  private mainSpec(f: A.FnDecl): EmittedModule['main'] {
    const def = this.t.def(this.defOf(f));
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return null;
    const roots: Record<string, string> = {};
    let args = 'args';
    for (const p of sig.params) {
      const s = stripRefinements(p.type);
      if (s.k === 'capability') {
        const q = this.t.qualifiedName(s.def);
        if (q.startsWith('std.io.')) roots[p.name] = this.t.def(s.def).name;
      } else if (s.k === 'opaque') {
        args = p.name;
      }
    }
    return { roots, args };
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
        const def = this.t.def(this.defOf(s));
        const declared = this.ty.declTypes.get(def.id) ?? { k: 'error' };
        const type = this.opts.ts ? `: ${this.tsType(declared)}` : '';
        const value = this.widened(this.checkedFlow(s.value, declared), declared);
        this.w.line(`${s.kind === 'Let' ? 'const' : 'let'} ${this.local(def.name)}${type} = ${value};`);
        return;
      }
      case 'Assign': {
        const res = this.t.refs.get(s.id);
        const def = res !== undefined && res.k === 'def' ? this.t.def(res.def) : null;
        const target = def === null ? this.local(s.name.text) : this.local(def.name);
        const declared = def === null ? undefined : this.ty.declTypes.get(def.id);
        this.w.line(`${target} = ${this.checkedFlow(s.value, declared ?? { k: 'error' })};`);
        return;
      }
      case 'Return':
        this.returnStmt(s);
        return;
      case 'If':
        this.w.block(`if (${this.expr(s.cond).code}) {`, () => this.block(s.then), s.else ? '} else {' : '}');
        if (s.else) {
          const e = s.else;
          this.w.indent();
          this.block(e);
          this.w.dedent();
          this.w.line('}');
        }
        return;
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
        this.w.line(`// assume ${s.claim.segments.map((x) => x.text).join('.')} ${JSON.stringify(s.justification)}`);
        return;
      case 'ExprStmt': {
        const code = this.expr(s.expr, true).code;
        if (code !== '') this.w.line(`${code};`);
        return;
      }
    }
  }

  /** Emits `value`, wrapped in a refinement check when the flow into `declared` is a checked obligation. */
  private checkedFlow(value: A.Expr, declared: Type): string {
    const ob = this.ctx.contracts.find(value.id, 'refinement');
    const code = this.expr(value).code;
    if (ob === null || ob.status !== 'checked') return code;
    const preds = this.refinementPreds(declared);
    if (preds.length === 0) return code;
    const it = this.tmp('it');
    const checks = preds.map((p) => `$rt.check(${this.withIt(it, () => this.expr(p).code)}, ${this.obRefOf(ob)});`).join(' ');
    const itType = this.opts.ts ? `: ${this.tsType(declared)}` : '';
    return `$rt.checked(${code}, (${it}${itType}) => { ${checks} })`;
  }

  private returnStmt(s: A.Return): void {
    const fn = this.fn;
    if (fn === null) {
      this.w.line(`return ${this.expr(s.value).code};`);
      return;
    }
    const value = this.checkedFlow(s.value, fn.ret);
    const ensures = this.ctx.contracts.at(s.id).filter((o) => o.kind === 'ensures' && o.status === 'checked');
    const inoutTail = fn.inout.map((p) => `, ${this.local(p)}`).join('');
    if (ensures.length === 0) {
      this.w.line(`return ${fn.inout.length > 0 ? `[${value}${inoutTail}]` : value};`);
      return;
    }
    const r = this.tmp('r');
    const rType = this.opts.ts ? `: ${this.tsType(fn.ret)}` : '';
    this.w.block('{', () => {
      this.w.line(`const ${r}${rType} = ${this.widened(value, fn.ret)};`);
      fn.result = r;
      for (const o of ensures) {
        const clause = fn.ensures.find((c) => c.id === o.source);
        if (clause === undefined) continue;
        this.w.line(`$rt.check(${this.expr(clause.expr).code}, ${this.obRefOf(o)});`);
      }
      fn.result = null;
      this.w.line(`return ${fn.inout.length > 0 ? `[${r}${inoutTail}]` : r};`);
    });
  }

  private match(s: A.Match): void {
    const m = this.tmp('m');
    const scrutineeType = this.ty.exprTypes.get(s.scrutinee.id) ?? { k: 'error' };
    const mType = this.opts.ts ? `: ${this.tsType(scrutineeType)}` : '';
    this.w.line(`const ${m}${mType} = ${this.widened(this.expr(s.scrutinee).code, scrutineeType)};`);
    const label = this.tmp('match');
    this.w.block(`${label}: {`, () => {
      for (const arm of s.arms) {
        const test = this.patternTest(arm.pattern, m);
        this.w.block(`if (${test}) {`, () => {
          this.patternBindings(arm.pattern, m);
          if (arm.guard) {
            this.w.block(`if (${this.expr(arm.guard).code}) {`, () => {
              this.armBody(arm);
              this.w.line(`break ${label};`);
            });
          } else {
            this.armBody(arm);
            this.w.line(`break ${label};`);
          }
        });
      }
      this.w.line('$rt.unreachable();');
    });
  }

  private armBody(arm: A.Arm): void {
    if (arm.body.kind === 'Block') this.block(arm.body);
    else this.stmt(arm.body);
  }

  private patternTest(p: A.Pattern, subject: string): string {
    switch (p.kind) {
      case 'WildcardPat':
      case 'BindPat':
        return 'true';
      case 'LitPat':
        return `$rt.eq(${subject}, ${this.expr(p.literal).code})`;
      case 'VariantPat': {
        const res = this.t.refs.get(p.id);
        const name = res !== undefined && res.k === 'def' ? this.t.def(res.def).name : '?';
        return `${subject}.tag === ${JSON.stringify(name)}`;
      }
    }
  }

  private patternBindings(p: A.Pattern, subject: string): void {
    if (p.kind === 'BindPat') {
      this.w.line(`const ${this.local(p.name.text)} = ${subject};`);
      return;
    }
    if (p.kind !== 'VariantPat' || p.fields === null) return;
    const res = this.t.refs.get(p.id);
    if (res === undefined || res.k !== 'def') return;
    const fields = this.ty.fields.get(res.def) ?? [];
    let i = 0;
    for (const pf of p.fields) {
      if (pf.kind === 'PatFieldRest') break;
      const f = fields[i];
      if (pf.kind === 'PatFieldName' && f !== undefined) this.w.line(`const ${this.local(pf.name.text)} = ${subject}.${this.local(f.name)};`);
      i += 1;
    }
  }

  private loop(s: A.Loop): void {
    const obs = this.ctx.contracts.at(s.id);
    const invariants = s.clauses.filter((c) => c.clause === 'invariant');
    const decreases = s.clauses.find((c) => c.clause === 'decreases') ?? null;
    for (const inv of invariants) {
      const o = obs.find((x) => x.kind === 'invariant-entry' && x.source === inv.id);
      if (o !== undefined && o.status === 'checked') this.w.line(`$rt.check(${this.expr(inv.expr).code}, ${this.obRefOf(o)});`);
    }
    this.w.block(`while (${this.expr(s.cond).code}) {`, () => {
      const dec = decreases === null ? null : obs.find((x) => x.kind === 'decreases' && x.source === decreases.id) ?? null;
      const measure = this.tmp('measure');
      if (dec !== null && dec.status === 'checked' && decreases !== null) {
        this.w.line(`const ${measure} = ${this.expr(decreases.expr).code};`);
        this.w.line(`$rt.check(${measure} >= 0, ${this.obRefOf(dec)});`);
      }
      this.block(s.body);
      for (const inv of invariants) {
        const o = obs.find((x) => x.kind === 'invariant-step' && x.source === inv.id);
        if (o !== undefined && o.status === 'checked') this.w.line(`$rt.check(${this.expr(inv.expr).code}, ${this.obRefOf(o)});`);
      }
      if (dec !== null && dec.status === 'checked' && decreases !== null) {
        this.w.line(`$rt.check(${this.expr(decreases.expr).code} < ${measure}, ${this.obRefOf(dec)});`);
      }
    });
  }

  private forStmt(s: A.For): void {
    const def = this.t.def(this.defOf(s));
    const name = this.local(def.name);
    const declared = this.ty.declTypes.get(def.id) ?? { k: 'error' };
    if (s.domain.kind === 'RangeDomain') {
      const hiPiece = this.expr(s.domain.hi);
      let hi = hiPiece.code;
      if (hiPiece.prec < ATOM) {
        hi = this.tmp('hi');
        this.w.line(`const ${hi} = ${hiPiece.code};`);
      }
      const nt = this.opts.ts ? ': number' : '';
      this.w.block(`for (let ${name}${nt} = ${this.expr(s.domain.lo).code}; ${name} < ${hi}; ${name}++) {`, () => this.block(s.body));
      return;
    }
    const domain = this.checkedFlow(s.domain.expr, { k: 'error' });
    void domain;
    const ob = this.ctx.contracts.find(s.domain.expr.id, 'refinement');
    this.w.block(`for (const ${name} of ${this.expr(s.domain.expr).code}) {`, () => {
      if (ob !== null && ob.status === 'checked') {
        for (const p of this.refinementPreds(declared)) this.w.line(`$rt.check(${this.withIt(name, () => this.expr(p).code)}, ${this.obRefOf(ob)});`);
      }
      this.block(s.body);
    });
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /** Emits `e`; with `discard`, a call whose `inout` reassignments were emitted yields no expression. */
  expr(e: A.Expr, discard = false): Piece {
    switch (e.kind) {
      case 'IntLit':
        return piece(e.value.toString(), ATOM);
      case 'FloatLit':
        return piece(String(e.value), e.value < 0 ? UNARY : ATOM);
      case 'TextLit':
        return piece(JSON.stringify(e.value), ATOM);
      case 'BoolLit':
        return piece(e.value ? 'true' : 'false', ATOM);
      case 'DurationLit':
        return piece(e.nanos.toString(), ATOM);
      case 'Name':
        return this.name(e);
      case 'It':
        return piece(this.itName ?? '$it', ATOM);
      case 'ResultRef':
        return piece(this.fn?.result ?? '$r', ATOM);
      case 'Old':
        return piece(`$old_${e.name.text}`, ATOM);
      case 'Ctor':
        return this.ctor(e);
      case 'RecordUpdate':
        return this.recordUpdate(e);
      case 'ListLit':
        return piece(`[${e.elems.map((x) => this.expr(x).code).join(', ')}]`, ATOM);
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
      case 'FieldAccess':
        return this.fieldAccess(e);
      case 'Call':
        return this.call(e, discard);
      case 'Unary':
        return this.unary(e);
      case 'Binary':
        return this.binary(e);
      case 'And':
        return piece(e.operands.map((o) => at(this.expr(o), AND + 1)).join(' && '), AND);
      case 'Or':
        return piece(e.operands.map((o) => at(this.expr(o), OR + 1)).join(' || '), OR);
      case 'Is': {
        const v = this.expr(e.expr);
        if (e.pattern.kind === 'WildcardPat' || e.pattern.kind === 'BindPat') return piece('true', ATOM);
        const subject = at(v, CALL);
        return piece(this.patternTest(e.pattern, subject), e.pattern.kind === 'LitPat' ? CALL : EQ);
      }
    }
  }

  /** A declared function used as a value: an adapter from the positional convention of function values to its named parameters. */
  private fnValue(def: Def): Piece {
    const sig = this.ty.signatures.get(def.id);
    if (sig === undefined) return piece(this.defName(def), ATOM);
    const names = sig.params.map((p) => this.local(p.name));
    const typed = this.opts.ts ? sig.params.map((p) => `${this.local(p.name)}: ${this.tsType(p.type)}`) : names;
    return piece(`(${typed.join(', ')}) => ${this.defName(def)}({ ${names.join(', ')} })`, ARROW);
  }

  private name(e: A.Name): Piece {
    const res = this.t.refs.get(e.id);
    if (res === undefined || res.k !== 'def') return piece(this.local(e.name.text), ATOM);
    const def = this.t.def(res.def);
    if (def.kind === 'fn') return this.fnValue(def);
    if (def.kind === 'const') return piece(this.defName(def), ATOM);
    if (def.kind === 'field' && this.fieldObject !== null && this.fieldObject.record === def.parent) {
      return piece(`${this.fieldObject.name}.${this.local(def.name)}`, CALL);
    }
    return piece(this.local(def.name), ATOM);
  }

  private ctor(e: A.Ctor): Piece {
    const res = this.t.refs.get(e.id);
    if (res === undefined) return piece('undefined', ATOM);
    if (res.k === 'unit') return piece('undefined', ATOM);
    if (res.k === 'type-value') return piece(this.typeInfoLiteral(res.type.k === 'def' ? res.type.def : null, res.type.k === 'prim' ? res.type.name : null), CALL);
    if (res.k !== 'def') return piece('undefined', ATOM);
    const def = this.t.def(res.def);
    const inits = [...(e.args ?? []).map((a) => ({ name: a.name.text, value: a.value })), ...(e.fields ?? []).map((f) => ({ name: f.name.text, value: f.value }))];
    const parts = inits.map((i) => `${this.local(i.name)}: ${this.expr(i.value).code}`);
    if (def.kind === 'variant') parts.unshift(`tag: ${JSON.stringify(def.name)}`);
    const literal = `{ ${parts.join(', ')} }`;
    return this.fieldChecks(def, literal, inits.map((i) => i.value));
  }

  private recordUpdate(e: A.RecordUpdate): Piece {
    const base = this.ty.exprTypes.get(e.base.id);
    const s = base === undefined ? undefined : stripRefinements(base);
    const def = s !== undefined && s.k === 'record' ? this.t.def(s.def) : null;
    const literal = `{ ...${at(this.expr(e.base), CALL)}, ${e.fields.map((f) => `${this.local(f.name.text)}: ${this.expr(f.value).code}`).join(', ')} }`;
    if (def === null) return piece(literal, ATOM);
    return this.fieldChecks(def, literal, e.fields.map((f) => f.value));
  }

  /** Wraps a record or variant literal in the checks of its refined fields that have checked flows. */
  private fieldChecks(def: Def, literal: string, values: readonly A.Expr[]): Piece {
    const fields = this.ty.fields.get(def.id) ?? [];
    const checks: string[] = [];
    const v = this.tmp('v');
    const saved = this.fieldObject;
    this.fieldObject = { record: def.id, name: v };
    for (const value of values) {
      const ob = this.ctx.contracts.find(value.id, 'refinement');
      if (ob === null || ob.status !== 'checked') continue;
      const field = fields.find((f) => f.name === this.fieldNameFor(value, def));
      if (field === undefined) continue;
      for (const p of this.refinementPreds(field.type)) {
        checks.push(`$rt.check(${this.withIt(`${v}.${this.local(field.name)}`, () => this.expr(p).code)}, ${this.obRefOf(ob)});`);
      }
    }
    this.fieldObject = saved;
    if (checks.length === 0) return piece(literal, ATOM);
    const vt = this.opts.ts ? `: ${def.kind === 'record' ? this.tsType({ k: 'record', def: def.id, args: [] }) : this.variantMemberType(def)}` : '';
    return piece(`$rt.checked(${literal}, (${v}${vt}) => { ${checks.join(' ')} })`, CALL);
  }

  /** The TypeScript object type of one variant, for a field check's parameter. */
  private variantMemberType(variant: Def): string {
    const fields = (this.ty.fields.get(variant.id) ?? []).map((f) => `; readonly ${this.local(f.name)}: ${this.tsType(f.type)}`).join('');
    return `{ readonly tag: ${JSON.stringify(variant.name)}${fields} }`;
  }

  /** The field a constructor argument initialises: found by node identity in the enclosing Ctor/RecordUpdate. */
  private fieldNameFor(value: A.Expr, def: Def): string | null {
    const parent = this.findParentInit(value);
    void def;
    return parent;
  }

  private findParentInit(value: A.Expr): string | null {
    let found: string | null = null;
    walk(this.m.module, (n) => {
      if (found !== null) return false;
      if (n.kind === 'Ctor') {
        for (const a of n.args ?? []) if (a.value === value) found = a.name.text;
        for (const f of n.fields ?? []) if (f.value === value) found = f.name.text;
      }
      if (n.kind === 'RecordUpdate') for (const f of n.fields) if (f.value === value) found = f.name.text;
      return found === null;
    });
    return found;
  }

  private tryExpr(e: A.Try): Piece {
    const inner = this.ty.exprTypes.get(e.expr.id);
    const innerOption = inner !== undefined && this.isOption(inner);
    const fnRet = this.fn?.ret ?? null;
    const outerOption = fnRet !== null && this.isOption(fnRet);
    const operand = this.expr(e.expr).code;
    if (e.else === null) {
      if (innerOption && outerOption) return piece(`$rt.unwrapOption(${operand})`, CALL);
      return piece(`$rt.unwrap(${operand})`, CALL);
    }
    const name = this.local(e.else.name.text);
    const raw = this.expr(e.else.expr).code;
    // An arrow function returning an object literal needs the literal parenthesised.
    const body = raw.startsWith('{') ? `(${raw})` : raw;
    if (innerOption) return piece(`$rt.unwrapOptionElse(${operand}, (${name}) => ${body})`, CALL);
    return piece(`$rt.unwrapElse(${operand}, (${name}) => ${body})`, CALL);
  }

  private isOption(t: Type): boolean {
    const s = stripRefinements(t);
    if (s.k !== 'union') return false;
    const q = this.t.qualifiedName(s.def);
    return q === 'std.option.Option';
  }

  private recover(e: A.Recover): Piece {
    const w = this.w;
    const last = e.body.stmts[e.body.stmts.length - 1];
    const saved = this.fn;
    this.fn = saved === null ? null : { ...saved, ret: { k: 'error' }, ensures: [], inout: [] };
    const inner = new Writer();
    const outer = this.swapWriter(inner);
    inner.indent();
    for (const s of e.body.stmts) {
      if (s === last && s.kind === 'ExprStmt') inner.line(`return ${this.expr(s.expr).code};`);
      else this.stmt(s);
    }
    inner.dedent();
    this.swapWriter(outer);
    this.fn = saved;
    void w;
    return piece(`$rt.recover(() => {\n${inner.text()}\n})`, CALL);
  }

  private swapWriter(next: Writer): Writer {
    const current = this.w;
    this.w = next;
    return current;
  }

  private quantifier(e: A.Quantifier): Piece {
    const def = this.t.def(this.defOf(e));
    const name = this.local(def.name);
    let domain: string;
    if (e.domain === null) domain = '[true, false]';
    else if (e.domain.kind === 'RangeDomain') domain = `$rt.range(${this.expr(e.domain.lo).code}, ${this.expr(e.domain.hi).code})`;
    else {
      const dt = this.ty.exprTypes.get(e.domain.expr.id);
      const s = dt === undefined ? undefined : stripRefinements(dt);
      domain = s !== undefined && s.k === 'union' ? `$rt.okList(${this.expr(e.domain.expr).code})` : this.expr(e.domain.expr).code;
    }
    const nt = this.opts.ts ? `: ${this.tsType(this.ty.declTypes.get(def.id) ?? { k: 'error' })}` : '';
    const body = e.where === null ? this.expr(e.body).code : `${at(this.expr(e.where), OR + 1)} ? ${at(this.expr(e.body), ARROW + 1)} : ${e.quant === 'forall' ? 'true' : 'false'}`;
    return piece(`$rt.${e.quant}(${domain}, (${name}${nt}) => ${body})`, CALL);
  }

  private closure(e: A.Closure): Piece {
    const type = this.ty.exprTypes.get(e.id);
    const ft = type !== undefined && type.k === 'fn' ? type : null;
    const params = e.params.map((p) => this.local(p.name.text));
    const sigText = this.opts.ts && ft !== null
      ? `(${ft.params.map((p) => `${this.local(p.name)}: ${this.tsType(p.type)}`).join(', ')}): ${this.tsReturn(ft.ret, ft.params.filter((p) => p.inout).map((p) => p.type))}`
      : `(${params.join(', ')})`;
    const saved = this.fn;
    const olds = new Set<string>();
    this.fn = {
      inout: e.params.filter((p) => p.inout).map((p) => p.name.text),
      ret: ft?.ret ?? { k: 'error' },
      ensures: [],
      olds,
      def: saved?.def ?? this.t.def(this.defOf(this.m.module.items[0] ?? this.m.module)),
      dicts: saved?.dicts ?? new Map(),
      result: null,
    };
    const inner = new Writer();
    const outer = this.swapWriter(inner);
    inner.indent();
    for (const p of e.params) {
      const pd = this.t.defOf.get(p.id);
      const declared = pd === undefined ? undefined : this.ty.declTypes.get(pd);
      if (declared === undefined) continue;
      for (const pred of this.refinementPreds(declared)) {
        const ref = this.obRef('refinement', printExpr(pred), p.span, saved?.def.name ?? 'closure');
        inner.line(`$rt.check(${this.withIt(this.local(p.name.text), () => this.expr(pred).code)}, ${ref});`);
      }
    }
    this.bodyWithTry(e.body, () => {
      this.block(e.body);
      if (this.fn !== null && this.fn.inout.length > 0 && ft !== null && isUnit(ft.ret)) inner.line(`return [undefined, ${this.fn.inout.map((p) => this.local(p)).join(', ')}];`);
    });
    inner.dedent();
    this.swapWriter(outer);
    this.fn = saved;
    return piece(`${sigText} => {\n${inner.text()}\n}`, ARROW);
  }

  private fake(e: A.Fake): Piece {
    const res = this.t.refs.get(e.id);
    const kind = res !== undefined && res.k === 'def' ? this.t.def(res.def).name : 'capability';
    const fields = e.fields.map((f) => `${this.local(f.name.text)}: ${this.expr(f.value).code}`);
    return piece(`$rt.Capability.__fake(${JSON.stringify(kind)}, { ${fields.join(', ')} }, $rt.FAKE_TOKEN)`, CALL);
  }

  private fieldAccess(e: A.FieldAccess): Piece {
    const res = this.t.refs.get(e.id);
    if (res !== undefined) {
      if (res.k === 'def') {
        const d = this.t.def(res.def);
        return d.kind === 'fn' ? this.fnValue(d) : piece(this.defName(d), ATOM);
      }
      if (res.k === 'companion') return this.fnValue(this.t.def(res.fn));
      if (res.k === 'unit') return piece('undefined', ATOM);
      if (res.k === 'type-value') return piece(this.typeInfoLiteral(res.type.k === 'def' ? res.type.def : null, res.type.k === 'prim' ? res.type.name : null), CALL);
      return piece('undefined', ATOM);
    }
    return piece(`${at(this.expr(e.object), CALL)}.${this.local(e.name.text)}`, CALL);
  }

  private call(e: A.Call, discard = false): Piece {
    const res = this.t.refs.get(e.callee.id);
    let callee: string;
    let sig: Signature | null = null;
    let fnDef: Def | null = null;
    const target = res !== undefined && (res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn') ? this.t.def(res.k === 'def' ? res.def : res.fn) : null;
    if (res !== undefined && target !== null && (target.kind === 'fn' || target.kind === 'iface-fn')) {
      fnDef = target;
      sig = this.ty.signatures.get(fnDef.id) ?? null;
      const viaImpl = this.implFns.get(fnDef.id);
      if (res.k === 'iface-fn') callee = this.dispatch(res.iface, fnDef, e);
      else if (fnDef.kind === 'iface-fn' && viaImpl !== undefined) callee = viaImpl;
      else callee = this.defName(fnDef);
    } else {
      callee = at(this.expr(e.callee), CALL);
      const ct = this.ty.exprTypes.get(e.callee.id);
      const ft = ct === undefined ? undefined : stripRefinements(ct);
      if (ft !== undefined && ft.k === 'fn') return this.callValue(callee, ft, e, discard);
    }
    const parts: string[] = [];
    if (sig !== null && fnDef !== null) {
      const targs = this.ty.instantiations.get(e.id) ?? [];
      sig.tparams.forEach((p, i) => {
        const a = targs[i];
        if (p.k === 'type' && p.bound !== null) {
          const bound = a !== undefined && a.k === 'type' ? a.type : null;
          parts.push(`$dict_${this.t.def(p.def).name}: ${bound === null ? 'undefined' : this.dictFor(p.bound, bound)}`);
        } else if (p.k === 'const') {
          parts.push(`${this.local(this.t.def(p.def).name)}: ${a !== undefined && a.k === 'const' ? this.constLiteral(a.value) : 'undefined'}`);
        }
      });
    }
    for (const a of e.args) parts.push(`${this.local(a.name.text)}: ${this.expr(a.value).code}`);
    const call = `${callee}({ ${parts.join(', ')} })`;
    const inoutArgs = e.args.filter((a) => a.inout);
    if (inoutArgs.length === 0) return piece(call, CALL);
    // `inout`: the callee returns [result, ...params]; reassign the caller's variables.
    const r = discard ? '' : this.tmp('r');
    const names = inoutArgs.map((a) => (a.value.kind === 'Name' ? this.local(a.value.name.text) : this.tmp('x')));
    const tmps = names.map((n) => `${n}$`);
    this.w.line(`const [${r}, ${tmps.join(', ')}] = ${call};`);
    names.forEach((n, i) => this.w.line(`${n} = ${tmps[i] ?? n};`));
    return piece(r, ATOM);
  }

  /** A call through a function value: positional arguments in the type's parameter order. */
  private callValue(callee: string, ft: Extract<Type, { k: 'fn' }>, e: A.Call, discard: boolean): Piece {
    const ordered = ft.params.map((p) => e.args.find((a) => a.name.text === p.name));
    const call = `${callee}(${ordered.map((a) => (a === undefined ? 'undefined' : this.expr(a.value).code)).join(', ')})`;
    const inoutArgs = ordered.filter((a): a is A.Arg => a !== undefined && a.inout);
    if (inoutArgs.length === 0) return piece(call, CALL);
    const r = discard ? '' : this.tmp('r');
    const names = inoutArgs.map((a) => (a.value.kind === 'Name' ? this.local(a.value.name.text) : this.tmp('x')));
    const tmps = names.map((n) => `${n}$`);
    this.w.line(`const [${r}, ${tmps.join(', ')}] = ${call};`);
    names.forEach((n, i) => this.w.line(`${n} = ${tmps[i] ?? n};`));
    return piece(r, ATOM);
  }

  private constLiteral(v: ConstValue): string {
    switch (v.k) {
      case 'int':
      case 'duration':
        return v.v.toString();
      case 'float':
        return String(v.v);
      case 'bool':
        return v.v ? 'true' : 'false';
      case 'text':
        return JSON.stringify(v.v);
      case 'unit':
        return 'undefined';
      case 'variant':
        return `{ tag: ${JSON.stringify(this.t.def(v.def).name)} }`;
      case 'sym':
        return this.local(this.t.def(v.def).name);
      case 'error':
        return 'undefined';
    }
  }

  /** The dictionary expression implementing `iface` for `target`. */
  private dictFor(iface: DefId, target: Type): string {
    const s = stripRefinements(target);
    if (s.k === 'param') {
      const d = this.fn?.dicts.get(s.def);
      if (d !== undefined) return d;
    }
    const ifaceDef = this.t.def(iface);
    for (const m of this.t.modules) {
      for (const item of m.module.items) {
        if (item.kind !== 'ImplDecl') continue;
        const r = this.t.refs.get(item.id);
        if (r === undefined || r.k !== 'def' || r.def !== iface) continue;
        const targetType = this.ty.exprTypes.get(item.target.id) ?? this.targetTypeOf(item);
        if (this.typeSlug(targetType) !== this.typeSlug(s)) continue;
        const name = this.implDictName(ifaceDef, targetType);
        return m.id === this.m.id && this.selfAlias === null ? name : `${this.alias(m.id)}.${name}`;
      }
    }
    return 'undefined';
  }

  private targetTypeOf(item: A.ImplDecl): Type {
    return this.targetType(item);
  }

  private dispatch(iface: DefId, fn: Def, e: A.Call): string {
    const targs = this.ty.instantiations.get(e.id) ?? [];
    const last = targs[targs.length - 1];
    const target = last !== undefined && last.k === 'type' ? last.type : null;
    const inImpl = this.implFns.get(fn.id);
    if (inImpl !== undefined && target !== null && stripRefinements(target).k === 'param') return inImpl;
    if (target === null) return 'undefined';
    return `${this.dictFor(iface, target)}.${this.local(fn.name)}`;
  }

  private unary(e: A.Unary): Piece {
    const v = this.expr(e.operand);
    if (e.op === 'not') return piece(`!${at(v, UNARY)}`, UNARY);
    const t = this.ty.exprTypes.get(e.operand.id);
    const s = t === undefined ? undefined : stripRefinements(t);
    if (s !== undefined && s.k === 'prim' && (s.name === 'Int' || s.name === 'Duration')) {
      const ref = this.obRef('overflow', `-${printExpr(e.operand)} within Int`, e.span, this.fn?.def.name ?? '?');
      return piece(`$rt.int.neg(${v.code}, ${ref})`, CALL);
    }
    return piece(`-${at(v, UNARY)}`, UNARY);
  }

  private binary(e: A.Binary): Piece {
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    const lt = this.ty.exprTypes.get(e.left.id);
    const s = lt === undefined ? undefined : stripRefinements(lt);
    const isInt = s !== undefined && s.k === 'prim' && (s.name === 'Int' || s.name === 'Duration');
    switch (e.op) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%': {
        if (isInt) {
          const ob = this.ctx.contracts.find(e.id, 'overflow');
          const fnName = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'rem' }[e.op];
          if (ob !== null && ob.status === 'checked') return piece(`$rt.int.${fnName}(${l.code}, ${r.code}, ${this.obRefOf(ob)})`, CALL);
          if (e.op === '/') return piece(`Math.trunc(${at(l, MUL)} / ${at(r, MUL + 1)})`, CALL);
        }
        const prec = e.op === '+' || e.op === '-' ? ADD : MUL;
        return piece(`${at(l, prec)} ${e.op} ${at(r, prec + 1)}`, prec);
      }
      case '++': {
        const isText = s !== undefined && s.k === 'prim' && s.name === 'Text';
        if (isText) return piece(`${at(l, ADD)} + ${at(r, ADD + 1)}`, ADD);
        return piece(`[...${at(l, CALL)}, ...${at(r, CALL)}]`, ATOM);
      }
      case '==':
      case '!=': {
        const prim = s !== undefined && s.k === 'prim';
        if (prim) return piece(`${at(l, EQ + 1)} ${e.op === '==' ? '===' : '!=='} ${at(r, EQ + 1)}`, EQ);
        const eq = `$rt.eq(${l.code}, ${r.code})`;
        return e.op === '==' ? piece(eq, CALL) : piece(`!${eq}`, UNARY);
      }
      case '<':
      case '<=':
      case '>':
      case '>=':
        return piece(`${at(l, CMP + 1)} ${e.op} ${at(r, CMP + 1)}`, CMP);
      case 'implies':
        return piece(`!${at(l, UNARY)} || ${at(r, OR + 1)}`, OR);
    }
  }

  // -------------------------------------------------------------------------
  // Generated tests (§5.2, §3.6)
  // -------------------------------------------------------------------------

  private testsFile(): string | null {
    const examples = this.m.module.items.filter((i): i is A.ExampleDecl => i.kind === 'ExampleDecl');
    const properties = this.m.module.items.filter((i): i is A.PropertyDecl => i.kind === 'PropertyDecl');
    const impls = this.m.module.items.filter((i): i is A.ImplDecl => i.kind === 'ImplDecl');
    const laws = impls.flatMap((impl) => {
      const r = this.t.refs.get(impl.id);
      if (r === undefined || r.k !== 'def') return [];
      return this.t.defs.filter((d) => d.parent === r.def && d.kind === 'law').map((law) => ({ impl, law }));
    });
    if (examples.length === 0 && properties.length === 0 && laws.length === 0) return null;
    const inner = new Writer();
    const outerWriter = this.swapWriter(inner);
    const savedImports = new Map(this.imports);
    this.imports.clear();
    this.selfAlias = '$self';
    this.imports.set(this.m.id, '$self');
    const obSaved = this.obDecls.splice(0);
    const obRefsSaved = new Map(this.obRefs);
    this.obRefs.clear();
    inner.line(`import { test, expect } from 'vitest';`);
    inner.line(`import * as fc from 'fast-check';`);
    for (const ex of examples) {
      inner.block(`test(${JSON.stringify(ex.name.text)}, () => {`, () => {
        this.fn = null;
        for (const s of ex.body.stmts) {
          if (s.kind === 'ExprStmt') inner.line(`expect(${this.expr(s.expr).code}).toBe(true);`);
          else this.stmt(s);
        }
      }, '});');
    }
    for (const p of properties) this.propertyTest(p);
    for (const { impl, law } of laws) this.lawTest(impl, law);
    const head = new Writer();
    head.line(`// Generated by onus: tests of module ${this.m.name}.`);
    head.line(`import * as $rt from ${JSON.stringify(this.opts.runtime)};`);
    for (const [id, alias] of this.imports) head.line(`import * as ${alias} from ${JSON.stringify(id === this.m.id ? `./${this.m.name.split('.').pop() ?? ''}.js` : this.relativeImport(id))};`);
    head.line('');
    for (const d of this.obDecls) head.line(d);
    const text = `${head.text()}\n${inner.text()}\n`;
    this.swapWriter(outerWriter);
    this.selfAlias = null;
    this.imports.clear();
    for (const [k, v] of savedImports) this.imports.set(k, v);
    this.obDecls.splice(0, this.obDecls.length, ...obSaved);
    this.obRefs.clear();
    for (const [k, v] of obRefsSaved) this.obRefs.set(k, v);
    return text;
  }

  private propertyTest(p: A.PropertyDecl): void {
    const gens = p.params.map((param) => {
      const pd = this.t.defOf.get(param.id);
      const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
      return this.generator(type ?? { k: 'error' });
    });
    const names = p.params.map((param) => this.local(param.name.text));
    this.w.block(`test(${JSON.stringify(`property ${p.name.text}`)}, () => {`, () => {
      this.w.block(`fc.assert(fc.property(${gens.join(', ')}, (${names.join(', ')}) => {`, () => {
        this.fn = null;
        for (const s of p.body.stmts) {
          if (s.kind === 'ExprStmt') this.w.line(`if (!(${this.expr(s.expr).code})) return false;`);
          else this.stmt(s);
        }
        this.w.line('return true;');
      }, '}));');
    }, '});');
  }

  private lawTest(impl: A.ImplDecl, law: Def): void {
    const node = this.t.node(law.node);
    if (node.kind !== 'Law') return;
    const ifaceRes = this.t.refs.get(impl.id);
    if (ifaceRes === undefined || ifaceRes.k !== 'def') return;
    const iface = this.t.def(ifaceRes.def);
    const target = this.targetType(impl);
    const tp = this.t.defs.find((d) => d.kind === 'type-param' && d.node === iface.node);
    const subst = new Map<DefId, TypeArg>();
    if (tp !== undefined) subst.set(tp.id, { k: 'type', type: target });
    const map = new Map<DefId, string>();
    for (const f of impl.fns) {
      const fd = this.t.def(this.defOf(f));
      const want = this.t.defs.find((d) => d.parent === iface.id && d.kind === 'iface-fn' && d.name === f.name.text);
      if (want !== undefined) map.set(want.id, `$self.${this.implFnName(fd)}`);
    }
    this.implFns = map;
    const gens = node.params.map((param) => {
      const pd = this.t.defOf.get(param.id);
      const type = pd === undefined ? undefined : this.ty.declTypes.get(pd);
      return this.generator(substitute(type ?? { k: 'error' }, subst));
    });
    const names = node.params.map((param) => this.local(param.name.text));
    this.w.block(`test(${JSON.stringify(`law ${iface.name}[${this.typeSlug(target)}].${law.name}`)}, () => {`, () => {
      this.w.block(`fc.assert(fc.property(${gens.join(', ')}, (${names.join(', ')}) => {`, () => {
        this.fn = null;
        for (const s of node.body.stmts) {
          if (s.kind === 'ExprStmt') this.w.line(`if (!(${this.expr(s.expr).code})) return false;`);
          else this.stmt(s);
        }
        this.w.line('return true;');
      }, '}));');
    }, '});');
    this.implFns = new Map();
  }

  /** A fast-check generator for `t`, filtered by its refinements. */
  private generator(t: Type): string {
    const preds = this.refinementPreds(t);
    const base = this.baseGenerator(stripRefinements(t));
    if (preds.length === 0) return base;
    const it = this.tmp('it');
    const cond = preds.map((p) => at(this.withIt(it, () => this.expr(p)), AND + 1)).join(' && ');
    return `${base}.filter((${it}) => ${cond})`;
  }

  private baseGenerator(s: Type): string {
    switch (s.k) {
      case 'prim':
        switch (s.name) {
          case 'Int':
            return 'fc.integer({ min: -1000000, max: 1000000 })';
          case 'Float':
            return 'fc.double({ noNaN: true, noDefaultInfinity: true })';
          case 'Duration':
            return 'fc.integer({ min: 0, max: 1000000000 })';
          case 'Bool':
            return 'fc.boolean()';
          case 'Text':
            return 'fc.string()';
          case 'Unit':
            return 'fc.constant(undefined)';
          default:
            return 'fc.constant(undefined)';
        }
      case 'opaque': {
        const a0 = s.args[0];
        if (this.t.qualifiedName(s.def) === 'std.list.List' && a0?.k === 'type') return `fc.array(${this.generator(a0.type)}, { maxLength: 8 })`;
        return 'fc.constant(undefined)';
      }
      case 'record': {
        const def = this.t.def(s.def);
        const fields = (this.ty.fields.get(def.id) ?? []).map((f) => `${this.local(f.name)}: ${this.generator(f.type)}`);
        return `fc.record({ ${fields.join(', ')} })`;
      }
      case 'union': {
        const def = this.t.def(s.def);
        const variants = (this.ty.variants.get(def.id) ?? []).map((v) => {
          const fields = (this.ty.fields.get(v) ?? []).map((f) => `${this.local(f.name)}: ${this.generator(f.type)}`);
          return `fc.record({ tag: fc.constant(${JSON.stringify(this.t.def(v).name)})${fields.length > 0 ? `, ${fields.join(', ')}` : ''} })`;
        });
        return `fc.oneof(${variants.join(', ')})`;
      }
      default:
        return 'fc.constant(undefined)';
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrap(t: string): string {
  return /^[A-Za-z0-9_.$<>, ]+$/.test(t) ? t : `(${t})`;
}

function isUnit(t: Type): boolean {
  const s = stripRefinements(t);
  return s.k === 'prim' && s.name === 'Unit';
}

/** True iff `b` contains a `try` outside any nested closure. */
function containsTry(b: A.Block): boolean {
  let found = false;
  walk(b, (n) => {
    if (found) return false;
    if (n.kind === 'Closure') return false;
    if (n.kind === 'Try') found = true;
    return !found;
  });
  return found;
}

function isExprNode(n: A.Node): n is A.Expr {
  switch (n.kind) {
    case 'IntLit':
    case 'FloatLit':
    case 'TextLit':
    case 'BoolLit':
    case 'DurationLit':
    case 'Name':
    case 'It':
    case 'ResultRef':
    case 'Ctor':
    case 'RecordUpdate':
    case 'ListLit':
    case 'Try':
    case 'Recover':
    case 'Old':
    case 'Quantifier':
    case 'Closure':
    case 'Fake':
    case 'FieldAccess':
    case 'Call':
    case 'Unary':
    case 'Binary':
    case 'And':
    case 'Or':
    case 'Is':
      return true;
    default:
      return false;
  }
}
