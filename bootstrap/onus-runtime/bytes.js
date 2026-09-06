/** `std.bytes` intrinsics. */
import { Panic } from './panic.js';
export function len(b) {
    return b.length;
}
export function get(b, i) {
    const x = b[i];
    if (x === undefined)
        throw new Panic({ kind: 'requires', text: '0 <= i and i < len(b: b)', at: 'std.bytes', def: 'get' }, `index ${i} is outside 0 ..< ${b.length}`);
    return x;
}
//# sourceMappingURL=bytes.js.map