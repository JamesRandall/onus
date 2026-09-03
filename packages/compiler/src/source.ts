/**
 * Source files, spans and position mapping (impl spec §3.1).
 *
 * Offsets are UTF-16 code-unit indices into the file's text. Lines and
 * columns in rendered diagnostics are 1-based.
 */

import { fileId, type FileId } from './syntax/ast.js';

export { fileId, type FileId };

export interface Span {
  readonly file: FileId;
  readonly start: number;
  readonly end: number;
}

export interface LineCol {
  readonly line: number;
  readonly col: number;
}

export interface SourceFile {
  readonly id: FileId;
  readonly path: string;
  readonly text: string;
  /** Offset of the first character of every line, ascending. lineStarts[0] === 0. */
  readonly lineStarts: readonly number[];
}

/**
 * Builds a SourceFile.
 * Preconditions: none.
 * Postconditions: `lineStarts[0] === 0`; one entry per line of `text`.
 * Effects: none.
 */
export function makeSourceFile(id: FileId, path: string, text: string): SourceFile {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return { id, path, text, lineStarts };
}

/**
 * Maps an offset to a 1-based line and column.
 * Preconditions: `0 <= offset <= file.text.length`. Offsets past the end map to the last line.
 * Effects: none.
 */
export function lineColOf(file: SourceFile, offset: number): LineCol {
  const starts = file.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = starts[mid];
    if (s !== undefined && s <= offset) lo = mid;
    else hi = mid - 1;
  }
  const lineStart = starts[lo] ?? 0;
  return { line: lo + 1, col: offset - lineStart + 1 };
}

/**
 * Creates a span covering [start, end) in `file`.
 * Preconditions: `start <= end`.
 */
export function span(file: FileId, start: number, end: number): Span {
  return { file, start, end };
}

/**
 * The smallest span covering both arguments.
 * Preconditions: both spans are in the same file.
 */
export function join(a: Span, b: Span): Span {
  return { file: a.file, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}
