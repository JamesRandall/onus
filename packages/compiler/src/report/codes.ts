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
  E0201: 'undeclared effect',
  E0302: 'postcondition not established',
  E0310: 'pattern field mismatch',
  E0320: 'recursive cycle without shared measure',
  E0410: 'unresolvable call on path',
  E0411: 'path effect bound and forbid clause are inconsistent',
  E0501: 'verification budget exceeded',
  E0600: 'test module linked into a non-test build',
  E0700: 'library check failed',
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
