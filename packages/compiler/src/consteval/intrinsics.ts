/**
 * The bridge between the check-time evaluator and the runtime package: a
 * `const intrinsic fn` is evaluated by calling the same implementation the
 * generated code will call (language spec §3.12), converting values to and
 * from the runtime's representations. `std.typeinfo` intrinsics are the one
 * exception: types exist only at check time, so they are implemented here.
 */
import * as runtime from '@onus/runtime';
import type { DefId, ResolveTables } from '../resolve/defs.js';
import type { TypeTables } from '../types/tables.js';
import { stripRefinements, substitute, typeToString, type Type, type TypeArg } from '../types/type.js';
import { int, text, UNIT, type Value } from './values.js';

export class ConversionError extends Error {}

/** A runtime function taking positional arguments in declaration order. */
type Impl = (args: readonly unknown[]) => unknown;

function str(x: unknown): string {
  if (typeof x !== 'string') throw new ConversionError('expected Text');
  return x;
}
function num(x: unknown): number {
  if (typeof x !== 'number') throw new ConversionError('expected a number');
  return x;
}
function bool(x: unknown): boolean {
  if (typeof x !== 'boolean') throw new ConversionError('expected Bool');
  return x;
}
function arr(x: unknown): readonly unknown[] {
  if (!Array.isArray(x)) throw new ConversionError('expected a List');
  return x;
}
function u8(x: unknown): Uint8Array {
  if (!(x instanceof Uint8Array)) throw new ConversionError('expected Bytes');
  return x;
}

/** Runtime implementations by qualified Onus name. */
const IMPLS: ReadonlyMap<string, Impl> = new Map<string, Impl>([
  ['std.int.to_text', (a) => runtime.int.to_text(num(a[0]))],
  ['std.int.floor', (a) => runtime.int.floor(num(a[0]))],
  ['std.float.of', (a) => runtime.float.of(num(a[0]))],
  ['std.float.classify', (a) => runtime.float.classify(num(a[0]))],
  ['std.float.to_text', (a) => runtime.float.to_text(num(a[0]))],
  ['std.bool.to_text', (a) => runtime.bool.to_text(bool(a[0]))],
  ['std.text.len', (a) => runtime.text.len(str(a[0]))],
  ['std.text.graphemes', (a) => runtime.text.graphemes(str(a[0]))],
  ['std.text.bytes', (a) => runtime.text.bytes(str(a[0]))],
  ['std.text.starts_with', (a) => runtime.text.starts_with(str(a[0]), str(a[1]))],
  ['std.text.lower', (a) => runtime.text.lower(str(a[0]))],
  ['std.text.trim', (a) => runtime.text.trim(str(a[0]))],
  ['std.list.len', (a) => runtime.list.len(arr(a[0]))],
  ['std.list.get', (a) => runtime.list.get(arr(a[0]), num(a[1]))],
  ['std.list.replicate', (a) => runtime.list.replicate(a[0], num(a[1]))],
  ['std.list.append', (a) => runtime.list.append(arr(a[0]), a[1])],
  ['std.list.slice', (a) => runtime.list.slice(arr(a[0]), num(a[1]), num(a[2]))],
  ['std.bytes.len', (a) => runtime.bytes.len(u8(a[0]))],
  ['std.bytes.get', (a) => runtime.bytes.get(u8(a[0]), num(a[1]))],
  ['std.duration.nanos', (a) => runtime.duration.nanos(num(a[0]))],
  ['std.duration.of_millis', (a) => runtime.duration.of_millis(num(a[0]))],
]);

/** True iff the runtime implements `qualifiedName`. Effects: none. */
export function hasImpl(qualifiedName: string): boolean {
  return IMPLS.has(qualifiedName) || qualifiedName.startsWith('std.typeinfo.');
}

/** Onus value → runtime representation. Effects: none. */
export function toRuntime(v: Value, c: Conversion): unknown {
  switch (v.k) {
    case 'int':
    case 'float':
    case 'duration':
      return v.v;
    case 'bool':
      return v.v;
    case 'text':
      return v.v;
    case 'unit':
      return undefined;
    case 'bytes':
      return v.v;
    case 'list':
      return v.items.map((x) => toRuntime(x, c));
    case 'record': {
      const o: Record<string, unknown> = {};
      for (const [n, f] of v.fields) o[n] = toRuntime(f, c);
      return o;
    }
    case 'variant': {
      const o: Record<string, unknown> = { tag: c.resolve.def(v.def).name };
      for (const [n, f] of v.fields) o[n] = toRuntime(f, c);
      return o;
    }
    case 'typeinfo':
      throw new ConversionError('a TypeInfo has no runtime representation');
  }
}

export interface Conversion {
  readonly resolve: ResolveTables;
  readonly types: TypeTables;
}

/** Runtime representation → Onus value of type `type`. Effects: none. */
export function fromRuntime(x: unknown, type: Type, c: Conversion): Value {
  const t = stripRefinements(type);
  switch (t.k) {
    case 'prim':
      switch (t.name) {
        case 'Int':
          return int(num(x));
        case 'Float':
          return { k: 'float', v: num(x) };
        case 'Duration':
          return { k: 'duration', v: num(x) };
        case 'Bool':
          return { k: 'bool', v: bool(x) };
        case 'Text':
          return text(str(x));
        case 'Unit':
          return UNIT;
        case 'Bytes':
          return { k: 'bytes', v: u8(x) };
        default:
          throw new ConversionError(`cannot convert a ${t.name}`);
      }
    case 'opaque': {
      const listDef = stdType(c.resolve, 'std.list', 'List');
      const a0 = t.args[0];
      if (t.def === listDef && a0?.k === 'type') return { k: 'list', items: arr(x).map((e) => fromRuntime(e, a0.type, c)) };
      throw new ConversionError(`cannot convert a ${typeToString(t, c.resolve)}`);
    }
    case 'record': {
      const o = obj(x);
      const fields = new Map<string, Value>();
      const subst = substOf(c, t.def, t.args);
      for (const f of c.types.fields.get(t.def) ?? []) fields.set(f.name, fromRuntime(o[f.name], substitute(f.type, subst), c));
      return { k: 'record', def: t.def, fields };
    }
    case 'union': {
      const o = obj(x);
      const tag = str(o['tag']);
      const variant = (c.types.variants.get(t.def) ?? []).find((v) => c.resolve.def(v).name === tag);
      if (variant === undefined) throw new ConversionError(`no variant \`${tag}\` in ${typeToString(t, c.resolve)}`);
      const fields = new Map<string, Value>();
      const subst = substOf(c, t.def, t.args);
      for (const f of c.types.fields.get(variant) ?? []) fields.set(f.name, fromRuntime(o[f.name], substitute(f.type, subst), c));
      return { k: 'variant', def: variant, fields };
    }
    default:
      throw new ConversionError(`cannot convert a ${typeToString(t, c.resolve)}`);
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function obj(x: unknown): Record<string, unknown> {
  if (!isObject(x)) throw new ConversionError('expected an object');
  return x;
}

function substOf(c: Conversion, def: DefId, args: readonly TypeArg[]): Map<DefId, TypeArg> {
  const subst = new Map<DefId, TypeArg>();
  (c.types.typeParams.get(def) ?? []).forEach((p, i) => {
    const a = args[i];
    if (a !== undefined) subst.set(p.def, a);
  });
  return subst;
}

export function stdType(resolve: ResolveTables, moduleName: string, typeName: string): DefId | null {
  const m = resolve.byName.get(moduleName);
  if (m === undefined) return null;
  return resolve.membersOf(m).types.get(typeName) ?? null;
}

/**
 * Calls the runtime implementation of `qualifiedName` with Onus values and
 * converts the result to `ret`. Throws `runtime.Panic` when the intrinsic's
 * own precondition fails, `ConversionError` on a representation mismatch.
 * Effects: those of the intrinsic (none: only pure intrinsics are registered).
 */
export function callImpl(qualifiedName: string, args: readonly Value[], ret: Type, c: Conversion): Value {
  const impl = IMPLS.get(qualifiedName);
  if (impl === undefined) throw new ConversionError(`no runtime implementation of ${qualifiedName}`);
  return fromRuntime(impl(args.map((a) => toRuntime(a, c))), ret, c);
}

export { runtime };
