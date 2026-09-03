# Onus — language specification, v0

*Draft. Sections marked **provisional** are proposals to be argued with; everything else records a design decision from the September 2026 discussion.*

---

## 1. Purpose

Onus is a programming language in which the primary author of function bodies is a language model, the primary reader is a human verifying claims about those bodies, and the only checker is the compiler.

Every design choice follows from three questions, in this order:

1. Can the compiler reject it? If a class of error can be made a compile error, it is.
2. Can the reviewer see it? Anything that affects what a function may do must be visible in its signature, not its body.
3. Is it cheap for a model to write? Token count and verbosity are not costs. Ambiguity, hidden state and implicit behaviour are.

The burden of proof is on the code. A body is accepted when it demonstrably meets its contract; the reviewer's job is to check that the contract says what was meant.

### 1.1 Principles

- **Pure by default.** A function with no declared effects can only compute.
- **Explicit everything.** No type inference, no implicit conversions, no default arguments, no ambient state, no reflection, no macros, no exceptions, no globals.
- **Claims are checked or visibly assumed.** Every obligation ends in exactly one of three states — *proved*, *checked at runtime*, or *assumed* — and the compiler reports which, per obligation.
- **Authority flows down.** Capabilities are unforgeable values constructed at the program root and attenuated on the way to the code that uses them. Nothing acquires authority it wasn't handed.
- **Local reasoning is sufficient.** A function's signature and contract must be enough to check every caller without reading the body. A module's interface must be enough to review it.
- **One compiler, no linter.** Conventions that would otherwise be lint rules are expressed as claims or path declarations and checked by the same machinery as everything else. There is no second tool, no configurable rule set, and no warning level: a diagnostic is an error.
- **Canonical form.** There is exactly one way to format any program. Non-canonical source is a diagnostic with an automatic fix.

### 1.2 Non-goals

- Human typing ergonomics. Onus is verbose on purpose.
- Gradual adoption inside existing codebases. The trust model doesn't survive an escape hatch that isn't declared.
- Full dependent types or a general proof assistant. Onus targets a decidable verification fragment and pushes the rest to runtime checks, visibly.
- Concurrency, in v0. See §17.

---

## 2. Lexical structure and grammar (**provisional**)

The grammar is designed to be prefix-decidable so that a constrained decoder can compute the set of legal next tokens at every position with a single-token lookahead. Concretely: LL(1), no significant whitespace, no operator overloading, and mandatory delimiters.

**Borrowing policy.** The data model — discriminated unions with `of`, `match ... with` and `when` guards, `{ x with ... }` record update — is taken from F#, because those designs are the best available and a model's prior for them is exactly right. Everything else is deliberately *not* F#: explicit braces, mandatory annotations, named arguments, no currying, no pipelines. The intent is that a body does not read as any language the model already writes fluently, so that language's habits (inference, partial application, `Option` idioms) are not triggered. Steal the semantics, not the silhouette.

- Identifiers: `[a-z][a-z0-9_]*` for values and functions; `[A-Z][A-Za-z0-9]*` for types, unions, variants, claims, capabilities and modules.
- Keywords are reserved and cannot be shadowed.
- Blocks are `{ ... }`. Statements are newline-terminated; a statement cannot span lines except inside parentheses or brackets.
- Comments: `--` to end of line. Comments carry no semantics and are excluded from the canonical hash of a definition. <!-- changed: M1 — the canonical printer preserves comments, attached to the line-level construct they precede or follow; see docs/grammar-v0.md --> The canonical printer preserves them.

### 2.1 Operators

Onus has two precedence levels and no associativity surprises:

| Level | Operators |
|---|---|
| multiplicative | `*` `/` `%` |
| additive | `+` `-` `++` (text/list concatenation) |

Comparison operators (`==` `!=` `<` `<=` `>` `>=`) are non-associative: `a < b < c` is a syntax error. `and`, `or`, `not` cannot be mixed without parentheses: `a and b or c` is a syntax error; `(a and b) or c` is required. There is no ternary; use `if`.

### 2.2 Canonical form

<!-- changed: M1 — the layout rules are made precise in docs/grammar-v0.md ("Canonical form"); see docs/CHANGES.md items 17–20 -->
The precise layout rules are in `docs/grammar-v0.md`. The compiler owns formatting. `onus check` reports non-canonical source as diagnostic `E0001` with the canonical text as its fix. Indentation is two spaces; one declaration per top-level item; one blank line between items; named arguments always on the call line unless the call exceeds 100 columns, in which case one argument per line. Every definition has a canonical byte sequence and a content hash used for proof caching.

### 2.3 Grammar (**provisional**)

<!-- changed: M1 — the grammar as implemented is docs/grammar-v0.md; the productions below are patched where implementation showed them unworkable or inconsistent with the examples (docs/CHANGES.md items 1–16). Notable: continuation newlines before `->` `else` `{` `claims` `requires` `ensures` `invariant` `decreases` are not significant; `{ stmt }` on one line is accepted and canonicalised; soft keywords. -->
The grammar as implemented, with the canonical form, is `docs/grammar-v0.md`; the EBNF below is patched to agree with it. EBNF. `NL` is a newline token; the lexer emits one per line end outside brackets. Every production is intended to be LL(1); where it is not, that is a bug in this section, not a feature of the language.

```
module      = [ "test" ] "module" QNAME NL { "import" QNAME NL } { item } ;   (* changed: M1, test modules §8.4 *)

item        = fn_decl | type_alias | record_decl | union_decl | interface_decl
            | impl_decl | claim_decl | capability_decl | path_decl | policy_decl
            | example_decl | property_decl | const_decl ;

visibility  = [ "pub" ] [ "sealed" ] ;

fn_decl     = visibility [ "const" ] [ "intrinsic" ] "fn" NAME [ tparams ] "(" [ params ] ")" "->" type [ "!" effects ]
              [ "claims" claim_list ] { contract } ( block | NL ) ;   (* changed: M1 newlines; M2 intrinsic §3.12: no body *)
tparams     = "[" tparam { "," tparam } "]" ;
tparam      = TNAME [ ":" TNAME ]                       (* type parameter, optional bound *)
            | "const" NAME ":" type                     (* compile-time value parameter *)
            | NAME ;                                    (* effect parameter *)
params      = param { "," param } ;
param       = NAME ":" [ "inout" ] type ;               (* changed: M1, matches §4.1 and the call site *)
effects     = effect { "," effect } ;
effect      = QNAME | NAME ;                            (* primitive, claim, or effect parameter *)
contract    = "requires" [ "proved" ] expr
            | "ensures"  [ "proved" ] expr ;

type        = QTNAME [ "[" targ { "," targ } "]" ] [ "where" expr ]
            | "fn" "(" [ params ] ")" "->" type [ "!" effects ] ;   (* changed: M2, parameters are named; §3.7 *)
targ        = [ NAME ":" ] ( type | expr ) ;            (* expr must be constant, §3.8; changed: M1, labelled per §8.2 *)

type_alias  = visibility ( "type" TNAME "=" type | "intrinsic" "type" TNAME [ tparams ] ) NL ;   (* changed: M2, §3.12 *)
const_decl  = visibility "const" NAME ":" type "=" expr NL ;
record_decl = visibility "record" TNAME [ tparams ] "{" NL { field NL } "}" NL ;
field       = NAME ":" type ;
union_decl  = visibility "union" TNAME [ tparams ] "=" NL { "|" variant NL } ;
variant     = TNAME [ "of" field { "," field } ] ;

interface_decl = visibility "interface" TNAME "[" TNAME "]" "{" NL { iface_item NL } "}" NL ;
iface_item  = "fn" NAME "(" [ params ] ")" "->" type [ "!" effects ] NL { contract NL }
            | "law" NAME "(" [ params ] ")" block ;
impl_decl   = "impl" TNAME "[" type "]" "{" NL { fn_decl } "}" NL ;

claim_decl  = visibility "claim" TNAME ( ":=" claim_pred | STRING ) NL ;   (* changed: M1, claim_pred is the §6.3 effect-predicate language *)
capability_decl = visibility "capability" TNAME [ tparams ] NL { "grants" effect [ "when" expr ] NL } ;
path_decl   = "path" NAME NL "entry" NAME NL { path_clause NL } ;
path_clause = "effects" "<=" "{" [ effects ] "}"
            | "forbid" "{" effects "}"
            | "require" "{" claim_list "}"
            | "policy" NAME [ "except" "{" QNAME { "," QNAME } "}" ] ;
policy_decl = "policy" NAME NL "forbid" "assume" "outside" "{" scope { "," scope } "}" NL ;
scope       = "self" | QNAME [ "." "*" ] ;                (* changed: M1 *)

example_decl  = "example" NAME block ;
property_decl = "property" NAME "(" [ params ] ")" block ;

block       = "{" ( NL { stmt NL } | [ stmt ] ) "}" ;   (* changed: M1, one-line form canonicalises to multi-line *)
            | "{" "..." "}" ;   (* changed: M7, docs/CHANGES.md item 72 — an elided body, valid only as a fn body in an interface rendering (§11.1); E0115 elsewhere *)
stmt        = "let" NAME ":" type "=" expr
            | "var" NAME ":" type "=" expr
            | NAME "=" expr
            | "return" expr
            | "if" expr block [ "else" ( block | if_stmt ) ]
            | "match" expr "with" NL { "|" pattern [ "when" expr ] "->" ( stmt | block ) NL }
            | "loop" "while" expr { loop_clause } block       (* changed: M1 *)
            | "for" NAME ":" type "in" domain block           (* changed: M1 *)
            | "assume" TNAME STRING
            | expr ;                                    (* call for effect *)
loop_clause = "invariant" expr | "decreases" expr ;
domain      = expr [ "..<" expr ] ;                      (* changed: M1, ranges §5.1 §5.3 *)

expr        = or_expr [ "implies" or_expr ] ;           (* changed: M1, non-associative; §3.6 *)
or_expr     = and_expr [ "or" and_expr { "or" and_expr } ] ;
and_expr    = not_expr [ "and" not_expr { "and" not_expr } ] ;
not_expr    = [ "not" ] cmp_expr ;
cmp_expr    = add_expr [ CMP_OP add_expr | "is" pattern ] ;   (* non-associative; changed: M1, `is` §3.8.1 *)
add_expr    = mul_expr { ( "+" | "-" | "++" ) mul_expr } ;
mul_expr    = unary { ( "*" | "/" | "%" ) unary } ;
unary       = [ "-" ] postfix ;
postfix     = primary { "." NAME | [ "[" targ { "," targ } "]" ] call_args } ;   (* changed: M1, explicit args §18.2 *)
primary     = LITERAL | NAME | "it" | "result"
            | QTNAME [ call_args ] [ "{" [ field_init { "," field_init } ] "}" ]   (* record ctor / variant ctor *)
            | "{" expr "with" field_init { "," field_init } "}"                    (* record update *)
            | "(" expr ")" | "[" [ expr { "," expr } ] "]"
            | "try" expr [ "else" NAME ":" expr ]
            | "recover" block
            | "old" "(" NAME ")"
            | ( "forall" | "exists" ) NAME ":" type [ "in" domain ] [ "where" expr ] ":" expr   (* changed: M1; the binder type has no where of its own *)
            | "fn" "(" [ params ] ")" "->" type [ "!" effects ] block    (* closure *)
            | "fake" QTNAME "{" [ field_init { "," field_init } ] "}" ;  (* changed: M1, §8.4; syntax error outside a test module *)
call_args   = "(" [ NAME ":" [ "inout" ] expr { "," NAME ":" [ "inout" ] expr } ] ")" ;   (* changed: M1, §4.1 *)
field_init  = NAME ":" expr ;
pattern     = "_" | NAME | LITERAL
            | QTNAME [ "(" pat_field { "," pat_field } ")" ] ;
pat_field   = NAME | "_" | ".." ;                       (* fields in declaration order; NAME binds that field *)
```

Notes: `or_expr` and `and_expr` cannot nest without parentheses, so mixed `and`/`or` is rejected by the parser, not a later pass. In expression position `{` begins a record update and `[` a list literal; blocks only occur in statement position, so there is no ambiguity. A `match` arm body is a single statement or a block. `if ... else if` chains are sugar for nested blocks and are canonicalised as such. A bare `expr` statement must be a call; anything else is `E0002 expression statement has no effect`. Durations (`50ms`, `2s`) are `LITERAL`s of type `Duration`.

---

## 3. Types

### 3.1 Primitives

| Type | Notes |
|---|---|
| `Int` | 64-bit signed. Overflow is a contract violation, not wraparound. Refinements narrow it. |
| `Float` | IEEE 754 double. `NaN` and infinities are values that must be excluded by refinement or handled by `match` on `Float.classify`. |
| `Bool` | |
| `Text` | UTF-8, immutable, no character indexing. Grapheme and byte views via the standard library. Literals are single-line; a newline is written `\n`. <!-- changed: M1, one canonical spelling per value --> |
| `Unit` | The single value `Unit`. |
| `Byte` | `Int where 0 <= it and it <= 255`; a refinement alias, not a distinct representation. |
| `Bytes` | Immutable byte sequence. Indexed by `Int where 0 <= it and it < len`. |
| `Duration` | Non-negative nanoseconds. Literals `50ms`, `2s`, `1500us`. Arithmetic is `Int`-like and verified as such. |

Fixed-width and unsigned integers are refinement aliases over `Int` (`type UInt16 = Int where 0 <= it and it <= 65_535`). Wire layout is a `Bytes` codec concern, not a type concern; values never carry a representation.

There are no implicit conversions. `Float.of(x: Int)` and `Int.floor(x: Float) -> Result[Int, RangeError]` are library functions.

### 3.2 Refinement types

```
type Iter  = Int where 0 <= it and it <= 10_000
type Coord = Int where 0 <= it
type Ratio = Float where 0.0 <= it and it <= 1.0
```

`it` names the value being refined. A refined type is a subtype of its base; the base is not a subtype of the refinement. Flowing a base value into a refined position generates an obligation.

Refinements may also be written inline on parameters and fields: `limit: Iter where it > 0`.

Units of measure (F#'s `float<m>`) are the obvious next refinement idiom — a phantom index on `Int`/`Float` checked by the type system rather than the verifier. Not in v0; recorded in §17.

**Verification status by base type:**

- `Int` refinements in linear arithmetic (comparison, `+`, `-`, multiplication by a constant) are proved.
- `Int` refinements involving `*` of two variables, `/` or `%` are proved where the solver can and checked at runtime otherwise.
- `Float` refinements are checked at runtime unless the function is annotated `proves float`, which admits real-arithmetic reasoning and is expected to time out often.

#### 3.2.1 Flow-sensitive refinement

The verifier's knowledge of a value is path-sensitive. Within a branch, the branch condition and everything implied by prior conditions on the path are available when discharging obligations:

```
fn clamp(x: Int, lo: Int, hi: Int where it >= lo) -> Int where lo <= it and it <= hi {
  if x < lo { return lo }        -- obligation: lo <= lo <= hi. proved.
  if x > hi { return hi }        -- proved.
  return x                        -- here: not (x < lo) and not (x > hi). proved.
}
```

Rules:

- A condition of the form `expr` on `if`, the negation on `else`, a `match` arm's variant and guard, and a loop's `while` condition inside its body are all added to the path knowledge for that scope.
- A `var` loses path knowledge at every assignment; only its declared type remains.
- Knowledge about `x` does not survive a call that passes `x` as `inout`.
- The compiler does not *change* a binding's static type on a branch. `x` is still `Int`; the refinement obligation `x >= 0` is simply discharged from path knowledge when needed. This keeps types stable and readable in diagnostics.
- Refinements are never inferred onto declarations. If a function's *interface* should promise `result >= 0`, that is an `ensures` or a refined return type, written explicitly.

### 3.3 Records

```
record Viewport {
  x_min: Float
  x_max: Float where it > x_min
  y_min: Float
  y_max: Float where it > y_min
}
```

Records are structural value types. Field refinements may reference earlier fields (dependent records); the constraints are obligations at construction and at every `with`.

Update is by `with`, producing a new value: `{ view with x_max: 2.0 }`.

### 3.4 Unions

```
union Pixel =
  | Inside
  | Escaped of at: Iter where it > 0
  | Skipped of reason: Text
```

Construction uses the variant name with named fields: `Escaped(at: 12)`, `Inside`. Variant fields are named, never positional, at construction; patterns list them in declaration order (§3.9).

Unions are nominal and closed. `match` must be exhaustive and has no default arm; adding a variant breaks every match that does not handle it. An arm no value can reach is likewise an error. Variant payloads may carry refinements. Unions have no numeric backing and no ordering unless an `Ord` implementation is provided.

Variant names are in scope bare within the declaring module, and from importing modules either bare (when exactly one imported or prelude union declares that name) or qualified by the module alias (`sql.Refinement`). Two unions in one module may not share a variant name. <!-- changed: M2, docs/CHANGES.md item 30 -->

`Option[T]` and `Result[T, E]` are ordinary library unions.

### 3.5 Indexed types

Types may be parameterised by compile-time `Int` values as well as by types:

```
Grid[T, width: Int where it > 0, height: Int where it > 0]
```

An index must be a constant, a parameter refined at least as strongly, or an expression the verifier can evaluate. Index arithmetic follows the same verification rules as `Int` refinements.

### 3.6 Generics and interfaces

An interface declares signatures, contracts on those signatures, and `law` blocks: properties that must hold for every implementation. A `law` is quantified over the implementing type and becomes an obligation on every `impl`, so generic code that relies on it can be verified once against the interface rather than per type.

```
interface Codec[T] {
  fn encode(value: T) -> Text ! alloc
  fn decode(text: Text) -> Result[T, CodecError] ! alloc

  law round_trip(value: T) {
    decode(text: encode(value: value)) == Ok(value)
  }
}

impl Codec[MonthlyTotal] {
  fn encode(value: MonthlyTotal) -> Text ! alloc {
    return value.month ++ "," ++ Int.to_text(x: value.total_pence)
  }
  fn decode(text: Text) -> Result[MonthlyTotal, CodecError] ! alloc {
    ...
  }
}
```

The law says exactly what it means: whatever is written out is read back. `Text` is opaque to the verifier, so `round_trip` for this `impl` is discharged by running it under generated `MonthlyTotal` values and reported in the interface as *checked*, never *proved*.

Laws over integers are usually provable:

```
interface Ord[T] {
  fn compare(a: T, b: T) -> Ordering
    ensures compare(a: a, b: a) == Equal
    ensures compare(a: a, b: b) == Less implies compare(a: b, b: a) == Greater

  law transitive(a: T, b: T, c: T) {
    (compare(a: a, b: b) == Less and compare(a: b, b: c) == Less) implies compare(a: a, b: c) == Less
  }
}

impl Ord[Int] {
  fn compare(a: Int, b: Int) -> Ordering {
    if a < b { return Less }
    if a > b { return Greater }
    return Equal
  }
}
-- both ensures and transitive: proved
```

Rules:

- Implementations are explicit (`impl Ord[Int] { ... }`); there is no structural or automatic conformance.
- Generic code calls an interface function through the interface: `Ord.compare(a: x, b: y)`. The implementing type is taken from the arguments and must have an `impl`, or be a type parameter bounded by the interface. <!-- changed: M2, docs/CHANGES.md item 35 -->
- Every contract and law on the interface is an obligation on every `impl`, with the usual proved/checked status.
- An `impl` may not declare effects beyond those in the interface signature. An interface that wants to admit allocating or effectful implementations declares the effect (as `Codec` does with `alloc`) or is effect-polymorphic (`fn f(x: T) -> U ! e`).
- There is no overloading and no ad-hoc polymorphism outside interfaces.

Type parameters are declared with their constraints: `fn sort[T: Ord](xs: List[T]) -> List[T] ! alloc`.

### 3.7 Function values and closures

A function value has type `fn(a: A, b: B) -> R ! e`. Parameters of a function type are named — the names are the labels a caller uses, since every call passes arguments by name (§5) — and may carry refinements; the effect set is part of the type. A closure assigned to a function type may name its own parameters differently; assignability compares positions, types and effects. <!-- changed: M2, function types carry parameter names; without them a call through a function value could not be written -->

```
let step: fn(n: Int where it >= 0) -> Int where it >= 0 = fn(m: Int where it >= 0) -> Int where it >= 0 {
  return m + 1
}
step(n: 3)
```

Rules:

- A closure captures `let` bindings and parameters by value. It cannot capture a `var`, an `inout` parameter, or a capability.
- A closure's effect set is the union of the effects of everything it calls. Passing a closure to an effect-polymorphic parameter `fn(T) -> U ! e` instantiates `e`.
- Function values are values: they may be stored, returned and passed. They may not be compared for equality.
- **Provenance.** For path checking, a call through a function value is resolved to the set of closures and named functions that could reach it, computed by a whole-program flow analysis over `let` bindings, record fields, and list literals. Where that set is finite and known, the path check proceeds against each member. Where it is not — a function value read from a `Map`, decoded from input, or built from a value the analysis cannot follow — the call is *unresolvable* and any path that reaches it fails with `E0410`. Code off a path may call unresolvable function values freely; effect checking is still exact there, because the *type* of the value bounds its effects even when its identity is unknown.

### 3.8 Compile-time constants

A `const` is an expression the compiler evaluates during checking:

```
pub const max_iter: Iter = 10_000
```

Constant expressions are: literals; `const` names; arithmetic, comparison and boolean operators over constants; record and union construction from constants; and calls to functions marked `const fn`, which must be pure, total, and have every obligation proved.

Constant parameters (`[const width: Int where it > 0]`) let a function or type demand a value known at check time. Type indices (`Grid[T, 800, 600]`) are constant parameters.

#### 3.8.1 Library-defined check-time validation

There are no macros, syntax extensions or compiler plugins. Anything a library wants checked at compile time, it checks with a `const fn` that the compiler evaluates during checking. The library brings its own parser; the compiler brings the evaluator.

```
-- in std.sql, ordinary Onus, verified like everything else
pub const fn parse_select(text: Text) -> Result[SelectAst, ConstError] ! alloc

pub const fn columns_match(text: Text, record: TypeInfo) -> Result[Unit, ConstError] ! alloc

pub intrinsic fn select[const text: Text, T](params: List[Param], row: TypeInfo) -> Select[T]
  requires proved parse_select(text: text) is Ok
  requires proved columns_match(text: text, record: row) is Ok
```

Rules:

- A `const fn` must be pure apart from `alloc`, and `total`, with every obligation *proved*. The check-time evaluator therefore always terminates and never panics. <!-- changed: M4, docs/CHANGES.md items 52–55: allocation is admitted; until obligations are proved, a failing contract during evaluation is E0701 and a budget overrun is E0501 -->
- Evaluation runs under the standard per-obligation budget (§12.3). A library cannot make checking slow without `E0501` saying which `const fn` did it.
- `ConstError` (`std.check.ConstError { offset, message }`) carries a grapheme `offset` into the constant being checked. When a `requires proved` clause of a call with constant arguments evaluates to false and a `ConstError` was produced, the compiler emits `E0700 library check failed` with the location mapped into the literal passed for the callee's first `const` Text parameter — a malformed SQL string is reported at the character in the string, not at the call. <!-- changed: M4, docs/CHANGES.md items 53–54 -->
- A `const fn` may compute over types: `columns_match` receives the record type `T` as a `TypeInfo` value (fields, names, refinements) and compares it to the parser's projected columns. Field/column mismatch is a compile error.
- A `const fn` may return a `Spec` — a value of the contract language's own AST type. A `requires` or `ensures` clause may reference it with `spec(...)`, and the verifier consumes it as a predicate. This is how a `where` clause in a query becomes a postcondition on the rows (§18.3) without `std.sql` having any standing the user's own library could not have.

The design intent: the compiler has no knowledge of SQL, regular expressions, date formats, URLs, or anything else. A library that wants its literals checked writes the checker in Onus, ships it, and gets the same diagnostics and the same verification of its checker as user code.

### 3.9 Pattern matching

```
match p with
| Inside                      -> return 0
| Escaped(at) when at < 10    -> return 16
| Escaped(at)                 -> return 255 * at / limit
| Skipped(..)                 -> return 128
```

- Arms are tried in order. A guard (`when expr`) makes an arm conditional; the compiler tracks guard coverage, so the two `Escaped` arms above are exhaustive together and would not be with only the first.
- A pattern lists the variant's fields in declaration order. A field name binds that field; `_` skips one; `..` skips the rest; a bare variant name matches any payload, like `Variant(..)`. Writing a name that is not the field at that position is `E0310 pattern field mismatch` — patterns cannot rename. <!-- changed: M3, docs/CHANGES.md item 51 -->
- Nested patterns on payload fields are not supported in v0; match on the field in a nested `match`. (This keeps exhaustiveness checking trivially decidable and the grammar LL(1). Revisit if it proves painful.)
- Bound fields carry their declared refinements into the arm as path knowledge.
- `match` on `Bool`, `Int` and `Text` literals is permitted and requires a `_` arm.

### 3.10 Visibility and sealed types

- Items are private to their module unless `pub`.
- `pub record` and `pub union` expose the type, its fields or variants for reading and matching, *and* construction.
- `pub sealed record` / `pub sealed union` expose the type and reading, but construction and `with` are restricted to the defining module. This is how a type becomes evidence: `auth.AuthedCustomer` is `pub sealed`, so the only way to obtain one is through a function in `auth` that chose to return it.
- `sealed` is the whole mechanism for typestate. There is no separate feature.

### 3.11 Streams

`Stream[T] ! e` is a lazy sequence whose elements are produced on demand with effect `e`. `for` iterates ranges, `List[T]` and `Stream[T]`; iterating a stream adds its effect to the enclosing function.

```
fn total_pence(rows: Stream[Order] ! sql.read) -> Result[Int where it >= 0, sql.Error] ! sql.read {
  var sum: Int where it >= 0 = 0
  for row: Order in rows {
    sum = sum + row.amount_pence            -- overflow obligation: checked
  }
  return Ok(sum)
}
```

Streams are single-pass and cannot be stored in records or captured. Library sources: `sql.stream`, `io.lines`, `io.chunks`, `List.stream`. Termination of a `for` over a stream is the stream's responsibility: a stream is declared `finite` or the consuming function declares `diverge`.

---

### 3.12 Intrinsics

<!-- changed: M2, the bottom of the standard library needs a declared, closed way out to the runtime; see docs/CHANGES.md item 25 -->
The standard library is Onus, but its lowest operations — grapheme counting, float conversion, typed-array grids, file and socket access — have no Onus body. They are declared as *intrinsics*:

```
pub intrinsic type Grid[T, const width: Int where it > 0, const height: Int where it > 0]

pub intrinsic fn len(t: Text) -> Int where it >= 0

pub intrinsic fn set[T, const w: Int, const h: Int](g: inout Grid[T, w, h], x: Int where 0 <= it and it < w, y: Int where 0 <= it and it < h, v: T) -> Unit ! mutate
  ensures get(g: g, x: x, y: y) == v
```

Rules:

- `intrinsic` is legal only in modules named `std.…`, and only the compiler's own standard library may declare such modules. There is no other way to reach code that is not Onus; this is the declared, enumerated escape hatch that §1.2 requires.
- An intrinsic function has a signature, effects and contracts but no body. It is bound by its qualified name to an export of the runtime package; a missing or mismatched export is a build failure.
- An intrinsic type is opaque: it has no fields or variants, and only the functions of its module operate on it.
- An intrinsic's `ensures` clauses and effects cannot be proved. They are recorded in the ledger as **assumed** obligations whose justification names the runtime module, so every path that reaches an intrinsic shows that trust (§12.2). Its `requires` clauses are ordinary obligations at call sites.
- A `const intrinsic fn` may be evaluated at check time (§3.8); the evaluator calls the same runtime implementation. Effectful intrinsics are never evaluated at check time.
- Where an operation can be written in Onus over a smaller intrinsic, it should be, so that the compiler proves its contract instead of assuming it. The set of intrinsics is enumerated by a fixture and changes to it are reviewed.

## 4. Bindings and mutation

- `let x: T = e` — immutable binding. Required annotation.
- `var x: T = e` — mutable local. Assignment `x = e` re-checks `T`'s refinement.
- A local may not reuse the name of another local or parameter. <!-- changed: M2, docs/CHANGES.md item 32 -->
- A bare expression statement must be a call whose result is `Unit`; a discarded value is an error. <!-- changed: M2, docs/CHANGES.md item 39 -->
- Closures capture by value and cannot capture a `var`.
- There is no reference type, no address-of, and no aliasing of mutable state anywhere in the language.

### 4.1 `inout` parameters

A function that mutates an argument declares it, and the call site marks it:

```
fn set(grid: inout Grid[T, w, h], x: Int where it < w, y: Int where it < h, value: T)
  ensures grid.get(x: x, y: y) == value
  ensures forall px: Int, py: Int where (px, py) != (x, y): grid.get(x: px, y: py) == old(grid).get(x: px, y: py)

set(grid: inout grid, x: 3, y: 4, value: 0)
```

Rules: an `inout` parameter may not be stored, returned, captured, or passed to another `inout` position while still borrowed in the current frame. The same `var` may not be passed `inout` twice in one call. Because nothing aliases, the compiler may mutate in place whenever the previous value is dead; semantics are always value semantics.

`old(x)` in an `ensures` clause refers to the value of an `inout` parameter at entry.

---

## 5. Functions and contracts

```
fn escape_count(cx: Float, cy: Float, limit: Iter) -> Iter
  requires limit > 0
  ensures  result <= limit
{
  ...
}
```

- `requires` — precondition. Obligation at every call site.
- `ensures` — postcondition over `result` and `old(...)`. Obligation at every `return`.
- Arguments are passed by name at every call. Positional calls are a syntax error.
- Functions are values with type `fn(A) -> R ! effects`.

### 5.1 Loops and termination

```
loop while cond
  invariant  i <= limit
  decreases  limit - i
{ ... }

for py: Int in 0 ..< height { ... }
```

`for` over a range is total by construction. `loop while` requires a `decreases` clause (a non-negative integer expression that strictly decreases each iteration) unless the enclosing function declares the `diverge` effect. Recursion follows the same rule: a recursive function must declare `decreases` on a parameter or declare `diverge`.

Loop `invariant` clauses are obligations at entry and at the end of every iteration, and are assumptions after exit.

Recursion: a recursive function declares `decreases` on an expression over its parameters, as a contract clause after `requires`/`ensures` (`decreases n`), checked at every recursive call site. <!-- changed: M3, docs/CHANGES.md item 43 --> Mutual recursion requires the same expression (up to renaming) on every function in the cycle; the compiler computes the cycle and reports `E0320 recursive cycle without shared measure` otherwise.

### 5.3 Quantifiers

Contracts, invariants, laws and properties may use `forall` and `exists`:

```
ensures forall o: Order in result: o.customer == who.id
ensures forall px: Int, py: Int where (px, py) != (x, y): grid.get(x: px, y: py) == old(grid).get(x: px, y: py)
invariant exists i: Int in 0 ..< n: xs.get(i: i) == target
```

The verifier models `List[T]` and `Bytes` as sequences with `len` and `get`, `Grid` as a two-dimensional sequence, `Map[K, V]` as a partial function, and `Text` as opaque except for `len` and equality. Quantification is over a stated domain — a range, a list, or a finite type — so every quantified obligation is bounded and stays in the decidable fragment. A domain of type `Result[List[T], E]` or `Option[List[T]]` ranges over the contained list and the formula is vacuously true for `Err` and `None`, which is how `ensures forall o: Order in result: …` reads a fallible result. <!-- changed: M3, docs/CHANGES.md item 51 --> Quantification over all `Int` without a range is a syntax error in v0. Nested quantifiers are permitted to depth two.

### 5.2 Examples and properties

```
example escape_count {
  escape_count(cx: 0.0, cy: 0.0, limit: 100) == 100
  escape_count(cx: 2.0, cy: 2.0, limit: 100) == 1
}

property escape_bounded(cx: Float, cy: Float, limit: Iter where it > 0) {
  escape_count(cx: cx, cy: cy, limit: limit) <= limit
}
```

`example` blocks are concrete assertions evaluated at check time when every statement is evaluable (pure functions and constant values) — a false assertion is `E0702` — and otherwise by the generated tests; both are shown in the module interface. <!-- changed: M4, docs/CHANGES.md item 56 --> `property` blocks are universally quantified; the compiler attempts to prove them, and where it cannot, runs them under generated inputs (with the refinements as generators) and reports the result as *checked*, never *proved*. Both are part of a function's interface and are read by the reviewer as evidence of intent.

---

## 6. Effects

A function's effects are declared after `!`. Absence means pure.

```
fn main(args: List[Text]) -> Result[Unit, IoError] ! io.file, alloc
```

### 6.1 Primitive effects

The compiler understands these directly:

| Effect | Meaning |
|---|---|
| `alloc` | May allocate on the heap. Absence is proved by the absence of allocating operations: list literals, `++`, closure creation, and calls to allocating functions. Records and variants are values and do not allocate. <!-- changed: M3, item 46 --> |
| `mutate` | May mutate one of its own `inout` parameters, by assignment or by passing it on `inout`. A callee's `mutate` does not propagate through a caller's local `var`. <!-- changed: M3, item 45 --> |
| `panic` | May halt on a runtime contract violation. A function without `panic` must have every obligation *proved*, except integer overflow obligations, which in v0 are runtime checks against the implementation's ±2^53 range and are reported as such in the ledger. <!-- changed: M6, docs/CHANGES.md item 67 --> |
| `diverge` | May fail to terminate. |
| `nondet` | Result depends on something other than its arguments (clock, randomness, scheduling). |
| `io.file`, `io.net`, `io.env`, `io.clock`, `io.rand` | Access to the corresponding resource, via a capability. |

The set is closed. Resource effects such as `sql.read` are declared by a capability's `grants` clause in the module whose name ends in `sql` and are spelled `sql.read` everywhere (§8); any other effect name is an error. Library-defined properties beyond these are claims (§7). <!-- changed: M3, item 44 -->

### 6.2 Composition

A callee's effect set must be a subset of the caller's. This is the only rule, and it is checked structurally.

Higher-order functions are effect-polymorphic; passing a function value to a parameter of type `fn(x: T) -> U ! e` binds `e` to the value's effects beyond those the parameter lists, and a function value never flows into a function-typed position declaring fewer effects than it has: <!-- changed: M3, item 47 -->

```
fn map[T, U, e](xs: List[T], f: fn(x: T) -> U ! e) -> List[U] ! e, alloc
```

### 6.3 Derived effect predicates

Named predicates over the primitive set are definable anywhere and are fully checked: <!-- changed: M1, claims are type names per §2 and the grammar -->

```
claim Pure := effects == {}
claim Total := not diverge and not panic
claim RealtimeSafe := Total and not alloc
```

---

## 7. Claims

A claim is a named property that propagates over the call graph. Claims come in three tiers, distinguished by how their truth is established.

| Tier | Defined by | Checked by | Introduced at |
|---|---|---|---|
| **primitive** | the compiler (§6.1) | the compiler | leaf operations |
| **derived** | a predicate over primitives and other claims | the compiler, by expansion | wherever the predicate holds |
| **asserted** | a name and a description | propagation only | an `assume` leaf |

### 7.1 Asserted claims

```
claim Idempotent
  "Calling twice with the same arguments has the same observable effect as calling once."

fn charge(pay: Payments, req: ChargeRequest) -> Result[Receipt, ChargeError] ! io.net
  claims Idempotent
{
  assume Idempotent "Vendor API deduplicates on req.key for 24h; see contract §4.2"
  ...
}
```

An asserted claim is sound relative to its `assume` leaves and nowhere else. The compiler propagates it exactly as it propagates effects — a function may claim `Idempotent` only if every function it calls that participates in the relevant effect also claims it — but records every `assume` in the ledger with its justification text and location. <!-- changed: M8, docs/CHANGES.md item 76 — v0 participation: a callee participates when it has an observable effect (`io.file`, `io.net`, or a resource effect); `alloc`, `mutate`, `panic`, `diverge`, `nondet`, `io.env`, `io.clock` and `io.rand` are quiet. An `assume` in a function covers everything it calls. A function whose body assumes the claim need not propagate it (`E0204`); `assume` is only for asserted claims the function declares (`E0205`, `E0206`); a declared derived claim whose predicate fails is `E0203`. -->

Claims are namespaced by module. Two modules may define claims with the same short name; they are distinct.

### 7.2 Policy

A `path` (§9) or a module may constrain assumptions:

```
policy no_third_party_assumes
  forbid assume outside { self, std.* }
```

This is how a critical path refuses to depend on a library's word.

---

## 8. Capabilities

A capability is an unforgeable value that both grants access to a resource and carries the claims the resource has been configured to honour. <!-- changed: M1, example rewritten per the tparams grammar; no set-membership expression in v0 -->

```
capability Db[const mode: DbMode]
  grants sql.read when mode == ReadOnly or mode == ReadWrite
  grants sql.write when mode == ReadWrite
```

- Capability types have no public constructor. They are created only by root-level functions in the standard library or by attenuation.
- An effect that names a resource (`sql.read`, `io.file`, ...) is only satisfiable if a capability granting it is in scope as a parameter.
- Capabilities are ordinary parameters. They may not be stored in records or captured by closures; they are threaded explicitly. This is deliberate: the flow of authority is visible in every signature it passes through. <!-- changed: M8, docs/CHANGES.md item 77 — a record field of capability type is `E0601`; closure capture is `E0330`; a union payload (`Result[Db[..], Error]`) is allowed, since that is how constructors return them -->

### 8.1 Construction and the ledger

```
fn main(args: List[Text]) -> Result[Unit, AppError] ! io.env, sql.read, sql.write, alloc {
  let env: Env = io.env.capability()
  let cfg: Config = try config.load(env: env)
  let reporting: Db[ReadOnly] = try sql.connect(net: net, dsn: cfg.reporting_dsn, mode: ReadOnly)
  ...
}
```

`sql.connect` with `mode: ReadOnly` opens the connection with a read-only session (`SET default_transaction_read_only = on` for Postgres; equivalent per driver) and additionally verifies the role's privileges at connect time. The remaining assumption — that the role named in `cfg.reporting_dsn` was not granted write privileges after the check — is recorded in the ledger as an assumed leaf attached to the capability's construction site, so the reviewer's view of any path using `reporting` says where the guarantee bottoms out.

### 8.2 Attenuation

```
let ro: Db[ReadOnly]                = sql.narrow(db: rw, to: ReadOnly)
let orders_ro: Db[ReadOnly, schema: "orders"] = sql.restrict(db: ro, schema: "orders")
let bounded: Db[ReadOnly, deadline: 50ms]     = sql.deadline(db: ro, ms: 50)
```

Attenuation is total and pure apart from `alloc`; it can only remove authority. A function requiring `Db[ReadOnly]` accepts any capability whose mode is `ReadOnly` or stronger-restricted.

### 8.3 The root

Root capabilities are constructed by the runtime, not by code. `main` is the only function that may declare root capability parameters, and it receives exactly the ones it names:

```
pub fn main(args: List[Text], env: io.Env, files: io.Files, net: io.Net) -> Result[Unit, AppError] ! io.env, io.file, io.net, alloc
```

A program whose `main` does not name `io.Net` cannot, anywhere, open a socket — there is no other source of a `Net` capability. The runtime closes every root capability's underlying resources when `main` returns. <!-- changed: M8, docs/CHANGES.md item 77 — a `main` parameter of a non-root capability type is `E0602`, since nothing could supply it --> Library functions that produce capabilities (`sql.connect`) take a root capability as an argument (`net: io.Net`) so the derivation is visible; the `sql` example in §18.2 shows this.

### 8.4 Test doubles

Capabilities are unforgeable, which means ordinary code cannot construct a fake `Db[ReadOnly]` for a test. A module declared `test module` may:

- construct any capability type via `fake` with a caller-supplied behaviour table;
- call `sealed` constructors of any module it imports;
- contain `example` and `property` blocks against non-public functions.

```
test module checkout_tests
import app.checkout

example handle_checkout_empty_basket {
  let db: sql.Db[ReadWrite, schema: "orders"] = fake sql.Db { query: fn(...) { ... }, execute: fn(...) { ... } }
  ...
}
```

The compiler refuses to link a `test module` into a non-test build (`E0600`), and `fake` is a syntax error outside one. A `fake` capability grants the same effects as the real one, so effect checking of the code under test is unchanged; only the resource behind it differs.

---

## 9. Paths

A path declares the guarantees a critical section of the program must satisfy, and the compiler checks them against every function reachable from the entry point.

```
path checkout
  entry   handle_checkout
  effects <= { sql.read, sql.write, io.net, io.clock, alloc }
  require { Total, Idempotent }
  policy  no_third_party_assumes
```

Checking: the compiler computes the reachable set from `entry`. Every function in it must have effects within the declared bound and must carry every required claim. Calls through function values are resolved where the value's provenance is known; where it is not, the path check fails closed with diagnostic `E0410 unresolvable call on path checkout`. <!-- changed: M8, docs/CHANGES.md item 78 — v0 tracks no provenance: every call through a function value, and every interface call dispatched on a type parameter, is `E0410`; interface calls on concrete receivers resolve to the implementation. A function outside the bound is `E0412`, a forbidden effect `E0413`, a missing required claim `E0414`, an `assume` the policy does not permit `E0415`. A required asserted claim is checked on reachable functions with observable effects that are not under an `assume` of it; a required derived claim on every reachable function. -->

Clauses (grammar in §2.3):

- `entry NAME` — the root of the reachable set. Exactly one.
- `effects <= { ... }` — an upper bound on the union of effects of every reachable function.
- `forbid { ... }` — effects that must not appear anywhere reachable. Redundant with `effects <=` but reads better for the reviewer, and the two must be consistent (`E0411`).
- `require { ... }` — claims every reachable function that has any effect must carry. Pure functions are exempt from claims about effects.
- `policy NAME [except { qualified names }]` — applies a policy. `except` lists specific functions whose `assume` leaves are permitted despite the policy; each is reported individually.

### 9.1 The path report

`onus path <name> --json` emits:

```json
{
  "path": "checkout",
  "entry": "app.checkout.handle_checkout",
  "reachable": ["app.checkout.handle_checkout", "app.auth.require", "..."],
  "effects": { "bound": ["sql.read", "sql.write", "io.net", "io.clock", "alloc"], "actual": ["..."] },
  "claims": { "required": ["Idempotent"], "satisfied": true },
  "assumes": [
    { "claim": "Idempotent", "at": "vendor.payments.charge", "justification": "Vendor API deduplicates on req.key for 24h; see contract §4.2", "permitted_by": "except" }
  ],
  "obligations": { "proved": 31, "checked": 2, "assumed": 1,
                   "checked_at": ["std.sql.query#row_refinement", "..."] },
  "unresolvable_calls": [],
  "capabilities": [
    { "type": "sql.Db[ReadWrite, schema: \"orders\"]", "constructed_at": "app.main:17", "assumes": ["role orders_rw privileges unchanged since connect"] }
  ]
}
```

The report is the reviewer's primary artefact for a path. It has a human-readable rendering with the same content; the JSON is normative. <!-- changed: M8, docs/CHANGES.md item 79 — the v0 report also carries `effects.forbid`, `obligations.failed`, `ok`, and `permitted_by` is `"scope"`, `"except"` or null; `unresolvable_calls` entries are `{ at, reason }`; a capability's `assumes` list is empty until construction-site assumptions exist -->

---

## 10. Errors

### 10.1 Expected failure

`Result[T, E]` and `Option[T]` are the only mechanism for expected failure. Error types are unions.

`try e` unwraps a `Result[T, E]`: on `Ok(value: v)` it yields `v`; on `Err(error: x)` it returns from the enclosing function. <!-- changed: M1, arguments are named at every call (§5); Result's fields are value and error --> Two forms:

- `try e` — the enclosing function's return type must be `Result[_, E]` with the *same* `E`. The error is returned as-is.
- `try e else name: expr` — `name` binds the error value; `expr` produces the enclosing function's error type. This is the only conversion mechanism; there is no implicit `From`.

```
let who: auth.AuthedCustomer = try auth.require(...) else e: Unauthorised(detail: e)
```

`Option[T]` supports `try` in a function returning `Option[_]`, and `try ... else name: expr` where `name` is bound to `Unit`.

### 10.2 Panics

A *checked* obligation that fails at runtime panics. Panicking unwinds to the nearest enclosing `recover` block or, absent one, terminates the program with the failed obligation in the exit report.

```
let outcome: Result[Receipt, Panicked] = recover {
  handle_checkout(req: req, clock: clock, db: db, pay: pay, auth: auth)
}
```

Rules:

- `recover { ... }` yields `Result[T, Panicked]` where `T` is the type of the block's final expression; the block may not `return`. `Panicked` carries the obligation's location and counterexample, not a message string. <!-- changed: M2, docs/CHANGES.md item 41 -->
- A `recover` block absorbs the `panic` effect of its contents: the enclosing function need not declare `panic` for what happens inside.
- `inout` parameters are not visible inside `recover` (unwinding would leave them in an unknown state). Capabilities are: a resource is not damaged by a panic in the code using it.
- Every `recover` site appears in the module interface and the path report. A path may declare `forbid { recover }` to require that nothing on it swallows a failed obligation.

This is the request-boundary mechanism for long-running processes: a server loop wraps each request in `recover`, one bad row does not take the process down, and the reviewer can see exactly where that decision was made.

### 10.3 Absent

There is no `throw`, no `catch`, no `finally`, no `defer`. Resource release is by scope (§8.3).

---

## 11. Modules and the interface

```
module reporting
import std.sql
import app.config
```

Module `a.b.c` lives at `a/b/c.onus` under the project root; `std.*` is the standard library and may not be declared elsewhere. Every module implicitly sees the public types and variants of the prelude modules (`Result`, `Option`, `List`, `Grid`, `Map` and the primitives' companions) without importing them; functions are reached as `Type.f` (`List.len`, `Int.to_text`), which names function `f` of the module declaring `Type`. In a dotted name, an import alias takes precedence over a local of the same name. <!-- changed: M2, docs/CHANGES.md items 27–31 -->

A module's **interface** is generated by the compiler and is the artefact a reviewer reads. It contains, for every public item:

- the signature, including effects and claims
- all `requires`, `ensures`, `invariant` and `law` clauses
- all `example` and `property` blocks and their status
- every `assume` in the module, with its justification
- the obligation ledger: each obligation, its location, and whether it was proved, checked, or assumed

Bodies are not in the interface. If an interface is insufficient to trust a module, that is a defect in the module's contracts, not a reason to read the body.

### 11.1 Interface document format

`onus interface <module> --json` is normative; `onus interface <module>` renders it as text in canonical source syntax with bodies elided to `{ ... }`. The JSON shape:

```json
{
  "module": "app.reporting",
  "hash": "b3:4a1e...",
  "imports": ["std.sql", "std.io", "app.config"],
  "items": [
    {
      "kind": "fn", "name": "monthly_totals", "visibility": "pub",
      "signature": "fn monthly_totals(db: sql.Db[ReadOnly, schema: \"orders\"], year: Int where 2000 <= it and it <= 2100) -> Result[List[MonthlyTotal], sql.Error] ! sql.read, alloc",
      "effects": ["sql.read", "alloc"], "claims": [],
      "contracts": [ { "kind": "ensures", "text": "forall t: MonthlyTotal in result: t.total_pence >= 0", "status": "checked", "checked_at": "std.sql.query#row_refinement" } ],
      "examples": [], "properties": [],
      "assumes": [], "recovers": [],
      "obligations": { "proved": 4, "checked": 1, "assumed": 0 }
    }
  ],
  "assumes": [], "recovers": [], "sealed_types": [], "test_module": false
}
```

Every item carries its own obligation counts; the module totals are the sum. Diffing two interface documents is how the compiler enforces the compatibility rule below.

Visibility: items are private unless marked `pub`. Private items may have weaker contracts; public ones may not be weakened once published without a major version change (the compiler diffs interfaces and refuses a compatible-version bump that weakens a contract or widens an effect set).

---

## 12. Verification

### 12.1 Obligations

Every `requires` at a call site, every `ensures` at a return, every refinement at a binding, every `invariant` at loop boundaries, every `decreases`, every index bound, every `law` on an `impl`, and every `property` generates an obligation.

### 12.2 States

| State | Meaning |
|---|---|
| **proved** | Discharged by the verifier from the decidable fragment. No runtime cost. |
| **checked** | Not provable; a runtime check is inserted. Requires the `panic` effect. |
| **assumed** | Introduced by `assume`, or the contract of an intrinsic (§3.12). Recorded, never checked. <!-- changed: M2 --> |

The compiler never silently downgrades. A function may pin an obligation's state (`proved` on a `requires` clause means "fail compilation if this cannot be proved"), and paths may require that no obligation on them is `checked`.

### 12.3 Fragment (**provisional**)

Linear integer arithmetic, equality with uninterpreted functions, algebraic datatypes, and bounded quantification over finite ranges. Nonlinear integer arithmetic is attempted with a fixed low budget and falls back to *checked*. Real arithmetic is excluded by default. <!-- changed: M6, docs/CHANGES.md item 64 — v0 encodes records and unions with uninterpreted projections and tags rather than solver datatypes, and treats Float values as opaque -->

Solver timeouts are hard errors (`E0501 verification budget exceeded`), not silent fallbacks, because a loop that behaves differently on repeated runs is worse than one that fails consistently. Each obligation carries a per-obligation budget; the default is small and may be raised explicitly with `budget` annotations that appear in the interface.

### 12.4 Caching

Obligations are keyed by the content hash of the canonical text of everything they depend on. Re-checking after an edit re-verifies only obligations whose dependency hashes changed. <!-- changed: M6, docs/CHANGES.md item 69 — v0 keys the cache by the solver problem text, the solver version and the budget, which is a function of the same dependencies -->

---

## 13. Diagnostics protocol

`onus check --json` emits a stream of diagnostic objects. There are no warnings; every diagnostic is an error, and the compiler reports all of them, not the first.

```json
{
  "code": "E0302",
  "title": "postcondition not established",
  "location": { "file": "mandelbrot.onus", "def": "escape_count", "span": [[14, 3], [14, 11]] },
  "obligation": {
    "kind": "ensures",
    "text": "result <= limit",
    "status": "unprovable",
    "counterexample": { "limit": 1, "i": 2 }
  },
  "context": [
    "invariant i <= limit is not maintained: i is incremented after the loop condition is checked"
  ],
  "repairs": [
    { "kind": "replace", "span": [[9, 14], [9, 23]], "with": "i < limit", "confidence": "high" },
    { "kind": "insert", "after": [[10, 0]], "text": "  invariant i <= limit", "confidence": "medium" }
  ],
  "canonical_hash": "b3:9f2c..."
}
```

Required fields for every diagnostic: a stable `code`, the innermost `def`, a `span`, the violated `obligation` where applicable, a machine-checkable `counterexample` when the solver produced one, and zero or more `repairs` that are syntactically valid and, when applied, produce canonical source. The full code catalogue is part of the language specification and is versioned with it.

---

## 14. Constrained decoding interface

`onus next --at <file>:<offset>` returns the set of legal next tokens at a position, computed from the LL(1) parse state and — where the position is in an expression — from the type checker's expected type, so that a decoder can mask logits at each step. The interface is streaming and incremental; the compiler keeps the parse and type state for a file resident between calls.

Type-constrained masking is exact for expected types and best-effort for refinements (the decoder is allowed to emit a value that later fails a refinement obligation, which the diagnostic loop then catches).

---

## 15. The review tool

Onus assumes the developer is reviewing, not editing. The review tool is the surface for that work. It has one design rule: **it computes nothing**. Every view is a rendering of compiler output — interface documents (§11.1), path reports (§9.1), diagnostics (§13) — so there is no second analysis that can disagree with the language. Its outputs are decisions (approve, reject, request change) and contract edits, which return to the model as tasks.

### 15.1 Views

**Path view.** The reachable graph from a `path` entry, laid out top-down as authority flows: root capabilities enter at `main`, attenuate at each narrowing, and terminate at resources. Edges carry effects; nodes carry claims and obligation counts. `assume` leaves and `recover` sites are the only elements rendered in colour. An unresolvable call is drawn as a break in the graph.

**Interface view.** A module as its signatures, contracts, examples and properties, with obligation status inline: proved is unmarked, checked is marked with the runtime check's location, assumed with its justification. Bodies are collapsed to `{ ... }`. Expanding one is permitted and counted; body-open rate per module is reported, because a module whose bodies must be read has contracts that are not doing their job.

**Ledger view.** Every obligation across a module or path, filterable by state, plus every `assume`, every `recover`, and every capability construction site with the configuration it depends on. This answers "what am I actually trusting."

**Diff view.** Two interface documents compared. Source diffs are not shown. What is shown: added or removed items, changed signatures, widened effect sets, weakened `requires`/strengthened `ensures` (compatible) versus the reverse (breaking), new assumptions, new `recover` sites, obligations whose state moved between proved, checked and assumed. This is the pull-request page.

**Counterexample view.** A failed obligation with the solver's model rendered as concrete values against the contract text, and the path condition that led there. Its purpose is the one judgement that needs a human: whether the contract is wrong or the body is.

**Promotion.** When a reviewer identifies a convention the code follows but nothing enforces, the tool drafts the enforcing declaration — a `sealed` type, a derived claim, a `path` clause, a `policy` — and files it as a change. This is the mechanism by which the underspecified remainder (§17) shrinks over time.

### 15.2 What it does not do

- Edit bodies. Body changes are model work, requested through the tool as tasks with the failing obligation attached.
- Run anything. Examples and properties are evaluated by the compiler; the tool shows results.
- Offer opinions. No lint, no style, no suggestions beyond promotion drafts, which are always derived from something the reviewer pointed at.

---

## 16. Standard library (**provisional**)

Small, fully contracted, every function accompanied by examples. It is the corpus a model learns idioms from, so every function is also a worked example. v0 scope: `Int`, `Float`, `Text`, `List`, `Map`, `Option`, `Result`, `Grid`, `io.*` capabilities, `sql` (connect, narrow, restrict, deadline, query, execute), `config`.

---

## 17. Open questions

Recorded rather than resolved.

1. **Concurrency.** Structured concurrency over immutable inputs with channels by value is the obvious fit; cancellation and deadlock have no proposed mechanism.
2. **Trace properties on paths.** "Auth before any `sql.read`" is expressible by typestate (see §18.3) for most cases. Genuine ordering properties over traces need a model checker or temporal claims; deferred.
3. **FFI.** Anything beyond `assume` at the boundary — marshalling, foreign effects, resource lifetimes — is unspecified.
4. **Float verification.** Whether to pursue real-arithmetic proving at all, or commit to runtime checks for floats permanently.
5. **Interface evolution.** The contract-weakening rule in §11 is stated; the mechanism for deprecation and migration is not.
6. **Grammar.** §2.3 is a first EBNF and has not been run through a parser generator. The LL(1) claim is unverified.
7. **Ownership escalation.** If arenas-and-indices prove insufficient for graph-shaped data, a linear ownership system is the fallback; not designed.
8. **Nested patterns and deeper quantifiers.** Both capped in v0 (§3.9, §5.3) for decidability and grammar simplicity. Lift when a real program needs them.
9. **Units of measure.** F#-style phantom units on numeric types. Fits the type system without touching the verifier; deferred to keep v0 small.
10. **The underspecified remainder.** Conventions inferred from a codebase ("like the existing handlers") stay in prose and review until someone promotes them to a claim or path rule. The language should make that promotion cheap; how is not yet designed.

---

## 18. Worked examples

### 18.1 Mandelbrot

<!-- changed: M1, the code below is examples/mandelbrot/… in canonical form: named arguments, single-line literals, layout -->

Demonstrates: refinements, dependent records, contracts, loop invariants and termination, indexed types, examples and properties, the effect boundary.

```
module mandelbrot
import std.io

type Iter = Int where 0 <= it and it <= 10000

type Coord = Int where 0 <= it

record Viewport {
  x_min: Float
  x_max: Float where it > x_min
  y_min: Float
  y_max: Float where it > y_min
}

pub fn escape_count(cx: Float, cy: Float, limit: Iter) -> Iter
  requires limit > 0
  ensures result <= limit
{
  var zx: Float = 0.0
  var zy: Float = 0.0
  var i: Iter = 0
  loop while i < limit and zx * zx + zy * zy <= 4.0
    invariant i <= limit
    decreases limit - i
  {
    let nx: Float = zx * zx - zy * zy + cx
    zy = 2.0 * zx * zy + cy
    zx = nx
    i = i + 1
  }
  return i
}

example escape_count {
  escape_count(cx: 0.0, cy: 0.0, limit: 100) == 100
  escape_count(cx: 2.0, cy: 2.0, limit: 100) == 1
}

property escape_bounded(cx: Float, cy: Float, limit: Iter where it > 0) {
  escape_count(cx: cx, cy: cy, limit: limit) <= limit
}

pub fn render(
  view: Viewport,
  width: Coord where it > 0,
  height: Coord where it > 0,
  limit: Iter where it > 0
) -> Grid[Iter, width, height] ! alloc {
  var grid: Grid[Iter, width, height] = Grid.filled(value: 0, width: width, height: height)
  for py: Int in 0 ..< height {
    for px: Int in 0 ..< width {
      let cx: Float = view.x_min + (view.x_max - view.x_min) * Float.of(x: px) / Float.of(x: width)
      let cy: Float = view.y_min + (view.y_max - view.y_min) * Float.of(x: py) / Float.of(x: height)
      Grid.set(grid: inout grid, x: px, y: py, value: escape_count(cx: cx, cy: cy, limit: limit))
    }
  }
  return grid
}

pub fn main(args: List[Text], files: io.Files) -> Result[Unit, io.Error] ! io.file, alloc {
  -- files is a root capability supplied by the runtime (§8.3)
  let view: Viewport = Viewport { x_min: -2.5, x_max: 1.0, y_min: -1.0, y_max: 1.0 }
  let grid: Grid[Iter, 800, 600] = render(view: view, width: 800, height: 600, limit: 255)
  let out: io.File = try io.create(files: files, path: "mandelbrot.pgm")
  try io.write(file: out, text: "P2\n800 600\n255\n")
  for py: Int in 0 ..< 600 {
    for px: Int in 0 ..< 800 {
      try io.write(file: out, text: Int.to_text(x: Grid.get(grid: grid, x: px, y: py)) ++ " ")
    }
    try io.write(file: out, text: "\n")
  }
  return Ok(value: Unit)
}
```

**Ledger, abridged.** `escape_count.ensures result <= limit`: proved from the invariant. `render` index bounds on `Grid.set`: proved from the `for` ranges against the grid's indices. The `Viewport` refinements at construction in `main`: proved (constants). The loop condition `zx*zx + zy*zy <= 4.0` is a `Float` expression and generates no obligation; it is simply evaluated. `Int.to_text` and `Float.of` are total. No obligation is *checked*, so no function needs `panic`.

### 18.2 Monthly report (SQL)

<!-- changed: M1, the code below is examples/reporting/… in canonical form: named arguments, single-line literals, layout -->

Demonstrates: capabilities, construction from configuration, attenuation, the assumed leaf at the root, a path that forbids writes.

```
module reporting
import std.sql
import std.io
import app.config

record MonthlyTotal {
  month: Text
  total_pence: Int where it >= 0
}

union AppError =
  | Config of detail: config.Error
  | Storage of detail: sql.Error
  | Io of detail: io.Error

pub fn monthly_totals(
  db: sql.Db[ReadOnly, schema: "orders"],
  year: Int where 2000 <= it and it <= 2100
) -> Result[List[MonthlyTotal], sql.Error] ! sql.read, alloc
  ensures forall t: MonthlyTotal in result: t.total_pence >= 0
{
  -- text is a const parameter (§3.8.1): std.sql's own parse_select runs at check time and rejects anything but a single SELECT.
  let stmt: sql.Select[MonthlyTotal] = sql.select[
    text: "select to_char(created, 'YYYY-MM') as month, sum(amount_pence) as total_pence from orders where extract(year from created) = $1 group by 1 order by 1"
  ](params: [sql.int(x: year)], row: MonthlyTotal)
  return sql.query(db: db, statement: stmt)
}

-- Root capabilities are supplied by the runtime to main and nowhere else (§8.3).
pub fn main(
  args: List[Text],
  env: io.Env,
  files: io.Files,
  net: io.Net
) -> Result[Unit, AppError] ! io.env, io.file, io.net, sql.read, alloc {
  let cfg: config.Config = try config.load(env: env) else e: Config(detail: e)
  let reporting: sql.Db[ReadOnly] = try sql.connect(
    net: net,
    dsn: cfg.reporting_dsn,
    mode: ReadOnly
  ) else e: Storage(detail: e)
  let orders: sql.Db[ReadOnly, schema: "orders"] = sql.restrict(db: reporting, schema: "orders")
  let rows: List[MonthlyTotal] = try monthly_totals(db: orders, year: 2026)
    else e: Storage(detail: e)
  let out: io.File = try io.create(files: files, path: "report.csv") else e: Io(detail: e)
  for row: MonthlyTotal in rows {
    try io.write(file: out, text: row.month ++ "," ++ Int.to_text(x: row.total_pence) ++ "\n")
      else e: Io(detail: e)
  }
  return Ok(value: Unit)
}

path monthly_report
  entry monthly_totals
  effects <= { sql.read, alloc }
  forbid { sql.write, io.net, io.file }
```

**What the compiler establishes.** `sql.select` takes its statement as a `const` parameter and requires `sql.parse_select` — a `const fn` shipped by the library, not a compiler feature — to accept it as a single `SELECT`, so `Select[T]` cannot carry a write. The same `const fn` projects the column list and checks it against `MonthlyTotal`'s fields, so a typo in a column name is a compile error at the character in the string. `sql.query` requires a `Db[ReadOnly, ...]` and therefore satisfies `sql.read` only. The path check confirms nothing reachable from `monthly_totals` can write or perform other IO. The `ensures` on `monthly_totals` is *checked*, not proved: it depends on database contents, and the library inserts a row-level refinement check when decoding `MonthlyTotal` (`total_pence: Int where it >= 0`), so `monthly_totals` must declare `panic` or — as written — the library's decode returns `sql.Error.Refinement` instead, keeping the function panic-free.

**Ledger, the interesting entry.** `sql.read` on path `monthly_report` rests on one assumption, at `main`, line 18: *the role in `cfg.reporting_dsn` is read-only.* `sql.connect(mode: ReadOnly)` sets the session read-only and verifies the role's privileges at connect time; what remains assumed is that the privileges are not changed afterwards. The reviewer reads that one line and knows where the guarantee ends.

### 18.3 Checkout endpoint

<!-- changed: M1, the code below is examples/checkout/… in canonical form: named arguments, single-line literals, layout -->
<!-- changed: M8, docs/CHANGES.md item 80 — `Idempotent` is declared in `app.contracts` (imported by checkout, app.auth and vendor.payments), `auth.require` claims it, and `load_basket` claims it with an `assume` that a select reads only; the path passes with three assumptions, of which exactly one is external -->

Demonstrates: typestate for ordering ("auth before data"), asserted claims and their `assume` leaves, a path with a policy, `Result` error composition.

```
module checkout
import std.sql
import std.io
import app.auth
import vendor.payments

-- auth.AuthedCustomer is `pub sealed` (§3.10): readable anywhere, constructible only inside app.auth.
-- The only producer is auth.require, so any function demanding one is callable only after a successful auth check.
pub fn recent_orders(
  db: sql.Db[ReadOnly, schema: "orders"],
  who: auth.AuthedCustomer
) -> Result[List[Order], sql.Error] ! sql.read, alloc
  ensures forall o: Order in result: o.customer == who.id
{
  let stmt: sql.Select[Order] = sql.select[
    text: "select * from orders where customer_id = $1 order by created desc limit 50"
  ](params: [sql.text(x: who.id)], row: Order)
  return sql.query(db: db, statement: stmt)
}

union CheckoutError =
  | Unauthorised of detail: auth.Error
  | Storage of detail: sql.Error
  | Payment of detail: payments.Error
  | Empty

pub fn handle_checkout(
  req: Request,
  clock: io.Clock,
  db: sql.Db[ReadWrite, schema: "orders"],
  pay: payments.Client,
  auth: auth.Service
) -> Result[Receipt, CheckoutError] ! sql.read, sql.write, io.net, io.clock, alloc
  claims Idempotent
{
  let who: auth.AuthedCustomer = try auth.require(
    service: auth,
    caller: req.caller,
    customer: req.customer,
    clock: clock
  ) else e: Unauthorised(detail: e)
  let basket: Basket = try load_basket(db: sql.narrow(db: db, to: ReadOnly), who: who)
    else e: Storage(detail: e)
  if List.is_empty(xs: basket.items) {
    return Err(error: Empty)
  }
  let receipt: Receipt = try payments.charge(
    client: pay,
    key: req.idempotency_key,
    amount: basket.total,
    who: who
  ) else e: Payment(detail: e)
  try record_order(db: db, who: who, basket: basket, receipt: receipt) else e: Storage(detail: e)
  return Ok(value: receipt)
}

path checkout
  entry handle_checkout
  effects <= { sql.read, sql.write, io.net, io.clock, alloc }
  require { Idempotent }
  policy no_third_party_assumes except { vendor.payments.charge }
```

**Ordering without a trace property.** `recent_orders`, `load_basket` and `record_order` all take an `auth.AuthedCustomer`. That type is produced only by `auth.require`, so the compiler cannot type a call to any of them before a successful auth check has run. "Auth before data" is not a rule anyone has to remember; it is not expressible otherwise.

**The asserted claim.** `handle_checkout` claims `Idempotent`. Propagation requires every effectful callee to claim it too. `record_order` claims it by construction (an `insert ... on conflict (receipt_id) do nothing`, which the library treats as a derived claim over the statement). `payments.charge` claims it with an `assume` whose justification cites the vendor's contract. The path's policy forbids third-party assumptions except that one, named explicitly — so the reviewer sees exactly one external claim they are trusting on this path, and where it is written down.

**Panics.** `sql.query` declares `panic` for row refinement failures. `handle_checkout` does not: the library converts them to `sql.Error.Refinement` before they reach it. The HTTP server loop that calls `handle_checkout` wraps each request in `recover` (§10.2), and that site is listed in the path report; the path itself declares nothing about `recover`, so a reviewer who wants a stricter guarantee adds `forbid { recover }` and sees it fail on the server loop.

**What the ledger says.** Reachable functions: 9. Aggregate effects within bound. Obligations: 31 proved, 2 checked (both `Int` refinements on decoded rows, inside `sql.query`, which declares `panic` — surfaced as `sql.Error.Refinement` instead), 1 assumed (`vendor.payments.charge: Idempotent`). The `ensures` on `recent_orders` is proved from the statement's `where` clause: `parse_select` returns a `Spec` for it (§3.8.1), and `sql.query`'s postcondition states that every returned row satisfies that spec.

---

*End of v0.*
