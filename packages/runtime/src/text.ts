/**
 * `std.text` intrinsics. `Text` is a string; `len` and `graphemes` are
 * grapheme-based (language spec §3.1), so there is no code-unit indexing.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(t: string): readonly string[] {
  return [...segmenter.segment(t)].map((s) => s.segment);
}

export function len(t: string): number {
  return graphemes(t).length;
}

export function bytes(t: string): Uint8Array {
  return new TextEncoder().encode(t);
}

export function starts_with(t: string, prefix: string): boolean {
  return t.startsWith(prefix);
}

export function lower(t: string): string {
  return t.toLowerCase();
}

export function trim(t: string): string {
  return t.trim();
}

export function concat(a: string, b: string): string {
  return a + b;
}

// ---------------------------------------------------------------------------
// Code-point operations (std.text; positions count Unicode scalar values)
// ---------------------------------------------------------------------------

function points(t: string): string[] {
  return Array.from(t);
}

export function count(t: string): number {
  let n = 0;
  for (const _ of t) n += 1;
  return n;
}

export function code_points(t: string): readonly number[] {
  return Array.from(t, (c) => c.codePointAt(0) ?? 0);
}

export function of_code_points(cps: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < cps.length; i += 4096) parts.push(String.fromCodePoint(...cps.slice(i, i + 4096)));
  return parts.join('');
}

export function of_code_point(cp: number): string {
  return String.fromCodePoint(cp);
}

export function slice(t: string, from: number, to: number): string {
  return points(t).slice(from, to).join('');
}

export function index_of(t: string, needle: string, from: number): { readonly tag: 'Some'; readonly value: number } | { readonly tag: 'None' } {
  const hay = points(t);
  const pin = points(needle);
  for (let i = from; i + pin.length <= hay.length; i += 1) {
    let j = 0;
    while (j < pin.length && hay[i + j] === pin[j]) j += 1;
    if (j === pin.length) return { tag: 'Some', value: i };
  }
  return { tag: 'None' };
}

export function contains(t: string, needle: string): boolean {
  return t.includes(needle);
}

export function ends_with(t: string, suffix: string): boolean {
  return t.endsWith(suffix);
}

export function split(t: string, sep: string): readonly string[] {
  return sep === '' ? (t === '' ? [''] : points(t)) : t.split(sep);
}

export function join(parts: readonly string[], sep: string): string {
  return parts.join(sep);
}

export function repeat(t: string, n: number): string {
  return t.repeat(n);
}

export function replace(t: string, from: string, to: string): string {
  return from === '' ? t : t.split(from).join(to);
}

export function compare(a: string, b: string): number {
  const x = points(a);
  const y = points(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const cx = x[i]?.codePointAt(0) ?? 0;
    const cy = y[i]?.codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function upper(t: string): string {
  return t.toUpperCase();
}
