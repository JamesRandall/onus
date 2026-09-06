/** `std.float` intrinsics. */
export function of(x) {
    return x;
}
export function classify(x) {
    if (Number.isNaN(x))
        return { tag: 'NotANumber' };
    if (!Number.isFinite(x))
        return { tag: 'Infinite' };
    return { tag: 'Finite' };
}
export function to_text(x) {
    return String(x);
}
/** A decimal number with optional sign, fraction and exponent; None when malformed or not finite (std.float.parse). */
export function parse(t) {
    if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t))
        return { tag: 'None' };
    const v = Number(t);
    return Number.isFinite(v) ? { tag: 'Some', value: v } : { tag: 'None' };
}
//# sourceMappingURL=float.js.map