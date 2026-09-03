/**
 * The diagnostic code catalogue (language spec §13; impl spec §3.6).
 *
 * This file is the only place a code is declared. Codes are never reused or
 * renumbered; new codes are appended at the end of their range:
 *
 *   E00xx  syntax and canonical form
 *   E01xx  resolution (modules, names)
 *   E02xx  effects
 *   E03xx  types and contracts
 *   E04xx  paths
 *   E05xx  verification
 *   E06xx  test modules and capabilities
 *   E07xx  const evaluation
 *   E09xx  compiler
 *
 * Every diagnostic is an error. There is no severity field anywhere.
 */
export const CODES = {
  E0001: 'source is not canonical',
  E0002: 'expression statement has no effect',
  E0003: 'unexpected token',
  E0004: 'unterminated text literal',
  E0005: 'unexpected character',
  E0006: 'comparison operators are non-associative',
  E0007: 'and/or mixed without parentheses',
  E0008: 'integer literal out of range',
  E0009: 'invalid escape sequence in text literal',
  E0010: 'malformed numeric literal',
  E0011: 'implies is non-associative',
  E0012: 'fake outside a test module',
  E0101: 'module cycle',
  E0102: 'intrinsic outside the standard library',
  E0103: 'module not found',
  E0104: 'module name does not match its file',
  E0105: 'unknown name',
  E0106: 'unknown type',
  E0107: 'duplicate definition',
  E0108: 'ambiguous name',
  E0109: 'unknown member',
  E0110: 'private item used outside its module',
  E0111: 'sealed type constructed outside its module',
  E0112: 'module name reserved for the standard library',
  E0113: 'binding shadows a visible name',
  E0114: 'contract keyword outside its context',
  E0115: 'elided body outside an interface document',
  E0201: 'undeclared effect',
  E0202: 'unknown effect',
  E0203: 'derived claim not satisfied',
  E0204: 'asserted claim not propagated',
  E0205: 'assume of a derived claim',
  E0206: 'assume of an undeclared claim',
  E0302: 'postcondition not established',
  E0310: 'pattern field mismatch',
  E0320: 'recursive cycle without shared measure',
  E0321: 'type mismatch',
  E0322: 'wrong arguments',
  E0323: 'not callable',
  E0324: 'wrong type arguments',
  E0325: 'no such field',
  E0326: 'match is not exhaustive',
  E0327: 'unreachable match arm',
  E0328: 'assignment to an immutable binding',
  E0329: 'inout misuse',
  E0330: 'closure captures a var, inout parameter or capability',
  E0331: 'missing return',
  E0332: 'unreachable statement',
  E0333: 'bound not satisfied',
  E0334: 'impl does not match its interface',
  E0335: 'invalid modifier',
  E0337: 'argument is not a compile-time constant',
  E0338: 'quantifier domain is unbounded',
  E0339: 'value discarded',
  E0340: 'operator not defined for type',
  E0341: 'pattern does not match the scrutinee type',
  E0342: 'precondition not established',
  E0343: 'checked obligation in a function without panic',
  E0410: 'unresolvable call on path',
  E0411: 'path effect bound and forbid clause are inconsistent',
  E0412: 'path effect bound exceeded',
  E0413: 'forbidden effect reachable on path',
  E0414: 'required claim missing on path',
  E0415: 'assumption forbidden by path policy',
  E0501: 'verification budget exceeded',
  E0600: 'test module linked into a non-test build',
  E0601: 'capability stored in a record',
  E0602: 'main receives a non-root capability',
  E0700: 'library check failed',
  E0701: 'const evaluation failed',
  E0702: 'example failed',
  E0703: 'const fn obligation not proved',
  E0999: 'internal error',
} as const;

export type Code = keyof typeof CODES;

/**
 * Returns the catalogue title for `code`.
 * Pure. Never throws: every `Code` is a key of `CODES`.
 */
export function titleOf(code: Code): string {
  return CODES[code];
}
