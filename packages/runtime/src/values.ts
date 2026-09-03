/**
 * Value helpers used by generated code: structural equality, quantifier
 * domains, snapshots for `old(...)`, and `TypeInfo` values.
 */
import type { Option, Result } from './panic.js';

/** Structural equality of Onus values (`==`). Function values never reach here. */
export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => eq(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const bo = b as Record<string, unknown>;
  const ao = a as Record<string, unknown>;
  return ka.every((k) => k in bo && eq(ao[k], bo[k]));
}

export function range(lo: number, hi: number): readonly number[] {
  const out: number[] = [];
  for (let i = lo; i < hi; i++) out.push(i);
  return out;
}

export function forall<T>(domain: readonly T[], pred: (x: T) => boolean): boolean {
  return domain.every(pred);
}

export function exists<T>(domain: readonly T[], pred: (x: T) => boolean): boolean {
  return domain.some(pred);
}

/** The list inside an `Ok`/`Some`, or an empty domain (§5.3). */
export function okList<T>(r: Result<readonly T[], unknown> | Option<readonly T[]>): readonly T[] {
  return r.tag === 'Ok' || r.tag === 'Some' ? r.value : [];
}

/** Identity. In TypeScript output it keeps a union-typed binding at its declared type instead of the initialiser's member. */
export function widen<T>(v: T): T {
  return v;
}

/** A deep copy for `old(x)` (§4.1). */
export function snapshot<T>(v: T): T {
  return structuredClone(v);
}

export interface TypeInfo {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly type_name: string }[];
}

export function typeInfo(name: string, fields: readonly { readonly name: string; readonly type_name: string }[]): TypeInfo {
  return { name, fields };
}
