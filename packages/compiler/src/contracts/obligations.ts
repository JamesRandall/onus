/**
 * Obligations (impl spec §3.5; language spec §12). First-class objects with
 * a status from milestone 5 on; never a boolean. Created by the contracts
 * pass, resolved by the verifier (milestone 6), consumed by codegen (a
 * runtime check iff `checked`) and by the reports.
 */
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { obligationId, type ObligationId } from '../syntax/ast.js';

export type { ObligationId };

export type ObligationKind =
  | 'requires'
  | 'ensures'
  | 'refinement'
  | 'invariant-entry'
  | 'invariant-step'
  | 'decreases'
  | 'index'
  | 'law'
  | 'property'
  | 'overflow'
  /** An `Int` binding's values fit the JavaScript number range (§19.3); reported, never a runtime check. */
  | 'representation'
  /** A bare Bool statement of an `example`, `property` or `law` body (§5.2): proved when the contracts entail it, otherwise run as a test. */
  | 'assertion'
  | 'const-check';

export type ObligationStatus = 'pending' | 'proved' | 'checked' | 'assumed' | 'failed';

/** Where a refinement obligation arises, which decides where its runtime check lives. */
export type RefinementSite = 'binding' | 'assignment' | 'return' | 'field' | 'argument' | 'element' | 'other';

export interface Obligation {
  readonly id: ObligationId;
  readonly kind: ObligationKind;
  /** The node where the obligation must hold. */
  readonly at: A.NodeId;
  /** The enclosing definition. */
  readonly def: DefId;
  /** The predicate in canonical Onus syntax. */
  readonly text: string;
  /** The contract, loop clause, or refined type node the predicate comes from. */
  readonly source: A.NodeId | null;
  readonly site: RefinementSite;
  readonly pinned: 'proved' | null;
  /** For `requires` and argument refinements: the called function and, for the latter, the parameter. */
  readonly callee: DefId | null;
  readonly param: string | null;
  status: ObligationStatus;
  /** Where the status came from, for the ledger. */
  by: string | null;
}

export class ContractTables {
  readonly obligations: Obligation[] = [];
  private readonly byNode = new Map<A.NodeId, Obligation[]>();

  add(o: Omit<Obligation, 'id'>): Obligation {
    const id = obligationId(this.obligations.length);
    const full: Obligation = { ...o, id };
    this.obligations.push(full);
    const list = this.byNode.get(o.at) ?? [];
    list.push(full);
    this.byNode.set(o.at, list);
    return full;
  }

  /** Obligations located at `node`, in creation order. */
  at(node: A.NodeId): readonly Obligation[] {
    return this.byNode.get(node) ?? [];
  }

  /** The obligation of `kind` at `node`, if any; with `source`, the one from that clause. */
  find(node: A.NodeId, kind: ObligationKind, source: A.NodeId | null = null): Obligation | null {
    return this.at(node).find((o) => o.kind === kind && (source === null || o.source === source)) ?? null;
  }

  /** Obligations of a definition. */
  ofDef(def: DefId): Obligation[] {
    return this.obligations.filter((o) => o.def === def);
  }
}
