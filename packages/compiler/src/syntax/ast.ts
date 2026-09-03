/**
 * The Onus abstract syntax tree (language spec §2.3; impl spec §3.1).
 *
 * One tree, immutable after parsing. Every node has a stable `id` assigned by
 * the parser in pre-order and a `span`. Nothing else is ever stored on nodes;
 * later passes keep side tables keyed by `NodeId`.
 *
 * Node kinds follow the grammar one-to-one, with these documented deviations
 * from §2.3 (recorded in docs/CHANGES.md):
 *   - parentheses are not nodes; the printer re-inserts the minimal set
 *   - `and` / `or` are n-ary, matching their non-mixing grammar
 *   - `else if` is sugar and is stored as a nested block (spec §2.3 note)
 *   - call sites may carry explicit `[...]` type/const arguments
 *   - type arguments may be labelled (`schema: "orders"`)
 *   - `a ..< b` is a domain form for `for` and quantifiers, not an expression
 *   - `x is Pattern` is a comparison-level test
 *   - `test module`, `fake` and `inout` call-site markers are parsed
 *   - `intrinsic fn` (no body) and `intrinsic type` declare runtime-provided
 *     primitives; legal only under `std.*`
 *   - function types carry parameter names (`fn(x: Int) -> Int`)
 */
import type { Span } from '../source.js';

export type NodeId = number & { readonly __brand: 'NodeId' };
export type FileId = number & { readonly __brand: 'FileId' };
export type DefId = number & { readonly __brand: 'DefId' };
export type ModuleId = number & { readonly __brand: 'ModuleId' };
export type ObligationId = number & { readonly __brand: 'ObligationId' };

// This file holds the compiler's only casts: the four brand constructors.

/** Brands a plain number as a NodeId. Only the parser should call this. */
export function nodeId(n: number): NodeId {
  return n as NodeId;
}

/** Brands a plain number as a FileId. Only the file table should call this. */
export function fileId(n: number): FileId {
  return n as FileId;
}

/** Brands a plain number as a DefId. Only the resolver should call this. */
export function defId(n: number): DefId {
  return n as DefId;
}

/** Brands a plain number as a ModuleId. Only the loader should call this. */
export function moduleId(n: number): ModuleId {
  return n as ModuleId;
}

/** Brands a plain number as an ObligationId. Only the contracts pass should call this. */
export function obligationId(n: number): ObligationId {
  return n as ObligationId;
}

export interface NodeBase {
  readonly id: NodeId;
  readonly span: Span;
}

/** An identifier occurrence. Not a node: it has a span but no id. */
export interface Ident {
  readonly text: string;
  readonly span: Span;
}

/** A dotted name `a.b.C`. Segments may be names or type names. */
export interface QName {
  readonly segments: readonly Ident[];
  readonly span: Span;
}

export interface Visibility {
  readonly pub: boolean;
  readonly sealed: boolean;
}

// ---------------------------------------------------------------------------
// Module and items
// ---------------------------------------------------------------------------

export interface Module extends NodeBase {
  readonly kind: 'Module';
  readonly test: boolean;
  readonly name: QName;
  readonly imports: readonly Import[];
  readonly items: readonly Item[];
}

export interface Import extends NodeBase {
  readonly kind: 'Import';
  readonly name: QName;
}

export type Item =
  | FnDecl
  | TypeAlias
  | IntrinsicType
  | ConstDecl
  | RecordDecl
  | UnionDecl
  | InterfaceDecl
  | ImplDecl
  | ClaimDecl
  | CapabilityDecl
  | PathDecl
  | PolicyDecl
  | ExampleDecl
  | PropertyDecl;

export interface FnDecl extends NodeBase {
  readonly kind: 'FnDecl';
  readonly vis: Visibility;
  readonly constFn: boolean;
  /** Runtime-provided primitive: no body; contracts are trusted (§3.12). */
  readonly intrinsic: boolean;
  readonly name: Ident;
  readonly tparams: readonly TParam[];
  readonly params: readonly Param[];
  readonly ret: Type;
  readonly effects: readonly EffectRef[];
  readonly claims: readonly QName[];
  readonly contracts: readonly Contract[];
  /** null iff `intrinsic`. */
  readonly body: Block | null;
}

export interface TypeAlias extends NodeBase {
  readonly kind: 'TypeAlias';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly type: Type;
}

/** `intrinsic type Name[params]`: an opaque type implemented by the runtime. */
export interface IntrinsicType extends NodeBase {
  readonly kind: 'IntrinsicType';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly tparams: readonly TParam[];
}

export interface ConstDecl extends NodeBase {
  readonly kind: 'ConstDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly type: Type;
  readonly value: Expr;
}

export interface RecordDecl extends NodeBase {
  readonly kind: 'RecordDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly tparams: readonly TParam[];
  readonly fields: readonly Field[];
}

export interface Field extends NodeBase {
  readonly kind: 'Field';
  readonly name: Ident;
  readonly type: Type;
}

export interface UnionDecl extends NodeBase {
  readonly kind: 'UnionDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly tparams: readonly TParam[];
  readonly variants: readonly Variant[];
}

export interface Variant extends NodeBase {
  readonly kind: 'Variant';
  readonly name: Ident;
  readonly fields: readonly Field[];
}

export interface InterfaceDecl extends NodeBase {
  readonly kind: 'InterfaceDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly tparam: Ident;
  readonly items: readonly IfaceItem[];
}

export type IfaceItem = IfaceFn | Law;

export interface IfaceFn extends NodeBase {
  readonly kind: 'IfaceFn';
  readonly name: Ident;
  readonly params: readonly Param[];
  readonly ret: Type;
  readonly effects: readonly EffectRef[];
  readonly contracts: readonly Contract[];
}

export interface Law extends NodeBase {
  readonly kind: 'Law';
  readonly name: Ident;
  readonly params: readonly Param[];
  readonly body: Block;
}

export interface ImplDecl extends NodeBase {
  readonly kind: 'ImplDecl';
  readonly iface: Ident;
  readonly target: Type;
  readonly fns: readonly FnDecl[];
}

export interface ClaimDecl extends NodeBase {
  readonly kind: 'ClaimDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly body: ClaimBody;
}

export type ClaimBody =
  | { readonly kind: 'Derived'; readonly pred: ClaimPred }
  | { readonly kind: 'Asserted'; readonly description: string };

/** The effect-predicate language of derived claims (§6.3). */
export type ClaimPred = ClaimAtom | ClaimEffectsEq | ClaimNot | ClaimAnd | ClaimOr;

export interface ClaimAtom extends NodeBase {
  readonly kind: 'ClaimAtom';
  /** An effect (`alloc`, `io.file`) or a claim (`Total`, `m.Idempotent`). */
  readonly name: QName;
}

export interface ClaimEffectsEq extends NodeBase {
  readonly kind: 'ClaimEffectsEq';
  readonly effects: readonly EffectRef[];
}

export interface ClaimNot extends NodeBase {
  readonly kind: 'ClaimNot';
  readonly operand: ClaimPred;
}

export interface ClaimAnd extends NodeBase {
  readonly kind: 'ClaimAnd';
  readonly operands: readonly ClaimPred[];
}

export interface ClaimOr extends NodeBase {
  readonly kind: 'ClaimOr';
  readonly operands: readonly ClaimPred[];
}

export interface CapabilityDecl extends NodeBase {
  readonly kind: 'CapabilityDecl';
  readonly vis: Visibility;
  readonly name: Ident;
  readonly tparams: readonly TParam[];
  readonly grants: readonly Grant[];
}

export interface Grant extends NodeBase {
  readonly kind: 'Grant';
  readonly effect: EffectRef;
  readonly when: Expr | null;
}

export interface PathDecl extends NodeBase {
  readonly kind: 'PathDecl';
  readonly name: Ident;
  readonly entry: Ident;
  readonly clauses: readonly PathClause[];
}

export type PathClause = PathEffects | PathForbid | PathRequire | PathPolicy;

export interface PathEffects extends NodeBase {
  readonly kind: 'PathEffects';
  readonly effects: readonly EffectRef[];
}

export interface PathForbid extends NodeBase {
  readonly kind: 'PathForbid';
  readonly effects: readonly EffectRef[];
}

export interface PathRequire extends NodeBase {
  readonly kind: 'PathRequire';
  readonly claims: readonly QName[];
}

export interface PathPolicy extends NodeBase {
  readonly kind: 'PathPolicy';
  readonly name: Ident;
  readonly except: readonly QName[];
}

export interface PolicyDecl extends NodeBase {
  readonly kind: 'PolicyDecl';
  readonly name: Ident;
  readonly outside: readonly PolicyScope[];
}

export interface PolicyScope extends NodeBase {
  readonly kind: 'PolicyScope';
  /** `self`, or a module name, optionally with a trailing `.*` glob. */
  readonly name: QName | null;
  readonly glob: boolean;
}

export interface ExampleDecl extends NodeBase {
  readonly kind: 'ExampleDecl';
  readonly name: Ident;
  readonly body: Block;
}

export interface PropertyDecl extends NodeBase {
  readonly kind: 'PropertyDecl';
  readonly name: Ident;
  readonly params: readonly Param[];
  readonly body: Block;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export type TParam = TypeParam | ConstParam | EffectParam;

export interface TypeParam extends NodeBase {
  readonly kind: 'TypeParam';
  readonly name: Ident;
  readonly bound: Ident | null;
}

export interface ConstParam extends NodeBase {
  readonly kind: 'ConstParam';
  readonly name: Ident;
  readonly type: Type;
}

export interface EffectParam extends NodeBase {
  readonly kind: 'EffectParam';
  readonly name: Ident;
}

export interface Param extends NodeBase {
  readonly kind: 'Param';
  readonly inout: boolean;
  readonly name: Ident;
  readonly type: Type;
}

export interface EffectRef extends NodeBase {
  readonly kind: 'EffectRef';
  readonly name: QName;
}

export interface Contract extends NodeBase {
  readonly kind: 'Contract';
  /** `decreases` is the termination measure of a recursive function (§5.1). */
  readonly clause: 'requires' | 'ensures' | 'decreases';
  readonly proved: boolean;
  readonly expr: Expr;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Type = NamedType | FnType;

export interface NamedType extends NodeBase {
  readonly kind: 'NamedType';
  readonly name: QName;
  readonly args: readonly TypeArg[];
  readonly where: Expr | null;
}

export interface FnType extends NodeBase {
  readonly kind: 'FnType';
  /** Named: the labels used when calling through a value of this type. */
  readonly params: readonly Param[];
  readonly ret: Type;
  readonly effects: readonly EffectRef[];
}

export type TypeArg = TypeArgType | TypeArgConst;

export interface TypeArgType extends NodeBase {
  readonly kind: 'TypeArgType';
  readonly label: Ident | null;
  readonly type: Type;
}

export interface TypeArgConst extends NodeBase {
  readonly kind: 'TypeArgConst';
  readonly label: Ident | null;
  readonly expr: Expr;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface Block extends NodeBase {
  readonly kind: 'Block';
  readonly stmts: readonly Stmt[];
  /** `{ ... }`: a function body elided by an interface rendering (§11.1); `stmts` is empty. Valid only in interface documents (E0115). */
  readonly elided: boolean;
}

export type Stmt = Let | Var | Assign | Return | If | Match | Loop | For | Assume | ExprStmt;

export interface Let extends NodeBase {
  readonly kind: 'Let';
  readonly name: Ident;
  readonly type: Type;
  readonly value: Expr;
}

export interface Var extends NodeBase {
  readonly kind: 'Var';
  readonly name: Ident;
  readonly type: Type;
  readonly value: Expr;
}

export interface Assign extends NodeBase {
  readonly kind: 'Assign';
  readonly name: Ident;
  readonly value: Expr;
}

export interface Return extends NodeBase {
  readonly kind: 'Return';
  readonly value: Expr;
}

export interface If extends NodeBase {
  readonly kind: 'If';
  readonly cond: Expr;
  readonly then: Block;
  readonly else: Block | null;
}

export interface Match extends NodeBase {
  readonly kind: 'Match';
  readonly scrutinee: Expr;
  readonly arms: readonly Arm[];
}

export interface Arm extends NodeBase {
  readonly kind: 'Arm';
  readonly pattern: Pattern;
  readonly guard: Expr | null;
  readonly body: Stmt | Block;
}

export interface Loop extends NodeBase {
  readonly kind: 'Loop';
  readonly cond: Expr;
  readonly clauses: readonly LoopClause[];
  readonly body: Block;
}

export interface LoopClause extends NodeBase {
  readonly kind: 'LoopClause';
  readonly clause: 'invariant' | 'decreases';
  readonly expr: Expr;
}

export interface For extends NodeBase {
  readonly kind: 'For';
  readonly name: Ident;
  readonly type: Type;
  readonly domain: Domain;
  readonly body: Block;
}

export type Domain = RangeDomain | InDomain;

export interface RangeDomain extends NodeBase {
  readonly kind: 'RangeDomain';
  readonly lo: Expr;
  readonly hi: Expr;
}

export interface InDomain extends NodeBase {
  readonly kind: 'InDomain';
  readonly expr: Expr;
}

export interface Assume extends NodeBase {
  readonly kind: 'Assume';
  readonly claim: QName;
  readonly justification: string;
}

export interface ExprStmt extends NodeBase {
  readonly kind: 'ExprStmt';
  readonly expr: Expr;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | IntLit
  | FloatLit
  | TextLit
  | BoolLit
  | DurationLit
  | Name
  | It
  | ResultRef
  | Ctor
  | RecordUpdate
  | ListLit
  | Try
  | Recover
  | Old
  | Quantifier
  | Closure
  | Fake
  | FieldAccess
  | Call
  | Unary
  | Binary
  | And
  | Or
  | Is;

export interface IntLit extends NodeBase {
  readonly kind: 'IntLit';
  readonly value: bigint;
}

export interface FloatLit extends NodeBase {
  readonly kind: 'FloatLit';
  readonly value: number;
}

export interface TextLit extends NodeBase {
  readonly kind: 'TextLit';
  readonly value: string;
}

export interface BoolLit extends NodeBase {
  readonly kind: 'BoolLit';
  readonly value: boolean;
}

export interface DurationLit extends NodeBase {
  readonly kind: 'DurationLit';
  /** Nanoseconds. */
  readonly nanos: bigint;
}

export interface Name extends NodeBase {
  readonly kind: 'Name';
  readonly name: Ident;
}

export interface It extends NodeBase {
  readonly kind: 'It';
}

export interface ResultRef extends NodeBase {
  readonly kind: 'ResultRef';
}

/** `QTNAME [call_args] [{ field_inits }]`: variant, record, or bare type-name value. */
export interface Ctor extends NodeBase {
  readonly kind: 'Ctor';
  readonly name: QName;
  readonly args: readonly Arg[] | null;
  readonly fields: readonly FieldInit[] | null;
}

export interface FieldInit extends NodeBase {
  readonly kind: 'FieldInit';
  readonly name: Ident;
  readonly value: Expr;
}

export interface RecordUpdate extends NodeBase {
  readonly kind: 'RecordUpdate';
  readonly base: Expr;
  readonly fields: readonly FieldInit[];
}

export interface ListLit extends NodeBase {
  readonly kind: 'ListLit';
  readonly elems: readonly Expr[];
}

export interface Try extends NodeBase {
  readonly kind: 'Try';
  readonly expr: Expr;
  readonly else: TryElse | null;
}

export interface TryElse extends NodeBase {
  readonly kind: 'TryElse';
  readonly name: Ident;
  readonly expr: Expr;
}

export interface Recover extends NodeBase {
  readonly kind: 'Recover';
  readonly body: Block;
}

export interface Old extends NodeBase {
  readonly kind: 'Old';
  readonly name: Ident;
}

export interface Quantifier extends NodeBase {
  readonly kind: 'Quantifier';
  readonly quant: 'forall' | 'exists';
  readonly name: Ident;
  readonly type: Type;
  readonly domain: Domain | null;
  readonly where: Expr | null;
  readonly body: Expr;
}

export interface Closure extends NodeBase {
  readonly kind: 'Closure';
  readonly params: readonly Param[];
  readonly ret: Type;
  readonly effects: readonly EffectRef[];
  readonly body: Block;
}

export interface Fake extends NodeBase {
  readonly kind: 'Fake';
  readonly capability: QName;
  readonly fields: readonly FieldInit[];
}

export interface FieldAccess extends NodeBase {
  readonly kind: 'FieldAccess';
  readonly object: Expr;
  readonly name: Ident;
}

export interface Call extends NodeBase {
  readonly kind: 'Call';
  readonly callee: Expr;
  readonly targs: readonly TypeArg[] | null;
  readonly args: readonly Arg[];
}

export interface Arg extends NodeBase {
  readonly kind: 'Arg';
  readonly name: Ident;
  readonly inout: boolean;
  readonly value: Expr;
}

export type UnaryOp = 'neg' | 'not';

export interface Unary extends NodeBase {
  readonly kind: 'Unary';
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type BinaryOp = '*' | '/' | '%' | '+' | '-' | '++' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'implies';

export interface Binary extends NodeBase {
  readonly kind: 'Binary';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface And extends NodeBase {
  readonly kind: 'And';
  readonly operands: readonly Expr[];
}

export interface Or extends NodeBase {
  readonly kind: 'Or';
  readonly operands: readonly Expr[];
}

export interface Is extends NodeBase {
  readonly kind: 'Is';
  readonly expr: Expr;
  readonly pattern: Pattern;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export type Pattern = WildcardPat | BindPat | LitPat | VariantPat;

export interface WildcardPat extends NodeBase {
  readonly kind: 'WildcardPat';
}

export interface BindPat extends NodeBase {
  readonly kind: 'BindPat';
  readonly name: Ident;
}

export interface LitPat extends NodeBase {
  readonly kind: 'LitPat';
  readonly literal: IntLit | FloatLit | TextLit | BoolLit | DurationLit | Unary;
}

export interface VariantPat extends NodeBase {
  readonly kind: 'VariantPat';
  readonly name: QName;
  /** null when written without parentheses. */
  readonly fields: readonly PatField[] | null;
}

export type PatField = PatFieldName | PatFieldSkip | PatFieldRest;

export interface PatFieldName extends NodeBase {
  readonly kind: 'PatFieldName';
  readonly name: Ident;
}

export interface PatFieldSkip extends NodeBase {
  readonly kind: 'PatFieldSkip';
}

export interface PatFieldRest extends NodeBase {
  readonly kind: 'PatFieldRest';
}

/** Every node kind, for exhaustive walks. */
export type Node =
  | Module
  | Import
  | Item
  | Field
  | Variant
  | IfaceItem
  | ClaimPred
  | Grant
  | PathClause
  | PolicyScope
  | TParam
  | Param
  | EffectRef
  | Contract
  | Type
  | TypeArg
  | Block
  | Stmt
  | Arm
  | LoopClause
  | Domain
  | Expr
  | FieldInit
  | TryElse
  | Arg
  | Pattern
  | PatField;

// ---------------------------------------------------------------------------
// Id assignment
// ---------------------------------------------------------------------------

import { children } from './walk.js';

type WritableId = { id: NodeId };

/**
 * Assigns ids to every node under `root` in pre-order, starting at `first`.
 * Called exactly once by the parser after the tree is built; the tree is
 * immutable afterwards.
 * Preconditions: `root` was produced by the parser and has not been renumbered.
 * Postconditions: ids under `root` are `first .. first + n - 1` in pre-order.
 * Effects: mutates `id` on every node under `root`.
 */
export function renumber(root: Node, first: number): number {
  let next = first;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) break;
    // The single sanctioned mutation of a node, confined to this file.
    (n as unknown as WritableId).id = nodeId(next);
    next += 1;
    const cs = children(n);
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (c !== undefined) stack.push(c);
    }
  }
  return next;
}
