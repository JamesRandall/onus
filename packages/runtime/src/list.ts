/** `std.list` intrinsics over immutable arrays. */
import { Panic } from './panic.js';

export function len<T>(xs: readonly T[]): number {
  return xs.length;
}

export function get<T>(xs: readonly T[], i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new Panic('List.get index', `index ${i} is outside 0 ..< ${xs.length}`);
  const x = xs[i];
  if (x === undefined) throw new Panic('List.get index', `index ${i} is outside 0 ..< ${xs.length}`);
  return x;
}

export function replicate<T>(value: T, count: number): readonly T[] {
  if (!Number.isInteger(count) || count < 0) throw new Panic('List.replicate count', `count ${count} is negative`);
  return Array.from({ length: count }, () => value);
}

export function append<T>(xs: readonly T[], x: T): readonly T[] {
  return [...xs, x];
}

export function concat<T>(xs: readonly T[], ys: readonly T[]): readonly T[] {
  return [...xs, ...ys];
}

export function slice<T>(xs: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || to > xs.length || from > to) throw new Panic('List.slice bounds', `${from} ..< ${to} is outside 0 ..< ${xs.length}`);
  return xs.slice(from, to);
}
