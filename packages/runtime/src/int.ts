/**
 * `std.int` intrinsics and checked arithmetic. `Int` is a JavaScript number
 * kept within ±2^53 (impl spec §1); leaving that range is a panic on the
 * `overflow` obligation.
 */
import { hit } from './coverage.js';
import { Panic, type ObligationRef } from './panic.js';

function guard(x: number, ob: ObligationRef): number {
  if (!Number.isSafeInteger(x)) throw new Panic(ob, `result ${x} is outside the safe integer range`);
  return x;
}

export function add(a: number, b: number, ob: ObligationRef): number {
  hit(ob.at);
  return guard(a + b, ob);
}
export function sub(a: number, b: number, ob: ObligationRef): number {
  hit(ob.at);
  return guard(a - b, ob);
}
export function mul(a: number, b: number, ob: ObligationRef): number {
  hit(ob.at);
  return guard(a * b, ob);
}
export function div(a: number, b: number, ob: ObligationRef): number {
  hit(ob.at);
  if (b === 0) throw new Panic(ob, 'division by zero');
  return Math.trunc(a / b);
}
export function rem(a: number, b: number, ob: ObligationRef): number {
  hit(ob.at);
  if (b === 0) throw new Panic(ob, 'remainder by zero');
  return a % b;
}
export function neg(a: number, ob: ObligationRef): number {
  hit(ob.at);
  return guard(-a, ob);
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

/** A decimal integer with an optional sign; None when malformed or outside 64 bits (std.int.parse). */
export function parse(t: string): { readonly tag: 'Some'; readonly value: number } | { readonly tag: 'None' } {
  if (!/^[+-]?[0-9]+$/.test(t)) return { tag: 'None' };
  const v = BigInt(t);
  if (v > 9223372036854775807n || v < -9223372036854775808n) return { tag: 'None' };
  return { tag: 'Some', value: Number(v) };
}
