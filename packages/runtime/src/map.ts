/** `std.map` intrinsics over persistent (copy-on-write) maps. */
import type { Option } from './panic.js';

export type Map<K, V> = ReadonlyMap<K, V>;

export function empty<K, V>(): Map<K, V> {
  return new globalThis.Map<K, V>();
}

export function size<K, V>(m: Map<K, V>): number {
  return m.size;
}

export function get<K, V>(m: Map<K, V>, key: K): Option<V> {
  const v = m.get(key);
  return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}

export function put<K, V>(m: Map<K, V>, key: K, value: V): Map<K, V> {
  const copy = new globalThis.Map<K, V>(m);
  copy.set(key, value);
  return copy;
}
