/**
 * Comment attachment (language spec §2: comments carry no semantics).
 *
 * Comments are not part of the AST. This side table records, per node, the
 * comments the canonical printer must reproduce around it:
 *
 *   - `leading`:  own-line comments printed on their own lines before a
 *                 line-level node;
 *   - `trailing`: same-line comments printed at the end of the node's first
 *                 line;
 *   - `dangling`: own-line comments at the end of a container with no
 *                 following child (e.g. before a closing `}`).
 *
 * Attachment is a pure function of the comment positions and the tree, so
 * printing and re-parsing yields the same table.
 */
import type { Token } from '../lexer/tokens.js';
import { lineColOf, type SourceFile } from '../source.js';
import type * as A from './ast.js';
import { walk } from './walk.js';

export interface CommentSet {
  readonly leading: readonly string[];
  readonly trailing: readonly string[];
  readonly dangling: readonly string[];
}

export type CommentTable = ReadonlyMap<A.NodeId, CommentSet>;

export const NO_COMMENTS: CommentTable = new Map();

/** Nodes that occupy their own line(s) and may carry leading/trailing comments. */
export function isLineNode(n: A.Node): boolean {
  switch (n.kind) {
    case 'Module':
    case 'Import':
    case 'FnDecl':
    case 'TypeAlias':
    case 'ConstDecl':
    case 'RecordDecl':
    case 'UnionDecl':
    case 'InterfaceDecl':
    case 'ImplDecl':
    case 'ClaimDecl':
    case 'CapabilityDecl':
    case 'PathDecl':
    case 'PolicyDecl':
    case 'ExampleDecl':
    case 'PropertyDecl':
    case 'Field':
    case 'Variant':
    case 'IfaceFn':
    case 'Law':
    case 'Contract':
    case 'Grant':
    case 'PathEffects':
    case 'PathForbid':
    case 'PathRequire':
    case 'PathPolicy':
    case 'Let':
    case 'Var':
    case 'Assign':
    case 'Return':
    case 'If':
    case 'Match':
    case 'Loop':
    case 'For':
    case 'Assume':
    case 'ExprStmt':
    case 'Arm':
    case 'LoopClause':
    case 'Param':
    case 'Arg':
    case 'FieldInit':
    case 'TypeArgType':
    case 'TypeArgConst':
      return true;
    default:
      return false;
  }
}

/**
 * The line-level children of a container node, or null if `n` is not a container.
 * Effects: none.
 */
export function containerChildren(n: A.Node): readonly A.Node[] | null {
  switch (n.kind) {
    case 'Module':
      return [...n.imports, ...n.items];
    case 'Block':
      return n.stmts;
    case 'RecordDecl':
      return n.fields;
    case 'UnionDecl':
      return n.variants;
    case 'InterfaceDecl':
      return n.items;
    case 'ImplDecl':
      return n.fns;
    case 'FnDecl':
    case 'IfaceFn':
      return [...n.params, ...n.contracts];
    case 'Law':
    case 'PropertyDecl':
    case 'Closure':
      return n.params;
    case 'Call':
      return n.args;
    case 'Ctor':
      return [...(n.args ?? []), ...(n.fields ?? [])];
    case 'RecordUpdate':
    case 'Fake':
      return n.fields;
    case 'CapabilityDecl':
      return n.grants;
    case 'PathDecl':
      return n.clauses;
    case 'Loop':
      return n.clauses;
    case 'Match':
      return n.arms;
    default:
      return null;
  }
}

interface Mutable {
  leading: string[];
  trailing: string[];
  dangling: string[];
}

/**
 * Attaches `comments` to nodes of `module`.
 * Preconditions: `comments` are in source order and lie within `file`.
 * Effects: none.
 */
export function attachComments(module: A.Module, comments: readonly Token[], file: SourceFile): CommentTable {
  if (comments.length === 0) return NO_COMMENTS;
  const table = new Map<A.NodeId, Mutable>();
  const get = (id: A.NodeId): Mutable => {
    let m = table.get(id);
    if (m === undefined) {
      m = { leading: [], trailing: [], dangling: [] };
      table.set(id, m);
    }
    return m;
  };

  const lineNodes: A.Node[] = [];
  const containers: A.Node[] = [];
  walk(module, (n) => {
    if (isLineNode(n)) lineNodes.push(n);
    if (containerChildren(n) !== null) containers.push(n);
  });
  const lineOf = (offset: number): number => lineColOf(file, offset).line;

  for (const c of comments) {
    const cLine = lineOf(c.span.start);
    if (!c.ownLine) {
      let best: A.Node | null = null;
      for (const n of lineNodes) {
        if (lineOf(n.span.start) <= cLine && cLine <= lineOf(Math.max(n.span.start, n.span.end - 1))) {
          if (best === null || n.span.end - n.span.start < best.span.end - best.span.start) best = n;
        }
      }
      if (best !== null) {
        get(best.id).trailing.push(c.text);
        continue;
      }
    }
    let container: A.Node | null = null;
    for (const n of containers) {
      if (n.span.start < c.span.start && c.span.end <= n.span.end) {
        if (container === null || n.span.end - n.span.start < container.span.end - container.span.start) container = n;
      }
    }
    if (container === null) {
      get(module.id).leading.push(c.text);
      continue;
    }
    const kids = containerChildren(container) ?? [];
    const next = kids.find((k) => k.span.start > c.span.start);
    if (next !== undefined) get(next.id).leading.push(c.text);
    else get(container.id).dangling.push(c.text);
  }
  return table;
}
