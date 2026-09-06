/**
 * Failed obligations and unwinding (language spec §10.2, §12.2).
 *
 * A *checked* obligation that fails at runtime throws `Panic`, which carries
 * the obligation, not a message string. `recover` catches it and yields
 * `Err(Panicked)`. `EarlyReturn` implements `try`: it unwinds to the
 * enclosing function, which returns its value.
 */
import { hit } from './coverage.js';
export class Panic extends Error {
    obligation;
    detail;
    constructor(obligation, detail = '') {
        super(`${obligation.kind} \`${obligation.text}\` failed at ${obligation.at} in ${obligation.def}${detail ? `: ${detail}` : ''}`);
        this.obligation = obligation;
        this.detail = detail;
        this.name = 'Panic';
    }
}
/** Checks an obligation at runtime. Effects: throws `Panic` when `cond` is false. */
export function check(cond, ob) {
    hit(ob.at);
    if (!cond)
        throw new Panic(ob);
}
/** Runs `validate` over `value` and returns it: refinement checks as an expression. */
export function checked(value, validate) {
    validate(value);
    return value;
}
/** Thrown by `try` on `Err`/`None`; caught by the enclosing function, which returns `value`. */
export class EarlyReturn {
    value;
    constructor(value) {
        this.value = value;
    }
}
/** `try e`: the Ok/Some value, or an early return of the failure itself. */
export function unwrap(r) {
    if (r.tag === 'Ok' || r.tag === 'Some')
        return r.value;
    throw new EarlyReturn(r);
}
/** `try e else name: expr` on a Result: the error is converted by `convert` and returned as `Err`. */
export function unwrapElse(r, convert) {
    if (r.tag === 'Ok')
        return r.value;
    throw new EarlyReturn({ tag: 'Err', error: convert(r.error) });
}
/** `try e else _: value` inside a `verify` block (§20.2): the else value is the block's result. */
export function unwrapOr(r, convert) {
    if (r.tag === 'Ok')
        return r.value;
    throw new EarlyReturn(convert(r.error));
}
/** `try e else _: value` on an Option inside a `verify` block. */
export function unwrapOptionOr(o, convert) {
    if (o.tag === 'Some')
        return o.value;
    throw new EarlyReturn(convert(undefined));
}
/** `try e else name: expr` on an Option: `None` becomes the converted error. */
export function unwrapOptionElse(o, convert) {
    if (o.tag === 'Some')
        return o.value;
    throw new EarlyReturn({ tag: 'Err', error: convert(undefined) });
}
/** `try e` on an Option inside a function returning Option. */
export function unwrapOption(o) {
    if (o.tag === 'Some')
        return o.value;
    throw new EarlyReturn({ tag: 'None' });
}
/** `recover { ... }` (§10.2). */
export function recover(body) {
    try {
        return { tag: 'Ok', value: body() };
    }
    catch (e) {
        if (e instanceof Panic)
            return { tag: 'Err', error: { obligation: `${e.obligation.kind} ${e.obligation.text}`, location: e.obligation.at } };
        throw e;
    }
}
/** The end of an exhaustive match; never reached. */
export function unreachable() {
    throw new Error('unreachable: exhaustive match fell through (compiler bug)');
}
//# sourceMappingURL=panic.js.map