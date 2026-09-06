/** Structural equality of Onus values (`==`). Function values never reach here. */
export function eq(a, b) {
    if (a === b)
        return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
        return false;
    if (a instanceof Uint8Array && b instanceof Uint8Array)
        return a.length === b.length && a.every((x, i) => x === b[i]);
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((x, i) => eq(x, b[i]));
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length)
        return false;
    const bo = b;
    const ao = a;
    return ka.every((k) => k in bo && eq(ao[k], bo[k]));
}
export function range(lo, hi) {
    const out = [];
    for (let i = lo; i < hi; i++)
        out.push(i);
    return out;
}
export function forall(domain, pred) {
    return domain.every(pred);
}
export function exists(domain, pred) {
    return domain.some(pred);
}
/** The list inside an `Ok`/`Some`, or an empty domain (§5.3). */
export function okList(r) {
    return r.tag === 'Ok' || r.tag === 'Some' ? r.value : [];
}
/** Identity. In TypeScript output it keeps a union-typed binding at its declared type instead of the initialiser's member. */
export function widen(v) {
    return v;
}
/** A deep copy for `old(x)` (§4.1). */
export function snapshot(v) {
    return structuredClone(v);
}
export function typeInfo(name, fields) {
    return { name, fields };
}
//# sourceMappingURL=values.js.map