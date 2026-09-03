/**
 * Exhaustiveness and reachability of `match` arms (language spec §3.9).
 *
 * Arms are tried in order. An unguarded wildcard or binding covers
 * everything; an unguarded variant pattern covers its variant; a guarded arm
 * covers nothing. An arm whose pattern is already fully covered is
 * unreachable.
 */
import type { DefId } from '../resolve/defs.js';

export type ArmShape =
  | { readonly kind: 'all'; readonly guarded: boolean }
  | { readonly kind: 'variant'; readonly variant: DefId; readonly guarded: boolean }
  | { readonly kind: 'bool'; readonly value: boolean; readonly guarded: boolean }
  | { readonly kind: 'lit'; readonly guarded: boolean };

export type Scrutinee = { readonly kind: 'union'; readonly variants: readonly DefId[] } | { readonly kind: 'bool' } | { readonly kind: 'other' };

export interface Coverage {
  /** Variants (or, for Bool, the literals `true`/`false`) not covered. */
  readonly missing: readonly string[];
  /** Whether a catch-all arm is required and absent (Int, Text, Float, Duration scrutinees). */
  readonly needsCatchAll: boolean;
  /** Indices of unreachable arms. */
  readonly unreachable: readonly number[];
}

/**
 * Computes coverage of `arms` over `scrutinee`.
 * Effects: none.
 */
export function coverage(scrutinee: Scrutinee, arms: readonly ArmShape[], variantName: (v: DefId) => string): Coverage {
  const covered = new Set<string>();
  let all = false;
  const unreachable: number[] = [];
  arms.forEach((arm, i) => {
    const key = arm.kind === 'variant' ? `v:${arm.variant}` : arm.kind === 'bool' ? `b:${arm.value}` : null;
    const alreadyCovered = all || (key !== null && covered.has(key));
    if (alreadyCovered) {
      unreachable.push(i);
      return;
    }
    if (arm.guarded) return;
    if (arm.kind === 'all') all = true;
    else if (key !== null) covered.add(key);
    if (scrutinee.kind === 'bool' && covered.has('b:true') && covered.has('b:false')) all = true;
    if (scrutinee.kind === 'union' && scrutinee.variants.every((v) => covered.has(`v:${v}`))) all = true;
  });
  if (all) return { missing: [], needsCatchAll: false, unreachable };
  switch (scrutinee.kind) {
    case 'union':
      return { missing: scrutinee.variants.filter((v) => !covered.has(`v:${v}`)).map(variantName), needsCatchAll: false, unreachable };
    case 'bool':
      return { missing: ['true', 'false'].filter((b) => !covered.has(`b:${b}`)), needsCatchAll: false, unreachable };
    case 'other':
      return { missing: [], needsCatchAll: true, unreachable };
  }
}
