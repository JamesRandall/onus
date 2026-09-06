/** `std.list` intrinsics over immutable arrays. */
import { Panic } from './panic.js';
const getIndex = { kind: 'requires', text: '0 <= i and i < len(xs: xs)', at: 'std.list', def: 'get' };
const replicateCount = { kind: 'requires', text: 'count >= 0', at: 'std.list', def: 'replicate' };
const sliceBounds = { kind: 'requires', text: '0 <= from and from <= to and to <= len(xs: xs)', at: 'std.list', def: 'slice' };
export function len(xs) {
    return xs.length;
}
export function get(xs, i) {
    if (!Number.isInteger(i) || i < 0 || i >= xs.length)
        throw new Panic(getIndex, `index ${i} is outside 0 ..< ${xs.length}`);
    const x = xs[i];
    if (x === undefined)
        throw new Panic(getIndex, `index ${i} is outside 0 ..< ${xs.length}`);
    return x;
}
export function replicate(value, count) {
    if (!Number.isInteger(count) || count < 0)
        throw new Panic(replicateCount, `count ${count} is negative`);
    return Array.from({ length: count }, () => value);
}
export function append(xs, x) {
    return [...xs, x];
}
export function concat(xs, ys) {
    return [...xs, ...ys];
}
export function slice(xs, from, to) {
    if (from < 0 || to > xs.length || from > to)
        throw new Panic(sliceBounds, `${from} ..< ${to} is outside 0 ..< ${xs.length}`);
    return xs.slice(from, to);
}
// ---------------------------------------------------------------------------
// Builders (std.list.Builder): in-place growth, one list at the end
// ---------------------------------------------------------------------------
export class Builder {
    items = [];
}
export function builder() {
    return new Builder();
}
export function built(b) {
    return b.items.length;
}
/** `inout` convention: returns the unit result and the builder. */
export function push(b, x) {
    b.items.push(x);
    return [undefined, b];
}
export function finish(b) {
    return b.items.slice();
}
export function at(b, i) {
    const x = b.items[i];
    if (x === undefined)
        throw new Panic({ kind: 'requires', text: '0 <= i and i < built(b: b)', at: 'std.list', def: 'at' });
    return x;
}
/** `inout` convention: the popped element, if any, and the builder. */
export function pop(b) {
    const x = b.items.pop();
    return [x === undefined ? { tag: 'None' } : { tag: 'Some', value: x }, b];
}
//# sourceMappingURL=list.js.map