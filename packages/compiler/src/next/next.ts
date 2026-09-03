/**
 * `onus next` (language spec §14; impl spec §8, M9): the legal next tokens
 * at a position, the expected type there, and the local names in scope.
 *
 * Tokens come from the parser's state after the prefix (`legalTokensAt`).
 * The expected type comes from a second parse of the prefix with a `Hole`
 * at the cursor and closers for every open bracket, resolved and typed with
 * diagnostics ignored; when the cursor is not in expression position, or
 * the hole is typed without an expectation, `expectedType` is null.
 * Refinements are reported in the type text but not enforced (§14). v0
 * re-runs the front half of the pipeline per call (impl spec §12, item 5).
 */
import type { Context } from '../context.js';
import { guarded } from '../driver.js';
import type { TokenKind } from '../lexer/tokens.js';
import { loadPass } from '../resolve/loader.js';
import { resolvePass } from '../resolve/resolve.js';
import type * as A from '../syntax/ast.js';
import { legalTokensAt, parseWithHole } from '../syntax/parser.js';
import { isExpr, walk } from '../syntax/walk.js';
import { printExpr } from '../syntax/printer.js';

import { typesPass } from '../types/check.js';
import { typeToString, type Type } from '../types/type.js';

export interface NextResult {
  /** Legal next tokens, sorted: keywords and punctuation as themselves; `ident`, `type-ident`, `literal:int`, `literal:float`, `literal:text`, `literal:duration`, `newline`, `eof`. */
  readonly tokens: readonly string[];
  readonly expectedType: string | null;
  readonly inScope: readonly string[];
}

/**
 * Computes the completion state at `offset` (a UTF-16 index into `text`) of the
 * file `path`, which becomes the context's entry file.
 * Preconditions: `ctx` has no files yet.
 * Effects: adds the file to `ctx`, runs the load, resolve and types passes over
 * the holed prefix; their diagnostics are left in `ctx.sink` and are not part of the result.
 */
export function next(ctx: Context, path: string, text: string, offset: number): NextResult {
  const file = ctx.addFile(path, text);
  const tokens = [...legalTokensAt(file, offset)].map(tokenName).sort();
  const parsed = parseWithHole(file, offset, ctx.sink, ctx.nextNodeId);
  ctx.nextNodeId = parsed.nextId;
  ctx.parsed.set(file.id, parsed);
  let hole: A.NodeId | null = null;
  if (parsed.module !== null) {
    walk(parsed.module, (n) => {
      if (n.kind === 'Hole') hole = n.id;
      return hole === null;
    });
    guarded(ctx, 'load', loadPass);
    guarded(ctx, 'resolve', resolvePass);
    guarded(ctx, 'types', typesPass);
  }
  const expected = hole === null ? undefined : ctx.types.holes.get(hole);
  return {
    tokens,
    expectedType: expected === undefined || expected === null ? null : typeText(ctx, expected),
    inScope: hole === null ? [] : [...(ctx.resolve.holes.get(hole) ?? [])],
  };
}

/** A type with its refinement predicates spelled out (§14: reported, not enforced). Effects: none. */
function typeText(ctx: Context, type: Type): string {
  const preds: string[] = [];
  let cur = type;
  while (cur.k === 'refined') {
    const n = ctx.resolve.node(cur.pred);
    if (isExpr(n)) preds.push(printExpr(n));
    cur = cur.base;
  }
  const base = typeToString(cur, ctx.resolve);
  return preds.length === 0 ? base : `${base} where ${preds.reverse().join(' and ')}`;
}

/** The decoder-facing name of a token kind. Effects: none. */
export function tokenName(kind: TokenKind): string {
  switch (kind) {
    case 'name':
      return 'ident';
    case 'tname':
      return 'type-ident';
    case 'int':
      return 'literal:int';
    case 'float':
      return 'literal:float';
    case 'text':
      return 'literal:text';
    case 'duration':
      return 'literal:duration';
    case 'nl':
      return 'newline';
    default:
      return kind;
  }
}
