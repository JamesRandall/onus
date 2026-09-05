/** `std.float` intrinsics. */
export function of(x: number): number {
  return x;
}

export type Class = { readonly tag: 'Finite' } | { readonly tag: 'Infinite' } | { readonly tag: 'NotANumber' };

export function classify(x: number): Class {
  if (Number.isNaN(x)) return { tag: 'NotANumber' };
  if (!Number.isFinite(x)) return { tag: 'Infinite' };
  return { tag: 'Finite' };
}

export function to_text(x: number): string {
  return String(x);
}

/** A decimal number with optional sign, fraction and exponent; None when malformed or not finite (std.float.parse). */
export function parse(t: string): { readonly tag: 'Some'; readonly value: number } | { readonly tag: 'None' } {
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t)) return { tag: 'None' };
  const v = Number(t);
  return Number.isFinite(v) ? { tag: 'Some', value: v } : { tag: 'None' };
}
