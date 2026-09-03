/**
 * Output tables of the const-evaluation pass (impl spec §4, pass 5).
 */
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import type { Value } from './values.js';

export type ExampleStatus = 'passed' | 'failed' | 'deferred';

export class ConstTables {
  /** Values of `const` definitions. */
  readonly constValues = new Map<DefId, Value>();
  /** `requires proved` clauses discharged at check time, keyed by call node then contract node. */
  readonly provedAtCheckTime = new Map<A.NodeId, Set<A.NodeId>>();
  /** Outcome of each `example` at check time; `deferred` when it needs the runtime. */
  readonly examples = new Map<DefId, ExampleStatus>();
}
