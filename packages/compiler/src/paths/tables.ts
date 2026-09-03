/**
 * Output tables of the paths pass (impl spec §4, pass 12; language spec §9).
 */
import type { EffectSet } from '../effects/set.js';
import type { DefId, ModuleId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';

export interface PathAssume {
  readonly claim: DefId;
  readonly fn: DefId;
  readonly justification: string;
  readonly node: A.NodeId;
  /** How the path's policy permits it, or null when it violates the policy (E0415) or there is no policy. */
  readonly permittedBy: 'scope' | 'except' | null;
}

export interface UnresolvableCall {
  readonly fn: DefId;
  readonly at: A.NodeId;
  readonly reason: string;
}

/** A call in the reachable set that yields a capability: a construction or attenuation site (§8.1). */
export interface CapabilitySite {
  readonly fn: DefId;
  readonly at: A.NodeId;
  readonly typeText: string;
}

export interface PathAnalysis {
  readonly def: DefId;
  readonly module: ModuleId;
  readonly entry: DefId;
  /** Breadth-first from the entry. */
  readonly reachable: readonly DefId[];
  readonly bound: EffectSet | null;
  readonly forbid: EffectSet;
  readonly actual: EffectSet;
  readonly required: readonly DefId[];
  readonly satisfied: boolean;
  readonly policy: DefId | null;
  readonly assumes: readonly PathAssume[];
  readonly unresolvable: readonly UnresolvableCall[];
  readonly capabilities: readonly CapabilitySite[];
  /** No diagnostic was reported for this path. */
  readonly ok: boolean;
}

export class PathTables {
  readonly analyses = new Map<DefId, PathAnalysis>();
}
