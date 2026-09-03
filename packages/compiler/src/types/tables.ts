/**
 * Output tables of the types pass (impl spec §4, pass 4).
 */
import type { EffectSet } from '../effects/set.js';
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import type { FnParam, Type, TypeArg } from './type.js';

export type TParamInfo =
  | { readonly k: 'type'; readonly def: DefId; readonly bound: DefId | null }
  | { readonly k: 'const'; readonly def: DefId; readonly type: Type }
  | { readonly k: 'effect'; readonly def: DefId };

/** The elaborated signature of a function, interface function or law. */
export interface Signature {
  readonly def: DefId;
  readonly tparams: readonly TParamInfo[];
  readonly params: readonly FnParam[];
  /** Defs of the parameters, positionally. */
  readonly paramDefs: readonly DefId[];
  readonly ret: Type;
  readonly effects: EffectSet;
  readonly contracts: readonly A.Contract[];
  readonly constFn: boolean;
  readonly intrinsic: boolean;
}

export interface FieldInfo {
  readonly def: DefId;
  readonly name: string;
  readonly type: Type;
}

/** A flow of a value into a refined position: an obligation site for milestone 5+. */
export interface RefinementFlow {
  readonly at: A.NodeId;
  readonly from: Type;
  readonly to: Type;
}

export class TypeTables {
  /** Type of every expression node. */
  readonly exprTypes = new Map<A.NodeId, Type>();
  /** Declared type of every value binding (params, lets, vars, consts, fields, binders). */
  readonly declTypes = new Map<DefId, Type>();
  readonly signatures = new Map<DefId, Signature>();
  /** Type parameters of records, unions, intrinsic types and capabilities. */
  readonly typeParams = new Map<DefId, readonly TParamInfo[]>();
  /** Fields of records and variants, in declaration order. */
  readonly fields = new Map<DefId, readonly FieldInfo[]>();
  /** Expansion of `type` aliases. */
  readonly aliases = new Map<DefId, Type>();
  /** Type arguments chosen at each generic call site. */
  readonly instantiations = new Map<A.NodeId, readonly TypeArg[]>();
  /** Effect parameters bound at each generic call site. */
  readonly effectBindings = new Map<A.NodeId, ReadonlyMap<DefId, EffectSet>>();
  /** Value parameters used as type indices, bound to the constants passed for them at each call site. */
  readonly indexBindings = new Map<A.NodeId, ReadonlyMap<DefId, TypeArg>>();
  readonly refinementFlows: RefinementFlow[] = [];
  /** Variants of each union, in declaration order. */
  readonly variants = new Map<DefId, readonly DefId[]>();
  /** The expected type at a `Hole`, or null when it was inferred without one (`onus next`, §14). */
  readonly holes = new Map<A.NodeId, Type | null>();
  /** Implementations of each interface: the target type and the impl's definition, for dispatch resolution on paths (§9). */
  readonly impls = new Map<DefId, readonly { readonly target: Type; readonly def: DefId }[]>();
}
