/**
 * The target-neutral form (impl spec §6, "two targets, one lowering"; language
 * spec §19). `lower.ts` produces it from the checked AST plus obligation
 * statuses; `js.ts` and the native emitter only render it. Every codegen
 * decision — which obligations become runtime checks, entry checks, field
 * checks, dictionary passing, `inout` results, `match` compilation, loop
 * measures, `old(...)` snapshots, early returns — is made here, once.
 *
 * Names are Onus names; temporaries begin with `$`. Each emitter mangles for
 * its target. Types are the checker's `Type`s, so an emitter that needs them
 * (the TypeScript oracle) has them.
 */
import type { Value } from '../consteval/values.js';
import type { Def, DefId, ModuleId, ModuleRecord } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import type { Signature } from '../types/tables.js';
import type { ConstValue, Type, TypeArg } from '../types/type.js';

/** What a runtime check reports when it fails (§10.2). */
export interface ObRef {
  readonly kind: string;
  readonly text: string;
  readonly at: string;
  readonly def: string;
}

export interface IrParam {
  readonly name: string;
  readonly type: Type;
  readonly inout: boolean;
}

export interface IrModule {
  readonly module: ModuleRecord;
  readonly items: readonly IrItem[];
  readonly tests: IrTests | null;
  readonly verifies: readonly IrVerify[];
  /** `status`: `main` returns `Result[Int, E]`, and the `Ok` value is the exit status (§8.3). */
  readonly main: { readonly roots: Readonly<Record<string, string>>; readonly args: string; readonly status: boolean } | null;
}

export type IrItem = IrFn | IrConst | IrTypeAlias | IrIntrinsicType | IrRecord | IrUnion | IrInterface | IrImpl | IrCapability;

export interface IrFn {
  readonly k: 'fn';
  readonly def: Def;
  readonly sig: Signature;
  /** Emitted name: the definition's, or `Iface$Target$fn` inside an impl. */
  readonly name: string;
  /** Hidden dictionary parameters for bounded type parameters, in declaration order. */
  readonly dictParams: readonly { readonly def: DefId; readonly iface: DefId; readonly name: string }[];
  readonly constParams: readonly { readonly def: DefId; readonly name: string; readonly type: Type }[];
  readonly params: readonly IrParam[];
  readonly ret: Type;
  /** A runtime-provided primitive: the runtime namespace and function it forwards to. */
  readonly intrinsic: { readonly ns: string; readonly name: string } | null;
  /** Parameter refinement and `requires` checks the callee performs on entry (those every call site proved are omitted). */
  readonly entry: readonly IrStmt[];
  readonly body: IrBlock | null;
  /** The body contains a `try`: an early return unwinds to the function boundary. */
  readonly earlyReturn: boolean;
}

export interface IrConst {
  readonly k: 'const';
  readonly def: Def;
  readonly type: Type;
  readonly value: IrExpr;
}

export interface IrTypeAlias {
  readonly k: 'alias';
  readonly def: Def;
  readonly type: Type;
}

export interface IrIntrinsicType {
  readonly k: 'intrinsic-type';
  readonly def: Def;
  readonly params: readonly DefId[];
}

export interface IrRecord {
  readonly k: 'record';
  readonly def: Def;
  readonly params: readonly DefId[];
  readonly fields: readonly { readonly name: string; readonly type: Type }[];
}

export interface IrUnion {
  readonly k: 'union';
  readonly def: Def;
  readonly params: readonly DefId[];
  readonly variants: readonly { readonly def: Def; readonly fields: readonly { readonly name: string; readonly type: Type }[] }[];
}

export interface IrInterface {
  readonly k: 'interface';
  readonly def: Def;
  readonly tparam: string | null;
  readonly fns: readonly { readonly def: Def; readonly sig: Signature }[];
}

export interface IrImpl {
  readonly k: 'impl';
  readonly def: Def;
  readonly iface: Def;
  readonly target: Type;
  /** The dictionary's emitted name, `Iface$Target`. */
  readonly dictName: string;
  readonly fns: readonly IrFn[];
  /** Interface function name → implementing function. */
  readonly entries: readonly { readonly name: string; readonly fn: IrFn }[];
}

export interface IrCapability {
  readonly k: 'capability';
  readonly def: Def;
}

export type IrBlock = readonly IrStmt[];

export interface IrArm {
  /** The pattern's test on the scrutinee temporary, or null when it always matches. */
  readonly test: IrExpr | null;
  readonly bindings: readonly { readonly name: string; readonly type: Type; readonly value: IrExpr }[];
  readonly guard: IrExpr | null;
  readonly body: IrBlock;
}

export type IrStmt =
  | { readonly k: 'let'; readonly name: string; readonly type: Type; readonly mutable: boolean; readonly value: IrExpr }
  | { readonly k: 'assign'; readonly name: string; readonly type: Type; readonly value: IrExpr }
  | { readonly k: 'return'; readonly value: IrExpr }
  | { readonly k: 'if'; readonly cond: IrExpr; readonly then: IrBlock; readonly else: IrBlock | null }
  | { readonly k: 'match'; readonly tmp: string; readonly type: Type; readonly scrutinee: IrExpr; readonly arms: readonly IrArm[] }
  | { readonly k: 'loop'; readonly cond: IrExpr; readonly body: IrBlock }
  | { readonly k: 'for-range'; readonly name: string; readonly lo: IrExpr; readonly hi: IrExpr; readonly body: IrBlock }
  | { readonly k: 'for-each'; readonly name: string; readonly type: Type; readonly list: IrExpr; readonly body: IrBlock }
  | { readonly k: 'check'; readonly cond: IrExpr; readonly ob: ObRef }
  /** In tests and verify blocks: a bare Bool expression that must hold. */
  | { readonly k: 'assert'; readonly cond: IrExpr }
  | { readonly k: 'expr'; readonly expr: IrExpr }
  /** A call with `inout` arguments: its result (if wanted) and the updated arguments are assigned back. */
  | { readonly k: 'call-inout'; readonly result: { readonly name: string; readonly type: Type } | null; readonly call: IrExpr; readonly targets: readonly { readonly name: string; readonly type: Type }[] }
  | { readonly k: 'unreachable' }
  | { readonly k: 'comment'; readonly text: string }
  /** In a row decoder: the row is rejected at `column` when `cond` is false (§18.2, `Err(Refinement)`). */
  | { readonly k: 'reject'; readonly cond: IrExpr; readonly column: string };

/** The row decoder of a `std.sql.select` (§18.2): builds the record from the raw row and applies its refinements. */
export interface IrDecoder {
  /** The record under construction, as a local the checks read. */
  readonly it: string;
  readonly type: Type;
  readonly fields: readonly { readonly name: string; readonly kind: string }[];
  /** `reject` statements over `it`. */
  readonly checks: readonly IrStmt[];
}

export type IrCallTarget =
  | { readonly k: 'fn'; readonly def: Def; readonly name: string }
  /** An interface function on a receiver known only by its dictionary. */
  | { readonly k: 'dict'; readonly dict: IrExpr; readonly name: string };

export type IrDomain =
  | { readonly k: 'range'; readonly lo: IrExpr; readonly hi: IrExpr }
  | { readonly k: 'list'; readonly expr: IrExpr }
  /** The list inside an `Ok`/`Some`, or empty (§5.3). */
  | { readonly k: 'oklist'; readonly expr: IrExpr }
  | { readonly k: 'bools' };

export type IrExpr =
  | { readonly k: 'int'; readonly v: bigint }
  | { readonly k: 'float'; readonly v: number }
  | { readonly k: 'text'; readonly v: string }
  | { readonly k: 'bool'; readonly v: boolean }
  | { readonly k: 'unit' }
  | { readonly k: 'local'; readonly name: string; readonly type: Type }
  /** A module-level constant. */
  | { readonly k: 'global'; readonly def: Def; readonly type: Type }
  /** A declared function used as a value: an adapter to the positional convention of function values. */
  | { readonly k: 'fnref'; readonly def: Def; readonly name: string; readonly sig: Signature }
  | { readonly k: 'call'; /** The instantiation of the callee's type parameters at this call; empty for a non-generic callee. */ readonly targs: readonly TypeArg[]; readonly target: IrCallTarget; readonly sig: Signature; readonly dicts: readonly IrExpr[]; readonly consts: readonly IrExpr[]; readonly args: readonly IrExpr[]; readonly type: Type; readonly decoder?: IrDecoder }
  | { readonly k: 'call-value'; readonly callee: IrExpr; readonly fnType: Extract<Type, { k: 'fn' }>; readonly args: readonly IrExpr[]; readonly type: Type }
  | { readonly k: 'record'; readonly def: Def; readonly type: Type; readonly fields: readonly { readonly name: string; readonly value: IrExpr }[] }
  | { readonly k: 'variant'; readonly def: Def; readonly type: Type; readonly fields: readonly { readonly name: string; readonly value: IrExpr }[] }
  | { readonly k: 'update'; readonly base: IrExpr; readonly def: Def; readonly type: Type; readonly fields: readonly { readonly name: string; readonly value: IrExpr }[] }
  /** `owner`: the record or variant definition the field belongs to, when known; emitters that lay fields out need it. */
  | { readonly k: 'field'; readonly object: IrExpr; readonly name: string; readonly type: Type; readonly owner: Def | null }
  | { readonly k: 'list'; readonly elems: readonly IrExpr[]; readonly type: Type }
  | { readonly k: 'concat'; readonly left: IrExpr; readonly right: IrExpr; readonly text: boolean; readonly type: Type }
  /** Integer (or Duration) arithmetic; `ob` names the overflow obligation when it is a runtime check. */
  | { readonly k: 'intop'; readonly op: '+' | '-' | '*' | '/' | '%'; readonly left: IrExpr; readonly right: IrExpr; readonly ob: ObRef | null }
  | { readonly k: 'floatop'; readonly op: '+' | '-' | '*' | '/' | '%'; readonly left: IrExpr; readonly right: IrExpr }
  | { readonly k: 'neg'; readonly operand: IrExpr; readonly float: boolean; readonly ob: ObRef | null }
  | { readonly k: 'cmp'; readonly op: '<' | '<=' | '>' | '>='; readonly left: IrExpr; readonly right: IrExpr; readonly float: boolean }
  /** Equality: on primitives by value, otherwise structural. */
  | { readonly k: 'eq'; readonly left: IrExpr; readonly right: IrExpr; readonly type: Type; readonly prim: boolean; readonly negate: boolean }
  | { readonly k: 'not'; readonly operand: IrExpr }
  | { readonly k: 'and'; readonly operands: readonly IrExpr[] }
  | { readonly k: 'or'; readonly operands: readonly IrExpr[] }
  | { readonly k: 'implies'; readonly left: IrExpr; readonly right: IrExpr }
  | { readonly k: 'is-variant'; readonly subject: IrExpr; readonly variant: Def; readonly type: Type }
  /** `try`: unwrap or leave the function early. `raw`: inside a verify block, the else value is the function's result. */
  | { readonly k: 'try'; readonly operand: IrExpr; readonly option: boolean; readonly outerOption: boolean; readonly else: { readonly name: string | null; readonly errorType: Type; readonly value: IrExpr } | null; readonly raw: boolean; readonly type: Type }
  | { readonly k: 'recover'; readonly body: IrBlock; readonly value: IrExpr; readonly type: Type }
  | { readonly k: 'quantifier'; readonly quant: 'forall' | 'exists'; readonly name: string; readonly binder: Type; readonly domain: IrDomain; readonly where: IrExpr | null; readonly body: IrExpr }
  | { readonly k: 'closure'; readonly params: readonly IrParam[]; readonly fnType: Extract<Type, { k: 'fn' }> | null; readonly entry: readonly IrStmt[]; readonly body: IrBlock; readonly earlyReturn: boolean }
  | { readonly k: 'fake'; readonly kind: string; readonly fields: readonly { readonly name: string; readonly value: IrExpr }[]; readonly type: Type }
  /** A value bound to `it` while its refinement checks run. */
  | { readonly k: 'checked'; readonly value: IrExpr; readonly it: string; readonly type: Type; readonly checks: readonly IrStmt[] }
  | { readonly k: 'typeinfo'; readonly name: string; readonly fields: readonly { readonly name: string; readonly type_name: string }[] }
  /** A compile-time constant passed as a `const` type argument. */
  | { readonly k: 'const'; readonly value: ConstValue }
  /** A check-time value (a `const` item's initialiser). */
  | { readonly k: 'value'; readonly value: Value }
  /** The dictionary implementing `iface` for `target`, defined in `module`. */
  | { readonly k: 'dict'; readonly iface: Def; readonly target: Type; readonly module: ModuleId; readonly name: string }
  | { readonly k: 'dict-param'; readonly name: string }
  | { readonly k: 'snapshot'; readonly value: IrExpr; readonly type: Type };

export interface IrGen {
  readonly base: IrGenBase;
  readonly filters: readonly { readonly it: string; readonly cond: IrExpr }[];
}

export type IrGenBase =
  | { readonly k: 'int' }
  | { readonly k: 'float' }
  | { readonly k: 'duration' }
  | { readonly k: 'bool' }
  | { readonly k: 'text' }
  | { readonly k: 'unit' }
  | { readonly k: 'list'; readonly elem: IrGen }
  | { readonly k: 'record'; readonly fields: readonly { readonly name: string; readonly gen: IrGen }[] }
  | { readonly k: 'union'; readonly variants: readonly { readonly name: string; readonly fields: readonly { readonly name: string; readonly gen: IrGen }[] }[] }
  | { readonly k: 'unknown' };

export interface IrTests {
  readonly examples: readonly { readonly name: string; readonly body: IrBlock }[];
  readonly properties: readonly { readonly label: string; readonly params: readonly { readonly name: string; readonly gen: IrGen }[]; readonly body: IrBlock }[];
}

export interface IrVerify {
  readonly name: string;
  readonly key: string;
  readonly claim: string;
  readonly def: string;
  readonly at: string;
  readonly params: readonly { readonly name: string; readonly capability: DefId; readonly node: A.NodeId }[];
  readonly body: IrBlock;
  readonly earlyReturn: boolean;
}
