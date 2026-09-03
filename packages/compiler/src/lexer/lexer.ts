/**
 * The Onus lexer (language spec §2).
 *
 * Produces a token stream with these properties:
 *   - `nl` tokens appear only outside `(`/`[` brackets, never consecutively,
 *     never first, and always immediately before `eof`;
 *   - a `nl` is not emitted before a continuation token (`->`, `else`, `{`,
 *     `claims`, `requires`, `ensures`, `invariant`, `decreases`), which is how
 *     multi-line signatures and `try ... else` continuations stay LL(1);
 *   - comments are removed from the stream and returned separately.
 *
 * Lexical errors are reported to the sink as diagnostics; lexing continues.
 */
import { diagnostic, type DiagnosticSink } from '../report/diagnostic.js';
import { span, type SourceFile } from '../source.js';
import { isKeyword, PUNCTUATION, type Punct, type Token, type TokenKind } from './tokens.js';

export interface LexResult {
  readonly tokens: readonly Token[];
  readonly comments: readonly Token[];
}

/** Tokens before which a newline is not emitted (multi-line signatures, `try ... else`, blocks on their own line). */
export const CONTINUATION: ReadonlySet<TokenKind> = new Set<TokenKind>(['->', 'else', '{', 'claims', 'requires', 'ensures', 'invariant', 'decreases']);

const INT_MAX = (1n << 63n) - 1n;

const DURATION_UNITS: ReadonlyMap<string, bigint> = new Map([
  ['ns', 1n],
  ['us', 1_000n],
  ['ms', 1_000_000n],
  ['s', 1_000_000_000n],
]);

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}
function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}
function isIdentChar(c: number): boolean {
  return isDigit(c) || isLower(c) || isUpper(c) || c === 95;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const TNAME_RE = /^[A-Z][A-Za-z0-9]*$/;

/**
 * Lexes `file`.
 * Postconditions: see module comment; the token list ends with `nl`, `eof`.
 * Effects: reports E0004, E0005, E0008, E0009, E0010 to `sink`.
 */
export function lex(file: SourceFile, sink: DiagnosticSink): LexResult {
  const src = file.text;
  const raw: Token[] = [];
  const comments: Token[] = [];
  let pos = 0;
  let depth = 0;
  let lineHasCode = false;

  const tok = (kind: TokenKind, start: number, end: number, value: Token['value'] = null): Token => ({
    kind,
    span: span(file.id, start, end),
    text: src.slice(start, end),
    value,
    ownLine: false,
  });

  const report = (code: 'E0004' | 'E0005' | 'E0008' | 'E0009' | 'E0010', start: number, end: number, detail: string): void => {
    sink.report(diagnostic({ code, span: span(file.id, start, end), context: [detail] }));
  };

  while (pos < src.length) {
    const c = src.charCodeAt(pos);
    // Newline
    if (c === 10) {
      if (depth === 0) raw.push(tok('nl', pos, pos + 1));
      pos += 1;
      lineHasCode = false;
      continue;
    }
    // Whitespace
    if (c === 32 || c === 9 || c === 13) {
      pos += 1;
      continue;
    }
    // Comment
    if (c === 45 && src.charCodeAt(pos + 1) === 45) {
      const start = pos;
      while (pos < src.length && src.charCodeAt(pos) !== 10) pos += 1;
      let end = pos;
      while (end > start && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9 || src.charCodeAt(end - 1) === 13)) end -= 1;
      comments.push({ ...tok('comment', start, end), ownLine: !lineHasCode });
      continue;
    }
    lineHasCode = true;
    // Identifier or keyword
    if (isLower(c) || isUpper(c) || (c === 95 && isIdentChar(src.charCodeAt(pos + 1)))) {
      const start = pos;
      while (pos < src.length && isIdentChar(src.charCodeAt(pos))) pos += 1;
      const text = src.slice(start, pos);
      if (isKeyword(text)) raw.push(tok(text, start, pos));
      else if (NAME_RE.test(text)) raw.push(tok('name', start, pos, text));
      else if (TNAME_RE.test(text)) raw.push(tok('tname', start, pos, text));
      else report('E0005', start, pos, `\`${text}\` is neither a name ([a-z][a-z0-9_]*) nor a type name ([A-Z][A-Za-z0-9]*)`);
      continue;
    }
    // Number
    if (isDigit(c)) {
      const start = pos;
      while (pos < src.length && (isDigit(src.charCodeAt(pos)) || src.charCodeAt(pos) === 95)) pos += 1;
      let isFloat = false;
      if (src.charCodeAt(pos) === 46 && isDigit(src.charCodeAt(pos + 1))) {
        isFloat = true;
        pos += 1;
        while (pos < src.length && (isDigit(src.charCodeAt(pos)) || src.charCodeAt(pos) === 95)) pos += 1;
      }
      if (src.charCodeAt(pos) === 101 || src.charCodeAt(pos) === 69) {
        let p = pos + 1;
        if (src.charCodeAt(p) === 43 || src.charCodeAt(p) === 45) p += 1;
        if (isDigit(src.charCodeAt(p))) {
          isFloat = true;
          while (isDigit(src.charCodeAt(p))) p += 1;
          pos = p;
        }
      }
      const numText = src.slice(start, pos).replace(/_/g, '');
      // Duration suffix
      let unitStart = pos;
      while (pos < src.length && isIdentChar(src.charCodeAt(pos))) pos += 1;
      const suffix = src.slice(unitStart, pos);
      if (suffix.length > 0) {
        const unit = DURATION_UNITS.get(suffix);
        if (unit === undefined || isFloat) {
          report('E0010', start, pos, `\`${src.slice(start, pos)}\` is not a valid literal`);
          raw.push(tok('int', start, pos, 0n));
          continue;
        }
        const nanos = BigInt(numText) * unit;
        raw.push(tok('duration', start, pos, nanos));
        continue;
      }
      unitStart = pos;
      if (isFloat) {
        raw.push(tok('float', start, pos, Number(numText)));
      } else {
        const value = BigInt(numText);
        if (value > INT_MAX) report('E0008', start, pos, `${numText} exceeds the 64-bit signed range`);
        raw.push(tok('int', start, pos, value > INT_MAX ? 0n : value));
      }
      continue;
    }
    // Text literal
    if (c === 34) {
      const start = pos;
      pos += 1;
      let value = '';
      let terminated = false;
      while (pos < src.length) {
        const d = src.charCodeAt(pos);
        if (d === 34) {
          pos += 1;
          terminated = true;
          break;
        }
        if (d === 10) break;
        if (d === 92) {
          const e = src.charCodeAt(pos + 1);
          const escaped = ESCAPES.get(e);
          if (escaped === undefined) {
            report('E0009', pos, Math.min(pos + 2, src.length), `\`\\${src.charAt(pos + 1)}\` is not a valid escape; use \\n \\t \\r \\0 \\\\ or \\"`);
            pos += 2;
            continue;
          }
          value += escaped;
          pos += 2;
          continue;
        }
        value += src.charAt(pos);
        pos += 1;
      }
      if (!terminated) report('E0004', start, pos, 'a text literal must close on the same line; use \\n for a newline');
      raw.push(tok('text', start, pos, value));
      continue;
    }
    // Punctuation
    const punct = matchPunct(src, pos);
    if (punct !== null) {
      raw.push(tok(punct, pos, pos + punct.length));
      pos += punct.length;
      if (punct === '(' || punct === '[') depth += 1;
      else if ((punct === ')' || punct === ']') && depth > 0) depth -= 1;
      continue;
    }
    report('E0005', pos, pos + 1, `\`${src.charAt(pos)}\` cannot appear here`);
    pos += 1;
  }

  return { tokens: normalise(raw, file, src.length), comments };
}

const ESCAPES: ReadonlyMap<number, string> = new Map([
  [110, '\n'],
  [116, '\t'],
  [114, '\r'],
  [48, '\0'],
  [92, '\\'],
  [34, '"'],
]);

function matchPunct(src: string, pos: number): Punct | null {
  for (const p of PUNCTUATION) {
    if (src.startsWith(p, pos)) return p;
  }
  return null;
}

/**
 * Collapses newlines, drops leading and continuation newlines, and appends
 * the final `nl` and `eof`.
 * Effects: none.
 */
function normalise(raw: readonly Token[], file: SourceFile, end: number): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === undefined) continue;
    if (t.kind === 'nl') {
      if (out.length === 0) continue;
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.kind === 'nl') continue;
      let j = i + 1;
      while (j < raw.length && raw[j]?.kind === 'nl') j += 1;
      const next = raw[j];
      if (next !== undefined && CONTINUATION.has(next.kind)) continue;
      out.push(t);
      continue;
    }
    out.push(t);
  }
  const last = out[out.length - 1];
  if (last !== undefined && last.kind !== 'nl') {
    out.push({ kind: 'nl', span: span(file.id, end, end), text: '', value: null, ownLine: false });
  }
  out.push({ kind: 'eof', span: span(file.id, end, end), text: '', value: null, ownLine: false });
  return out;
}
