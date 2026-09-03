/**
 * Tokens of the Onus lexical grammar (language spec §2).
 */
import type { Span } from '../source.js';

export const KEYWORDS = [
  'module', 'import', 'test', 'pub', 'sealed', 'fn', 'const', 'type', 'record', 'union', 'of',
  'interface', 'impl', 'law', 'claim', 'capability', 'grants', 'when', 'path', 'entry', 'effects',
  'forbid', 'require', 'policy', 'assume', 'outside', 'except', 'example', 'property', 'requires',
  'ensures', 'proved', 'claims', 'let', 'var', 'return', 'if', 'else', 'match', 'with', 'loop',
  'while', 'invariant', 'decreases', 'for', 'in', 'and', 'or', 'not', 'implies', 'is', 'it',
  'result', 'try', 'recover', 'old', 'forall', 'exists', 'fake', 'inout', 'where', 'true', 'false',
  'self', 'intrinsic', 'may',
] as const;

export type Keyword = (typeof KEYWORDS)[number];

const KEYWORD_SET: ReadonlySet<string> = new Set<string>(KEYWORDS);

/** True iff `text` is a reserved word. Effects: none. */
export function isKeyword(text: string): text is Keyword {
  return KEYWORD_SET.has(text);
}

/**
 * Soft keywords: reserved only where an item or clause can begin, and
 * otherwise ordinary names (`Float.of`, `auth.require`, `path: "x"`). They
 * never appear inside an expression, so accepting them as names in name
 * positions keeps the grammar LL(1).
 */
export const SOFT_KEYWORDS = [
  'module', 'import', 'test', 'type', 'record', 'union', 'interface', 'impl', 'law', 'claim',
  'capability', 'grants', 'path', 'entry', 'effects', 'forbid', 'require', 'policy', 'outside',
  'except', 'example', 'property', 'of', 'self', 'intrinsic', 'may',
] as const;

const SOFT_SET: ReadonlySet<string> = new Set<string>(SOFT_KEYWORDS);

/** True iff a token of this kind may serve as a name in a name position. Effects: none. */
export function isNameKind(kind: TokenKind): boolean {
  return kind === 'name' || SOFT_SET.has(kind);
}

/** Punctuation, longest first within a shared prefix so the lexer can match greedily. */
export const PUNCTUATION = [
  '...', '..<', '..', '->', ':=', '==', '!=', '<=', '>=', '++',
  '(', ')', '[', ']', '{', '}', ',', ':', '.', '=', '<', '>', '+', '-', '*', '/', '%', '|', '_',
] as const;

export type Punct = (typeof PUNCTUATION)[number];

export type TokenKind =
  | 'name' // [a-z][a-z0-9_]*
  | 'tname' // [A-Z][A-Za-z0-9]*
  | 'int'
  | 'float'
  | 'text'
  | 'duration'
  | 'nl'
  | 'eof'
  | 'comment'
  /** The position being completed (`onus next`, §14): matches no grammar alternative and cannot be consumed. */
  | 'cursor'
  /** A synthesised expression at the cursor, typed to find the expected type (§14). */
  | 'hole'
  | Keyword
  | Punct;

export interface Token {
  readonly kind: TokenKind;
  readonly span: Span;
  /** Source text of the token (for identifiers, literals and comments). */
  readonly text: string;
  /** Decoded value: bigint for int and duration (nanoseconds), number for float, string for text. */
  readonly value: bigint | number | string | null;
  /** For comments: true iff only whitespace precedes the comment on its line. */
  readonly ownLine: boolean;
}

/** Human-readable name of a token kind for diagnostics. Effects: none. */
export function describeKind(kind: TokenKind): string {
  switch (kind) {
    case 'name':
      return 'a name';
    case 'tname':
      return 'a type name';
    case 'int':
      return 'an integer literal';
    case 'float':
      return 'a float literal';
    case 'text':
      return 'a text literal';
    case 'duration':
      return 'a duration literal';
    case 'nl':
      return 'newline';
    case 'eof':
      return 'end of file';
    case 'comment':
      return 'a comment';
    default:
      return `\`${kind}\``;
  }
}
