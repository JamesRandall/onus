/**
 * Type representation (impl spec §3.3).
 *
 * Subtyping is refinement subsumption only: `refined(base, p) <: base`, and a
 * flow into a refined position generates an obligation (milestone 5+). Type
 * equality on generics is nominal on `def`. Capability types additionally
 * carry attenuation restrictions (§8.2): a more-restricted capability is
 * accepted where a less-restricted one is required.
 */
import { EffectSet } from '../effects/set.js';
import type { DefId, PrimName, ResolveTables } from '../resolve/defs.js';
import type { NodeId } from '../syntax/ast.js';

export type Type =
  | { readonly k: 'prim'; readonly name: PrimName }
  /** `base where pred`; `alias` names the `type` declaration that introduced it, for printing. */
  | { readonly k: 'refined'; readonly base: Type; readonly pred: NodeId; readonly alias: DefId | null }
  | { readonly k: 'record'; readonly def: DefId; readonly args: readonly TypeArg[] }
  | { readonly k: 'union'; readonly def: DefId; readonly args: readonly TypeArg[] }
  /** An `intrinsic type`. */
  | { readonly k: 'opaque'; readonly def: DefId; readonly args: readonly TypeArg[] }
  | { readonly k: 'capability'; readonly def: DefId; readonly args: readonly TypeArg[]; readonly restrictions: readonly Restriction[] }
  | { readonly k: 'fn'; readonly params: readonly FnParam[]; readonly ret: Type; readonly effects: EffectSet }
  | { readonly k: 'param'; readonly def: DefId }
  | { readonly k: 'typeinfo' }
  | { readonly k: 'spec' }
  /** Poison: produced after an error, compatible with everything, never reported again. */
  | { readonly k: 'error' };

export type TypeArg =
  | { readonly k: 'type'; readonly type: Type }
  | { readonly k: 'const'; readonly value: ConstValue }
  /** The binding of an effect parameter at an instantiation. */
  | { readonly k: 'effects'; readonly effects: EffectSet };

export type ConstValue =
  | { readonly k: 'int'; readonly v: bigint }
  | { readonly k: 'float'; readonly v: number }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'duration'; readonly v: bigint }
  | { readonly k: 'unit' }
  | { readonly k: 'variant'; readonly def: DefId }
  /** A parameter used as an index (`Grid[T, width, height]`), equal only to itself. */
  | { readonly k: 'sym'; readonly def: DefId }
  /** Poison after a reported error; equal to everything. */
  | { readonly k: 'error' };

export interface FnParam {
  readonly name: string;
  readonly inout: boolean;
  readonly type: Type;
}

export interface Restriction {
  readonly label: string;
  readonly value: ConstValue;
}

export const INT: Type = { k: 'prim', name: 'Int' };
export const FLOAT: Type = { k: 'prim', name: 'Float' };
export const BOOL: Type = { k: 'prim', name: 'Bool' };
export const TEXT: Type = { k: 'prim', name: 'Text' };
export const UNIT: Type = { k: 'prim', name: 'Unit' };
export const BYTES: Type = { k: 'prim', name: 'Bytes' };
export const DURATION: Type = { k: 'prim', name: 'Duration' };
export const ERROR: Type = { k: 'error' };
export const TYPEINFO: Type = { k: 'typeinfo' };

export function prim(name: PrimName): Type {
  return { k: 'prim', name };
}

/** Removes every refinement layer. Effects: none. */
export function stripRefinements(t: Type): Type {
  let cur = t;
  while (cur.k === 'refined') cur = cur.base;
  return cur;
}

/** True iff `t` is `refined` at the top, i.e. flowing into it needs an obligation. Effects: none. */
export function isRefined(t: Type): boolean {
  return t.k === 'refined';
}

export function constEquals(a: ConstValue, b: ConstValue): boolean {
  if (a.k === 'error' || b.k === 'error') return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'int':
      return b.k === 'int' && a.v === b.v;
    case 'float':
      return b.k === 'float' && a.v === b.v;
    case 'bool':
      return b.k === 'bool' && a.v === b.v;
    case 'text':
      return b.k === 'text' && a.v === b.v;
    case 'duration':
      return b.k === 'duration' && a.v === b.v;
    case 'unit':
      return true;
    case 'variant':
      return b.k === 'variant' && a.def === b.def;
    case 'sym':
      return b.k === 'sym' && a.def === b.def;
  }
}

function argsEqual(a: readonly TypeArg[], b: readonly TypeArg[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.k === 'type' && y.k === 'type') {
      if (!sameBase(x.type, y.type)) return false;
    } else if (x.k === 'const' && y.k === 'const') {
      if (!constEquals(x.value, y.value)) return false;
    } else if (x.k === 'effects' && y.k === 'effects') {
      if (!x.effects.equals(y.effects)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Equality of types after stripping refinements (the relation the type
 * checker enforces; refinement predicates become obligations later).
 * Effects: none.
 */
export function sameBase(a: Type, b: Type): boolean {
  const x = stripRefinements(a);
  const y = stripRefinements(b);
  if (x.k === 'error' || y.k === 'error') return true;
  if (x.k !== y.k) return false;
  switch (x.k) {
    case 'prim':
      return y.k === 'prim' && x.name === y.name;
    case 'record':
    case 'union':
    case 'opaque':
      return y.k === x.k && x.def === y.def && argsEqual(x.args, y.args);
    case 'capability':
      return y.k === 'capability' && x.def === y.def && argsEqual(x.args, y.args) && restrictionsEqual(x.restrictions, y.restrictions);
    case 'fn': {
      if (y.k !== 'fn' || x.params.length !== y.params.length) return false;
      for (let i = 0; i < x.params.length; i++) {
        const p = x.params[i];
        const q = y.params[i];
        if (p === undefined || q === undefined || p.inout !== q.inout || !sameBase(p.type, q.type)) return false;
      }
      return sameBase(x.ret, y.ret);
    }
    case 'param':
      return y.k === 'param' && x.def === y.def;
    case 'typeinfo':
    case 'spec':
      return true;
    case 'refined':
      return false;
  }
}

function restrictionsEqual(a: readonly Restriction[], b: readonly Restriction[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r) => b.some((s) => s.label === r.label && constEquals(r.value, s.value)));
}

/**
 * Whether a value of type `actual` may flow into a position of type
 * `expected`, ignoring refinement predicates (which become obligations) and
 * effects (checked by the effects pass). Capabilities: `actual` may carry
 * restrictions `expected` lacks (§8.2). Effects: none.
 */
export function assignable(actual: Type, expected: Type): boolean {
  const x = stripRefinements(actual);
  const y = stripRefinements(expected);
  if (x.k === 'error' || y.k === 'error') return true;
  if (x.k === 'capability' && y.k === 'capability') {
    if (x.def !== y.def || !argsEqual(x.args, y.args)) return false;
    return y.restrictions.every((r) => x.restrictions.some((s) => s.label === r.label && constEquals(r.value, s.value)));
  }
  return sameBase(x, y);
}

export type Subst = ReadonlyMap<DefId, TypeArg>;

/** Replaces type and const parameters bound in `subst`. Effects: none. */
export function substitute(t: Type, subst: Subst): Type {
  if (subst.size === 0) return t;
  switch (t.k) {
    case 'prim':
    case 'typeinfo':
    case 'spec':
    case 'error':
      return t;
    case 'refined':
      return { k: 'refined', base: substitute(t.base, subst), pred: t.pred, alias: t.alias };
    case 'record':
    case 'union':
    case 'opaque':
      return { k: t.k, def: t.def, args: t.args.map((a) => substituteArg(a, subst)) };
    case 'capability':
      return { k: 'capability', def: t.def, args: t.args.map((a) => substituteArg(a, subst)), restrictions: t.restrictions.map((r) => ({ label: r.label, value: substituteConst(r.value, subst) })) };
    case 'fn':
      return {
        k: 'fn',
        params: t.params.map((p) => ({ name: p.name, inout: p.inout, type: substitute(p.type, subst) })),
        ret: substitute(t.ret, subst),
        effects: substituteEffects(t.effects, subst),
      };
    case 'param': {
      const b = subst.get(t.def);
      return b !== undefined && b.k === 'type' ? b.type : t;
    }
  }
}

export function substituteArg(a: TypeArg, subst: Subst): TypeArg {
  if (a.k === 'type') return { k: 'type', type: substitute(a.type, subst) };
  if (a.k === 'const') return { k: 'const', value: substituteConst(a.value, subst) };
  return a;
}

/** Replaces effect parameters bound in `subst`. Effects: none. */
export function substituteEffects(effects: EffectSet, subst: Subst): EffectSet {
  return effects.substitute((def) => {
    const b = subst.get(def);
    return b !== undefined && b.k === 'effects' ? b.effects : null;
  });
}

export function substituteConst(v: ConstValue, subst: Subst): ConstValue {
  if (v.k !== 'sym') return v;
  const b = subst.get(v.def);
  return b !== undefined && b.k === 'const' ? b.value : v;
}

/** Renders a type in Onus syntax for diagnostics. Effects: none. */
export function typeToString(t: Type, tables: ResolveTables): string {
  const show = (x: Type): string => {
    switch (x.k) {
      case 'prim':
        return x.name;
      case 'refined':
        return x.alias !== null ? tables.def(x.alias).name : `${show(x.base)} where …`;
      case 'record':
      case 'union':
      case 'opaque':
        return `${tables.def(x.def).name}${showArgs(x.args)}`;
      case 'capability': {
        const parts = [...x.args.map(showArg), ...x.restrictions.map((r) => `${r.label}: ${constToString(r.value, tables)}`)];
        return `${tables.def(x.def).name}${parts.length > 0 ? `[${parts.join(', ')}]` : ''}`;
      }
      case 'fn': {
        const eff = x.effects.size > 0 ? ` ! ${effectsToString(x.effects, tables)}` : '';
        return `fn(${x.params.map((p) => `${p.name}: ${p.inout ? 'inout ' : ''}${show(p.type)}`).join(', ')}) -> ${show(x.ret)}${eff}`;
      }
      case 'param':
        return tables.def(x.def).name;
      case 'typeinfo':
        return 'TypeInfo';
      case 'spec':
        return 'Spec';
      case 'error':
        return '<error>';
    }
  };
  const showArg = (a: TypeArg): string => (a.k === 'type' ? show(a.type) : a.k === 'const' ? constToString(a.value, tables) : `! ${effectsToString(a.effects, tables)}`);
  const showArgs = (args: readonly TypeArg[]): string => (args.length > 0 ? `[${args.map(showArg).join(', ')}]` : '');
  return show(t);
}

export function constToString(v: ConstValue, tables: ResolveTables): string {
  switch (v.k) {
    case 'int':
      return v.v.toString();
    case 'float':
      return String(v.v);
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'text':
      return JSON.stringify(v.v);
    case 'duration':
      return `${v.v}ns`;
    case 'unit':
      return 'Unit';
    case 'variant':
    case 'sym':
      return tables.def(v.def).name;
    case 'error':
      return '<error>';
  }
}

export function emptyEffects(): EffectSet {
  return EffectSet.empty();
}

/** Renders an effect set as `a, b.c` for diagnostics. Effects: none. */
export function effectsToString(effects: EffectSet, tables: ResolveTables): string {
  return effects
    .values()
    .map((e) => (e.k === 'prim' ? e.name : e.k === 'resource' ? e.name : tables.def(e.def).name))
    .sort()
    .join(', ');
}
