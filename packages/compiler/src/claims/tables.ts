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
  /** The `verify` block, when the assumption is verifiable (§20.2). */
  readonly verify: A.NodeId | null;
  /** Ledger key: module name and the BLAKE3 of the assumption's canonical text (§20.3). */
  readonly key: string;
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
