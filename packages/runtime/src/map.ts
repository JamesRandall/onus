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

// ---------------------------------------------------------------------------
// Dicts (std.map.Dict): in-place tables, keys by value for Int and Text
// ---------------------------------------------------------------------------

export class Dict<K, V> {
  readonly items = new globalThis.Map<K, V>();
}

export function dict<K, V>(): Dict<K, V> {
  return new Dict<K, V>();
}

export function count<K, V>(d: Dict<K, V>): number {
  return d.items.size;
}

export function set<K, V>(d: Dict<K, V>, key: K, value: V): [undefined, Dict<K, V>] {
  d.items.set(key, value);
  return [undefined, d];
}

export function find<K, V>(d: Dict<K, V>, key: K): Option<V> {
  const v = d.items.get(key);
  return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}

export function contains<K, V>(d: Dict<K, V>, key: K): boolean {
  return d.items.has(key);
}

export function remove<K, V>(d: Dict<K, V>, key: K): [undefined, Dict<K, V>] {
  d.items.delete(key);
  return [undefined, d];
}

export function keys<K, V>(d: Dict<K, V>): readonly K[] {
  return [...d.items.keys()];
}

export function values<K, V>(d: Dict<K, V>): readonly V[] {
  return [...d.items.values()];
}
