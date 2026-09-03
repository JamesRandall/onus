/** `std.bytes` intrinsics. */
import { Panic } from './panic.js';

export function len(b: Uint8Array): number {
  return b.length;
}

export function get(b: Uint8Array, i: number): number {
  const x = b[i];
  if (x === undefined) throw new Panic('Bytes.get index', `index ${i} is outside 0 ..< ${b.length}`);
  return x;
}
