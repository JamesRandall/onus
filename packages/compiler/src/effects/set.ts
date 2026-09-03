/**
 * Effect sets (language spec §6; impl spec §3.4).
 *
 * An effect is a primitive effect, a resource effect declared by a
 * capability's `grants` clause (`sql.read`), a claim, or an effect parameter.
 * Sets are normalised: parameters are substituted before comparison.
 */
import type { DefId, ModuleId } from '../resolve/defs.js';

export const PRIMITIVE_EFFECTS = ['alloc', 'mutate', 'panic', 'diverge', 'nondet', 'io.file', 'io.net', 'io.env', 'io.clock', 'io.rand'] as const;
export type PrimEffect = (typeof PRIMITIVE_EFFECTS)[number];

const PRIM_SET: ReadonlySet<string> = new Set<string>(PRIMITIVE_EFFECTS);

/** True iff `name` is one of the compiler's closed set of primitive effects. Effects: none. */
export function isPrimEffect(name: string): name is PrimEffect {
  return PRIM_SET.has(name);
}

export type Effect =
  | { readonly k: 'prim'; readonly name: PrimEffect }
  /** A resource effect (`sql.read`), declared by a capability's `grants` clause in `module`. */
  | { readonly k: 'resource'; readonly module: ModuleId; readonly name: string }
  | { readonly k: 'param'; readonly def: DefId };

/** Stable text key of an effect, for set membership. Effects: none. */
export function effectKey(e: Effect): string {
  switch (e.k) {
    case 'prim':
      return e.name;
    case 'resource':
      return `resource:${e.module}:${e.name}`;
    case 'param':
      return `param:${e.def}`;
  }
}

export class EffectSet {
  private readonly items = new Map<string, Effect>();

  static of(effects: Iterable<Effect>): EffectSet {
    const s = new EffectSet();
    for (const e of effects) s.items.set(effectKey(e), e);
    return s;
  }

  static empty(): EffectSet {
    return new EffectSet();
  }

  has(e: Effect): boolean {
    return this.items.has(effectKey(e));
  }

  get size(): number {
    return this.items.size;
  }

  values(): Effect[] {
    return [...this.items.values()];
  }

  /** Set inclusion: every effect of `this` is in `other`. Effects: none. */
  subsetOf(other: EffectSet): boolean {
    for (const k of this.items.keys()) if (!other.items.has(k)) return false;
    return true;
  }

  union(other: EffectSet): EffectSet {
    return EffectSet.of([...this.values(), ...other.values()]);
  }

  /** Effects of `this` not in `other`. Effects: none. */
  minus(other: EffectSet): Effect[] {
    return this.values().filter((e) => !other.has(e));
  }

  /** Effects of `this` without `e`. Effects: none. */
  without(e: Effect): EffectSet {
    return EffectSet.of(this.values().filter((x) => effectKey(x) !== effectKey(e)));
  }

  equals(other: EffectSet): boolean {
    return this.subsetOf(other) && other.subsetOf(this);
  }

  /** Replaces effect parameters by their bindings; unbound parameters stay. Effects: none. */
  substitute(bind: (param: DefId) => EffectSet | null): EffectSet {
    const out: Effect[] = [];
    for (const e of this.values()) {
      if (e.k === 'param') {
        const b = bind(e.def);
        if (b === null) out.push(e);
        else out.push(...b.values());
      } else {
        out.push(e);
      }
    }
    return EffectSet.of(out);
  }
}
