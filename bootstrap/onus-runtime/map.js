export function empty() {
    return new globalThis.Map();
}
export function size(m) {
    return m.size;
}
export function get(m, key) {
    const v = m.get(key);
    return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}
export function put(m, key, value) {
    const copy = new globalThis.Map(m);
    copy.set(key, value);
    return copy;
}
// ---------------------------------------------------------------------------
// Dicts (std.map.Dict): in-place tables, keys by value for Int and Text
// ---------------------------------------------------------------------------
export class Dict {
    items = new globalThis.Map();
}
export function dict() {
    return new Dict();
}
export function count(d) {
    return d.items.size;
}
export function set(d, key, value) {
    d.items.set(key, value);
    return [undefined, d];
}
export function find(d, key) {
    const v = d.items.get(key);
    return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}
export function contains(d, key) {
    return d.items.has(key);
}
export function remove(d, key) {
    d.items.delete(key);
    return [undefined, d];
}
export function keys(d) {
    return [...d.items.keys()];
}
export function values(d) {
    return [...d.items.values()];
}
//# sourceMappingURL=map.js.map