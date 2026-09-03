/**
 * Check-time values (language spec §3.8; impl spec milestone 4).
 *
 * The evaluator's values mirror the runtime's representations exactly so
 * that check-time and run-time evaluation agree: `Int`, `Float` and
 * `Duration` are JavaScript numbers (Int within ±2^53), records are field
 * maps, unions are tagged, and a type passed as a value is a `TypeInfo`.
 */
import type { DefId, TypeOwner } from '../resolve/defs.js';
import type { ConstValue } from '../types/type.js';

export type Value =
  | { readonly k: 'int'; readonly v: number }
  | { readonly k: 'float'; readonly v: number }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'duration'; readonly v: number }
  | { readonly k: 'unit' }
  | { readonly k: 'bytes'; readonly v: Uint8Array }
  | { readonly k: 'list'; readonly items: readonly Value[] }
  | { readonly k: 'record'; readonly def: DefId; readonly fields: ReadonlyMap<string, Value> }
  | { readonly k: 'variant'; readonly def: DefId; readonly fields: ReadonlyMap<string, Value> }
  | { readonly k: 'typeinfo'; readonly owner: TypeOwner };

export const UNIT: Value = { k: 'unit' };

export function int(v: number): Value {
  return { k: 'int', v };
}
export function bool(v: boolean): Value {
  return { k: 'bool', v };
}
export function text(v: string): Value {
  return { k: 'text', v };
}

/** Structural equality (the meaning of `==`). Function values never reach here. Effects: none. */
export function valueEquals(a: Value, b: Value): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'int':
    case 'float':
    case 'duration':
      return b.k === a.k && a.v === b.v;
    case 'bool':
      return b.k === 'bool' && a.v === b.v;
    case 'text':
      return b.k === 'text' && a.v === b.v;
    case 'unit':
      return true;
    case 'bytes':
      return b.k === 'bytes' && a.v.length === b.v.length && a.v.every((x, i) => x === b.v[i]);
    case 'list':
      return b.k === 'list' && a.items.length === b.items.length && a.items.every((x, i) => {
        const y = b.items[i];
        return y !== undefined && valueEquals(x, y);
      });
    case 'record':
    case 'variant': {
      if (b.k !== a.k || a.def !== b.def || a.fields.size !== b.fields.size) return false;
      for (const [name, x] of a.fields) {
        const y = b.fields.get(name);
        if (y === undefined || !valueEquals(x, y)) return false;
      }
      return true;
    }
    case 'typeinfo':
      return b.k === 'typeinfo' && ownerEquals(a.owner, b.owner);
  }
}

function ownerEquals(a: TypeOwner, b: TypeOwner): boolean {
  return a.k === 'def' ? b.k === 'def' && a.def === b.def : b.k === 'prim' && a.name === b.name;
}

/**
 * A type index as a value, or null for a symbolic index (a parameter).
 * Effects: none.
 */
export function ofConst(c: ConstValue): Value | null {
  switch (c.k) {
    case 'int':
      return Number.isSafeInteger(Number(c.v)) ? int(Number(c.v)) : null;
    case 'float':
      return { k: 'float', v: c.v };
    case 'bool':
      return bool(c.v);
    case 'text':
      return text(c.v);
    case 'duration':
      return { k: 'duration', v: Number(c.v) };
    case 'unit':
      return UNIT;
    case 'variant':
      return { k: 'variant', def: c.def, fields: new Map() };
    case 'sym':
    case 'error':
      return null;
  }
}

/** A value as a type index, or null when it cannot be one. Effects: none. */
export function toConst(v: Value): ConstValue | null {
  switch (v.k) {
    case 'int':
      return { k: 'int', v: BigInt(v.v) };
    case 'float':
      return { k: 'float', v: v.v };
    case 'bool':
      return { k: 'bool', v: v.v };
    case 'text':
      return { k: 'text', v: v.v };
    case 'duration':
      return { k: 'duration', v: BigInt(v.v) };
    case 'unit':
      return { k: 'unit' };
    case 'variant':
      return v.fields.size === 0 ? { k: 'variant', def: v.def } : null;
    default:
      return null;
  }
}

/** Renders a value in Onus syntax for diagnostics. Effects: none. */
export function valueToString(v: Value, nameOf: (def: DefId) => string, ownerName: (o: TypeOwner) => string): string {
  const show = (x: Value): string => {
    switch (x.k) {
      case 'int':
      case 'float':
        return String(x.v);
      case 'duration':
        return `${x.v}ns`;
      case 'bool':
        return x.v ? 'true' : 'false';
      case 'text':
        return JSON.stringify(x.v);
      case 'unit':
        return 'Unit';
      case 'bytes':
        return `<${x.v.length} bytes>`;
      case 'list':
        return `[${x.items.map(show).join(', ')}]`;
      case 'record':
        return `${nameOf(x.def)} { ${[...x.fields].map(([n, f]) => `${n}: ${show(f)}`).join(', ')} }`;
      case 'variant':
        return x.fields.size === 0 ? nameOf(x.def) : `${nameOf(x.def)}(${[...x.fields].map(([n, f]) => `${n}: ${show(f)}`).join(', ')})`;
      case 'typeinfo':
        return ownerName(x.owner);
    }
  };
  return show(v);
}
