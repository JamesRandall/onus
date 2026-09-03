/**
 * Definitions and name resolutions (impl spec §4, pass 3).
 *
 * Every declaration in every loaded module gets a `DefId`. The resolve pass
 * writes `ResolveTables`: the module graph, the definition table, and for
 * each use site the `Resolution` it denotes. Later passes read only these.
 */
import type { Effect } from '../effects/set.js';
import type * as A from '../syntax/ast.js';
import type { CommentTable } from '../syntax/comments.js';
import type { FileId, Span } from '../source.js';

import { defId, moduleId, type DefId, type ModuleId } from '../syntax/ast.js';

export { defId, moduleId, type DefId, type ModuleId };

export type DefKind =
  | 'fn'
  | 'iface-fn'
  | 'law'
  | 'alias'
  | 'intrinsic-type'
  | 'record'
  | 'union'
  | 'variant'
  | 'field'
  | 'interface'
  | 'impl'
  | 'claim'
  | 'capability'
  | 'path'
  | 'policy'
  | 'example'
  | 'property'
  | 'const'
  | 'type-param'
  | 'const-param'
  | 'effect-param'
  | 'param'
  | 'let'
  | 'var'
  | 'for'
  | 'binder'
  | 'pattern'
  | 'try-else';

export interface Def {
  readonly id: DefId;
  readonly kind: DefKind;
  readonly name: string;
  readonly module: ModuleId;
  readonly node: A.NodeId;
  readonly span: Span;
  readonly pub: boolean;
  readonly sealed: boolean;
  readonly intrinsic: boolean;
  /** Enclosing definition: a variant's union, a field's record or variant, an impl fn's impl, a local's fn. */
  readonly parent: DefId | null;
  /** Closure nesting depth of a local (0 = the function's own frame). */
  readonly frame: number;
  /** For `param` defs: declared `inout`. */
  readonly inout: boolean;
}

/** Primitive types (§3.1) plus the two check-time-only types of §3.8.1. */
export const PRIMS = ['Int', 'Float', 'Bool', 'Text', 'Unit', 'Bytes', 'Duration', 'TypeInfo', 'Spec'] as const;
export type PrimName = (typeof PRIMS)[number];

const PRIM_SET: ReadonlySet<string> = new Set<string>(PRIMS);

export function isPrimName(s: string): s is PrimName {
  return PRIM_SET.has(s);
}

/** The module that holds a primitive type's companion functions (`Int.to_text` → `std.int`). */
export function companionModuleOf(p: PrimName): string {
  return `std.${p.toLowerCase()}`;
}

export type TypeOwner = { readonly k: 'def'; readonly def: DefId } | { readonly k: 'prim'; readonly name: PrimName };

/** What a use site denotes. */
export type Resolution =
  | { readonly k: 'def'; readonly def: DefId }
  | { readonly k: 'prim'; readonly name: PrimName }
  | { readonly k: 'unit' }
  | { readonly k: 'module'; readonly module: ModuleId }
  /** A type name used as a value: a `TypeInfo` (§3.8.1). */
  | { readonly k: 'type-value'; readonly type: TypeOwner }
  /** `Grid.filled`, `Int.to_text`: function `fn` of the module owning the type. */
  | { readonly k: 'companion'; readonly owner: TypeOwner; readonly fn: DefId }
  /** `Ord.compare`: an interface function, dispatched on the implementing type. */
  | { readonly k: 'iface-fn'; readonly iface: DefId; readonly fn: DefId }
  /** An effect reference: primitive, resource, or effect parameter. */
  | { readonly k: 'effect'; readonly effect: Effect };

export interface ImportRecord {
  readonly alias: string;
  readonly module: ModuleId;
  readonly node: A.NodeId;
}

export interface ModuleRecord {
  readonly id: ModuleId;
  readonly name: string;
  readonly file: FileId;
  readonly module: A.Module;
  readonly comments: CommentTable;
  /** Loaded from the standard library root. */
  readonly isStd: boolean;
  readonly imports: readonly ImportRecord[];
  /** Prelude modules whose public types and variants are in scope unqualified. */
  readonly implicit: readonly ModuleId[];
}

export interface ModuleMembers {
  readonly types: Map<string, DefId>;
  /** Functions and constants. */
  readonly values: Map<string, DefId>;
  readonly variants: Map<string, DefId>;
  readonly claims: Map<string, DefId>;
  readonly interfaces: Map<string, DefId>;
  /** Examples and properties, which may share a name with the function they exercise (§18.1). */
  readonly tests: Map<string, DefId>;
  readonly paths: Map<string, DefId>;
  readonly policies: Map<string, DefId>;
}

export class ResolveTables {
  readonly modules: ModuleRecord[] = [];
  readonly byName = new Map<string, ModuleId>();
  readonly defs: Def[] = [];
  /** Declaration node → its definition. */
  readonly defOf = new Map<A.NodeId, DefId>();
  /** Use node → what it denotes. */
  readonly refs = new Map<A.NodeId, Resolution>();
  readonly members = new Map<ModuleId, ModuleMembers>();
  /** Every node of every loaded module, by id. */
  readonly nodes = new Map<A.NodeId, A.Node>();
  /** Resource effect names (`sql.read`) granted by each module's capabilities. */
  readonly granted = new Map<ModuleId, Set<string>>();
  /** Claims named by a `claims` clause (keyed by the FnDecl) or a path `require` clause (keyed by the clause). */
  readonly claimLists = new Map<A.NodeId, readonly DefId[]>();

  def(id: DefId): Def {
    const d = this.defs[id];
    if (d === undefined) throw new Error(`unknown DefId ${id}`);
    return d;
  }

  moduleOf(id: ModuleId): ModuleRecord {
    const m = this.modules[id];
    if (m === undefined) throw new Error(`unknown ModuleId ${id}`);
    return m;
  }

  membersOf(id: ModuleId): ModuleMembers {
    let m = this.members.get(id);
    if (m === undefined) {
      m = { types: new Map(), values: new Map(), variants: new Map(), claims: new Map(), interfaces: new Map(), tests: new Map(), paths: new Map(), policies: new Map() };
      this.members.set(id, m);
    }
    return m;
  }

  node(id: A.NodeId): A.Node {
    const n = this.nodes.get(id);
    if (n === undefined) throw new Error(`unknown NodeId ${id}`);
    return n;
  }

  /** Qualified name `module.name` of a definition, for diagnostics. */
  qualifiedName(id: DefId): string {
    const d = this.def(id);
    return `${this.moduleOf(d.module).name}.${d.name}`;
  }
}
