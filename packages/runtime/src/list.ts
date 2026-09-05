/** `std.list` intrinsics over immutable arrays. */
import { Panic } from './panic.js';

const getIndex = { kind: 'requires', text: '0 <= i and i < len(xs: xs)', at: 'std.list', def: 'get' } as const;
const replicateCount = { kind: 'requires', text: 'count >= 0', at: 'std.list', def: 'replicate' } as const;
const sliceBounds = { kind: 'requires', text: '0 <= from and from <= to and to <= len(xs: xs)', at: 'std.list', def: 'slice' } as const;

export function len<T>(xs: readonly T[]): number {
  return xs.length;
}

export function get<T>(xs: readonly T[], i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new Panic(getIndex, `index ${i} is outside 0 ..< ${xs.length}`);
  const x = xs[i];
  if (x === undefined) throw new Panic(getIndex, `index ${i} is outside 0 ..< ${xs.length}`);
  return x;
}

export function replicate<T>(value: T, count: number): readonly T[] {
  if (!Number.isInteger(count) || count < 0) throw new Panic(replicateCount, `count ${count} is negative`);
  return Array.from({ length: count }, () => value);
}

export function append<T>(xs: readonly T[], x: T): readonly T[] {
  return [...xs, x];
}

export function concat<T>(xs: readonly T[], ys: readonly T[]): readonly T[] {
  return [...xs, ...ys];
}

export function slice<T>(xs: readonly T[], from: number, to: number): readonly T[] {
  if (from < 0 || to > xs.length || from > to) throw new Panic(sliceBounds, `${from} ..< ${to} is outside 0 ..< ${xs.length}`);
  return xs.slice(from, to);
}

// ---------------------------------------------------------------------------
// Builders (std.list.Builder): in-place growth, one list at the end
// ---------------------------------------------------------------------------

export class Builder<T> {
  readonly items: T[] = [];
}

export function builder<T>(): Builder<T> {
  return new Builder<T>();
}

export function built<T>(b: Builder<T>): number {
  return b.items.length;
}

/** `inout` convention: returns the unit result and the builder. */
export function push<T>(b: Builder<T>, x: T): [undefined, Builder<T>] {
  b.items.push(x);
  return [undefined, b];
}

export function finish<T>(b: Builder<T>): readonly T[] {
  return b.items.slice();
}

export function at<T>(b: Builder<T>, i: number): T {
  const x = b.items[i];
  if (x === undefined) throw new Panic({ kind: 'requires', text: '0 <= i and i < built(b: b)', at: 'std.list', def: 'at' });
  return x;
}

/** `inout` convention: the popped element, if any, and the builder. */
export function pop<T>(b: Builder<T>): [{ readonly tag: 'Some'; readonly value: T } | { readonly tag: 'None' }, Builder<T>] {
  const x = b.items.pop();
  return [x === undefined ? { tag: 'None' } : { tag: 'Some', value: x }, b];
}
