/**
 * Output tables of the effects pass (impl spec §4, pass 6).
 */
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import type { EffectSet } from './set.js';

export class EffectTables {
  /** Effects a function body was found to have (a subset of its declaration when it checks). */
  readonly inferred = new Map<DefId, EffectSet>();
  /** Effects contributed by each call expression, after substituting effect parameters. */
  readonly calls = new Map<A.NodeId, EffectSet>();
  /** Closures, by node, with their inferred body effects. */
  readonly closures = new Map<A.NodeId, EffectSet>();
}
