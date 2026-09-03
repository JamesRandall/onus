/**
 * Maps an offset inside a text literal's *value* back to the source
 * (language spec §3.8.1: a malformed SQL string is reported at the character
 * in the string, not at the call). Value offsets are grapheme indices, as
 * `Text.graphemes` produces them.
 */
import type { SourceFile, Span } from '../source.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * The source span of grapheme `graphemeIndex` of the literal at `literal`.
 * Preconditions: `literal` spans a text literal (including its quotes) in `file`.
 * Postconditions: the result lies within `literal`; past-the-end indices map
 * to the closing quote.
 * Effects: none.
 */
export function graphemeSpan(file: SourceFile, literal: Span, graphemeIndex: number): Span {
  const src = file.text.slice(literal.start + 1, literal.end - 1);
  // Decode escapes while recording, for each value code unit, its source offset.
  const starts: number[] = [];
  let value = '';
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '\\' && i + 1 < src.length) {
      const e = src.charAt(i + 1);
      const decoded = e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e;
      starts.push(i);
      value += decoded;
      i += 2;
      continue;
    }
    starts.push(i);
    value += c;
    i += 1;
  }
  let unit = 0;
  let g = 0;
  let width = 1;
  for (const seg of segmenter.segment(value)) {
    if (g === graphemeIndex) {
      width = seg.segment.length;
      break;
    }
    unit += seg.segment.length;
    g += 1;
  }
  const base = literal.start + 1;
  if (g < graphemeIndex || unit >= starts.length) return { file: literal.file, start: literal.end - 1, end: literal.end };
  const from = starts[unit] ?? 0;
  const toIndex = unit + width;
  const to = toIndex < starts.length ? (starts[toIndex] ?? src.length) : src.length;
  return { file: literal.file, start: base + from, end: base + to };
}
