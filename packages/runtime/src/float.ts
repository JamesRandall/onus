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
