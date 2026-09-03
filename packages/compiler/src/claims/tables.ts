/**
 * Output tables of the claims pass (impl spec §4, pass 9; language spec §7).
 */
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';

export type ClaimTier = 'derived' | 'asserted';

/** An `assume` leaf: where an asserted claim bottoms out (§7.1). */
export interface AssumeSite {
  readonly fn: DefId;
  readonly claim: DefId;
  readonly justification: string;
  readonly node: A.NodeId;
}

export class ClaimTables {
  readonly tiers = new Map<DefId, ClaimTier>();
  /** Claims each function carries: declared ones, plus derived claims whose predicate holds over its effects. */
  readonly carried = new Map<DefId, ReadonlySet<DefId>>();
  readonly assumes: AssumeSite[] = [];

  carries(fn: DefId, claim: DefId): boolean {
    return this.carried.get(fn)?.has(claim) ?? false;
  }

  assumesOf(fn: DefId): AssumeSite[] {
    return this.assumes.filter((a) => a.fn === fn);
  }
}
