/**
 * Failed obligations and unwinding (language spec §10.2, §12.2).
 *
 * A *checked* obligation that fails at runtime throws `Panic`, which carries
 * the obligation, not a message string. `recover` catches it and yields
 * `Err(Panicked)`. `EarlyReturn` implements `try`: it unwinds to the
 * enclosing function, which returns its value.
 */
export interface ObligationRef {
  readonly kind: string;
  readonly text: string;
  /** `file:line:col` of the obligation site. */
  readonly at: string;
  readonly def: string;
}

export class Panic extends Error {
  constructor(
    readonly obligation: ObligationRef,
    readonly detail: string = '',
  ) {
    super(`${obligation.kind} \`${obligation.text}\` failed at ${obligation.at} in ${obligation.def}${detail ? `: ${detail}` : ''}`);
    this.name = 'Panic';
  }
}

/** Checks an obligation at runtime. Effects: throws `Panic` when `cond` is false. */
export function check(cond: boolean, ob: ObligationRef): void {
  if (!cond) throw new Panic(ob);
}

/** Runs `validate` over `value` and returns it: refinement checks as an expression. */
export function checked<T>(value: T, validate: (value: T) => void): T {
  validate(value);
  return value;
}

/** Thrown by `try` on `Err`/`None`; caught by the enclosing function, which returns `value`. */
export class EarlyReturn<T = unknown> {
  constructor(readonly value: T) {}
}

export type Result<T, E> = { readonly tag: 'Ok'; readonly value: T } | { readonly tag: 'Err'; readonly error: E };
export type Option<T> = { readonly tag: 'Some'; readonly value: T } | { readonly tag: 'None' };

export interface Panicked {
  readonly obligation: string;
  readonly location: string;
}

/** `try e`: the Ok/Some value, or an early return of the failure itself. */
export function unwrap<T, E>(r: Result<T, E> | Option<T>): T {
  if (r.tag === 'Ok' || r.tag === 'Some') return r.value;
  throw new EarlyReturn(r);
}

/** `try e else name: expr` on a Result: the error is converted by `convert` and returned as `Err`. */
export function unwrapElse<T, E, F>(r: Result<T, E>, convert: (e: E) => F): T {
  if (r.tag === 'Ok') return r.value;
  throw new EarlyReturn({ tag: 'Err', error: convert(r.error) });
}

/** `try e else _: value` inside a `verify` block (§20.2): the else value is the block's result. */
export function unwrapOr<T, E, V>(r: Result<T, E>, convert: (e: E) => V): T {
  if (r.tag === 'Ok') return r.value;
  throw new EarlyReturn(convert(r.error));
}

/** `try e else _: value` on an Option inside a `verify` block. */
export function unwrapOptionOr<T, V>(o: Option<T>, convert: (u: undefined) => V): T {
  if (o.tag === 'Some') return o.value;
  throw new EarlyReturn(convert(undefined));
}

/** `try e else name: expr` on an Option: `None` becomes the converted error. */
export function unwrapOptionElse<T, F>(o: Option<T>, convert: (u: undefined) => F): T {
  if (o.tag === 'Some') return o.value;
  throw new EarlyReturn({ tag: 'Err', error: convert(undefined) });
}

/** `try e` on an Option inside a function returning Option. */
export function unwrapOption<T>(o: Option<T>): T {
  if (o.tag === 'Some') return o.value;
  throw new EarlyReturn({ tag: 'None' });
}

/** `recover { ... }` (§10.2). */
export function recover<T>(body: () => T): Result<T, Panicked> {
  try {
    return { tag: 'Ok', value: body() };
  } catch (e) {
    if (e instanceof Panic) return { tag: 'Err', error: { obligation: `${e.obligation.kind} ${e.obligation.text}`, location: e.obligation.at } };
    throw e;
  }
}

/** The end of an exhaustive match; never reached. */
export function unreachable(): never {
  throw new Error('unreachable: exhaustive match fell through (compiler bug)');
}
