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
