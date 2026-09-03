/**
 * `std.int` intrinsics. `Int` is a JavaScript number kept within ±2^53
 * (impl spec §1); leaving that range is a panic.
 */
import { Panic } from './panic.js';

export function checked(x: number, op: string): number {
  if (!Number.isSafeInteger(x)) throw new Panic('Int range', `${op} left the safe integer range`);
  return x;
}

export function to_text(x: number): string {
  return String(x);
}

export type RangeError = { readonly tag: 'NotFinite' } | { readonly tag: 'OutOfRange' };

export function floor(x: number): { readonly tag: 'Ok'; readonly value: number } | { readonly tag: 'Err'; readonly error: RangeError } {
  if (!Number.isFinite(x)) return { tag: 'Err', error: { tag: 'NotFinite' } };
  const f = Math.floor(x);
  if (!Number.isSafeInteger(f)) return { tag: 'Err', error: { tag: 'OutOfRange' } };
  return { tag: 'Ok', value: f };
}
