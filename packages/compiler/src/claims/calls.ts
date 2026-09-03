/**
 * Call-site resolution shared by the claims and paths passes (§7.1, §9):
 * what a call reaches, and the callee's effects at that site.
 */
import type { Context } from '../context.js';
import { EffectSet } from '../effects/set.js';
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { sameBase, stripRefinements, type Type } from '../types/type.js';

export type Callee =
  | { readonly k: 'fn'; readonly def: DefId }
  /** An interface function on a concrete receiver, resolved to the implementation's function. */
  | { readonly k: 'impl'; readonly def: DefId }
  /** An interface function whose receiver is a type parameter: resolvable only per instantiation. */
  | { readonly k: 'dispatch'; readonly fn: DefId; readonly iface: DefId }
  /** A call through a function value: its provenance is not tracked in v0 (impl spec §9, M8). */
  | { readonly k: 'value'; readonly type: Type | null }
  | { readonly k: 'ctor' };

/** What `e` calls. Effects: none. */
export function calleeOf(ctx: Context, e: A.Call): Callee {
  const t = ctx.resolve;
  const ty = ctx.types;
  const res = t.refs.get(e.callee.id);
  if (res === undefined) return { k: 'value', type: ty.exprTypes.get(e.callee.id) ?? null };
  switch (res.k) {
    case 'def': {
      const def = t.def(res.def);
      if (def.kind === 'fn') return { k: 'fn', def: def.id };
      if (def.kind === 'variant' || def.kind === 'record') return { k: 'ctor' };
      return { k: 'value', type: ty.declTypes.get(def.id) ?? ty.exprTypes.get(e.callee.id) ?? null };
    }
    case 'companion':
      return { k: 'fn', def: res.fn };
    case 'iface-fn': {
      const sig = ty.signatures.get(res.fn);
      const inst = ty.instantiations.get(e.id);
      const receiver = sig === undefined || inst === undefined ? undefined : inst[sig.tparams.length];
      if (receiver !== undefined && receiver.k === 'type') {
        const s = stripRefinements(receiver.type);
        if (s.k !== 'param' && s.k !== 'error') {
          const impl = (ty.impls.get(res.iface) ?? []).find((i) => sameBase(i.target, s));
          const fnName = t.def(res.fn).name;
          const implFn = impl === undefined ? undefined : t.defs.find((d) => d.parent === impl.def && d.name === fnName);
          if (implFn !== undefined) return { k: 'impl', def: implFn.id };
        }
      }
      return { k: 'dispatch', fn: res.fn, iface: res.iface };
    }
    default:
      return { k: 'value', type: ty.exprTypes.get(e.callee.id) ?? null };
  }
}

/** A function's effects: declared plus inferred (`alloc`, §6.1). Effects: none. */
export function effectsOfFn(ctx: Context, def: DefId): EffectSet {
  const sig = ctx.types.signatures.get(def);
  if (sig === undefined) return EffectSet.empty();
  const inferred = ctx.effects.inferred.get(def);
  return inferred === undefined ? sig.effects : sig.effects.union(inferred);
}

/** The callee's effects at this site, with its effect parameters bound as the checker recorded. Effects: none. */
export function calleeEffects(ctx: Context, e: A.Call, def: DefId): EffectSet {
  const bindings = ctx.types.effectBindings.get(e.id);
  return effectsOfFn(ctx, def).substitute((p) => bindings?.get(p) ?? null);
}

/** The effects of a call through a function value. Effects: none. */
export function valueEffects(type: Type | null): EffectSet {
  const s = type === null ? null : stripRefinements(type);
  return s !== null && s.k === 'fn' ? s.effects : EffectSet.empty();
}
