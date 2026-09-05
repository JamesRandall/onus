# Spec changes

Changes to `onus-spec-v0.md` forced by implementation, by milestone. Each is
marked in the spec with `<!-- changed: reason -->` and pinned by a fixture.
Changes the spec author makes are logged in `CHANGE-LOG.md` and its sequels, dated, with
what the codebase must do about each; this file records only what
implementation forced.

## M1 — front end

### Grammar (§2.3)

The provisional EBNF was made LL(1) and brought into line with the spec's
own examples. The grammar as implemented is `grammar-v0.md`. Differences:

1. **Continuation newlines.** A newline is not significant before `->`,
   `else`, `{`, `claims`, `requires`, `ensures`, `invariant` or `decreases`.
   The EBNF placed `NL` tokens inside `fn_decl`, `iface_item` and `loop` in
   ways that did not tokenise consistently (e.g. a signature followed by
   contracts needed two consecutive newlines). Fixtures: `roundtrip/messy/continuations`.
2. **Single-line blocks.** `block` accepts `{ stmt }` on one line (the §18.3
   example writes `if ... { return Err(Empty) }`); the canonical form is
   always multi-line. Fixture: `roundtrip/messy/single_line_block`.
3. **`inout` position.** `param = NAME ":" ["inout"] type`, matching §4.1's
   `grid: inout Grid[T, w, h]` and the call-site form `grid: inout grid`, which
   is now also in the grammar (`call_args`). The EBNF had `inout` before the name.
   Fixtures: `roundtrip/14_fn_signatures`, `roundtrip/23_expr_postfix`.
4. **Labelled and explicit type arguments.** `targ = [NAME ":"] (type | expr)`
   for `Db[ReadOnly, schema: "orders"]` (§8.2), and a call may carry explicit
   `[...]` arguments for `sql.select[text: "..."](...)` (§18.2).
   Fixtures: `roundtrip/23_expr_postfix`, `roundtrip/34_types`.
5. **Ranges.** `a ..< b` is a domain form of `for` and of quantifier `in`
   clauses (§5.1, §5.3), not an expression. Fixtures: `roundtrip/19_for`, `27_quantifiers`.
6. **`implies` and `is`.** `implies` is the lowest-precedence, non-associative
   operator (§3.6 laws); `x is Pattern` sits at comparison level (§3.8.1).
   Chaining `implies` is `E0011`. Fixtures: `roundtrip/22_expr_logic`, `syntax/e0011`.
7. **Claim predicates.** A derived claim's body is the small effect-predicate
   language of §6.3 (`effects == { ... }`, effects, claims, `and`/`or`/`not`),
   not a general expression. Fixture: `roundtrip/09_claims`.
8. **Policy scopes.** `outside { self, std.* }` is `scope = "self" | QNAME [".*"]`.
   Fixture: `roundtrip/12_policy`.
9. **Test modules and `fake`.** `["test"] "module"` and the
   `fake QTNAME { ... }` primary of §8.4 are in the grammar; `fake` outside a
   test module is `E0012`. Fixtures: `roundtrip/31_test_module_fake`, `syntax/e0012`.
10. **`recover` as an effect name** in effect sets, for `forbid { recover }`
    (§10.2). Fixture: `roundtrip/11_path`.
11. **Effect lists inside parameter lists.** `fn(T) -> U ! e, xs: List[T]` is
    ambiguous; a comma followed by `NAME ":"` ends the effect list, and effect
    names are lowercase (`QNAME`), never claims. Fixture: `roundtrip/34_types`.
12. **Quantifier binder types** have no `where` clause of their own; `where`
    after the binder belongs to the quantifier (§5.3).
13. **Mixed `and`/`or`** (`E0007`) and chained comparisons (`E0006`) are parse
    errors as §2.1 requires. Fixtures: `syntax/e0006`, `syntax/e0007`.
14. **`E0002`** (bare expression statement is not a call) is checked by the
    parser; `example`, `property` and `law` blocks are exempt because their
    bare expressions are assertions (§5.2). Fixture: `syntax/e0002`.
15. **Soft keywords.** The spec's examples use `of`, `require` and `path` as
    names (`Float.of`, `auth.require`, `path: "..."`). Item and clause
    keywords that cannot occur inside an expression are therefore reserved
    only where an item or clause can begin. Listed in `grammar-v0.md`.
16. **Parentheses are not AST nodes**; the printer emits the minimal set.
    `and`/`or` are n-ary nodes. Fixture: `roundtrip/messy/parens`.

### Lexical (§2, §3.1)

17. **Text literals are single-line.** A raw newline in a text literal is
    `E0004`; use `\n`. The §18.2 SQL literal is rewritten on one line. This
    keeps one canonical spelling per string value. Fixture: `syntax/e0004`.
18. **Comments are preserved** by the canonical printer (attached to the
    line-level construct they precede or follow) and excluded from hashes.
    Fixture: `roundtrip/29_comments`.
19. **Literal normalisation** in canonical form: `_` separators dropped,
    durations in the largest exact unit, floats in shortest form.
    Fixture: `roundtrip/messy/literals`.

### Canonical form (§2.2)

20. The layout rules are stated precisely in `grammar-v0.md` ("Canonical
    form"). Notably: bracketed lists break one element per line at 100
    columns, `else if` canonicalises to a nested block (as §2.3 already said),
    and blank lines inside blocks are removed.

### Named arguments (§5, §10.1, §18)

21. `Ok(x)` / `Err(e)` in the prose and examples contradicted "arguments are
    passed by name at every call" and the `call_args` grammar. The examples
    now write `Ok(value: x)` and `Err(error: e)`; `Result`'s fields are
    `value` and `error`. Fixtures: the three worked examples.

### Claims are type names (§6.3, §9, §18.3)

22. §2 and the grammar make claims `TNAME`s; the §6.3 examples used
    lowercase (`pure`, `total`). The examples now read `Pure`, `Total`,
    `RealtimeSafe`, and `require { Total, Idempotent }`.

### Capabilities (§8)

23. `capability Db[mode: DbMode]` is written `capability Db[const mode: DbMode]`
    per the `tparams` grammar, and `mode in { ReadOnly, ReadWrite }` is
    written `mode == ReadOnly or mode == ReadWrite` (there is no set-membership
    expression in v0). Fixture: `roundtrip/10_capability`.

### Diagnostics (§13)

24. `location.def` is `null` for a diagnostic outside any definition (e.g. a
    malformed module header).

## M2 — resolve and types

25. **Intrinsics (§3.12, new).** `intrinsic fn` (no body) and `intrinsic type`
    declare runtime-provided primitives, legal only under `module std.…`
    (`E0102` elsewhere). Their contracts and effects are *assumed*
    obligations in the ledger (§12.2 extended). Chosen over a hardcoded
    primitive table (contracts would live outside Onus) and over a general
    `extern` (the FFI §17 defers). Fixtures: `roundtrip/35_intrinsic`,
    `syntax/e0102`, `syntax/e0003_intrinsic_with_body`.
26. **Function types carry parameter names (§3.7).** `fn(x: T) -> U` rather
    than `fn(T) -> U`: calls are named, so a call through a function value
    needs labels. A closure assigned to a function type may use its own
    parameter names. Fixtures: `roundtrip/03_type_alias`, `28_closures`, `34_types`.

### Modules and resolution (§11, §3.4, §3.6, §3.10)

27. **Module files.** `a.b.c` lives at `<root>/a/b/c.onus`; `std.*` lives under
    the standard library root and no other file may declare a `std.*` name
    (`E0112`). A file declaring a name other than its path is `E0104`; an
    import that finds no file is `E0103`. The root is `--root` or is inferred
    from the entry file and its module name. Fixtures: `checker/e0103`, `e0104`, `e0112`.
28. **Prelude.** Every module implicitly sees the public types and variants
    (not the functions) of `std.results`, `std.option`, `std.list`, `std.grid`,
    `std.map`, `std.int`, `std.float`, `std.text`, `std.bool`, `std.bytes` and
    `std.duration`. These implicit imports are type-only and are not edges
    for cycle detection. The `Result` module is `std.results` because
    `result` is a keyword.
29. **Companion functions.** `T.f` denotes function `f` of the module that
    declares `T`; for a primitive, that module is `std.<lowercase name>`
    (`Int.to_text` → `std.int.to_text`). Functions are never in scope
    unqualified across modules.
30. **Variant scope.** A bare variant resolves in this module's unions, then
    the prelude's, then the imports' public unions; more than one candidate is
    `E0108` and must be qualified with the module alias. Two unions in one
    module may not share a variant name (`E0107`), since there is no
    `Union.Variant` syntax.
31. **Module aliases win in dotted names.** `auth.require(...)` denotes the
    module even when a parameter `auth` is in scope (§18.3 relies on this); a
    bare `auth` is the parameter. Aliases live in their own namespace.
32. **No shadowing.** A local may not reuse the name of another local or
    parameter (`E0113`). Module-level functions and constants may be
    shadowed, because parameters are the labels callers read and the spec's
    own API pairs `select(..., statement:)` with `sql.statement`. Fixture: `checker/e0113`.
33. **Examples and properties** share a namespace separate from functions, so
    `example escape_count` may accompany `fn escape_count` (§18.1); paths and
    policies likewise.
34. **`Unit`** is a built-in value; `TypeInfo` and `Spec` are nameable types.
35. **Interface dispatch** is written `Ord.compare(a: x, b: y)`: the
    interface's type parameter is instantiated from the arguments (or an
    explicit argument) and an `impl` must exist (`E0333`) unless the type is a
    parameter bounded by that interface. Inside an interface or impl its
    functions are in scope bare. Fixture: `checker/e0333`.

### Typing (§3, §4, §5, §10)

36. **Generic instantiation** takes type arguments from an explicit `[...]`,
    then from the expected type in checking position, then from the
    arguments; an unbound parameter is `E0324`. This is instantiation, not
    inference onto declarations. Fixture: `checker/ok_types`, `e0324`.
37. **Type indices** (`Grid[T, width, height]`) must be literals, `const`s or
    parameters; at a call whose result type uses a parameter as an index, the
    argument must be such an expression (`E0337`). Fixture: `checker/e0337`.
38. **Capability restrictions.** Labelled arguments beyond a capability's
    declared parameters (`schema: "orders"`) are restrictions; a capability
    with more restrictions is accepted where one with fewer is required
    (§8.2). This is the one subtyping rule beyond refinement subsumption in
    impl spec §3.3.
39. **Expression statements** must have type `Unit` (`E0339`): a discarded
    `Result` is never silent. `example`, `property` and `law` bodies are
    assertions and must be `Bool`.
40. **Unreachable code** is an error, not a warning: a statement after a
    `return` on every path (`E0332`) and a `match` arm no value can reach
    (`E0327`). Fixtures: `checker/e0332`, `e0326_e0327_match`.
41. **`recover`** blocks yield the value of their final expression statement
    and may not `return`; `Panicked` is a record in `std.results`.
42. **Closures** may not capture capabilities (`E0330`), in addition to `var`s
    and `inout` parameters (§3.7). Fixture: `checker/e0330_capture_capability`.

## M3 — effects

43. **Function-level `decreases` (§5.1).** Recursion needs a measure but the
    grammar only had `decreases` as a loop clause; it is now also a contract
    clause of a function (`decreases n` after `requires`/`ensures`). A
    recursive cycle whose functions lack one and do not declare `diverge` is
    `E0320`. Fixtures: `roundtrip/14_fn_signatures`, `checker/e0320`.
44. **Resource effects are declared by `grants` (§6.1, §8).** `sql.read` is
    the effect `read` of module `sql`, declared by a capability in that
    module granting `sql.read`; it is spelled the same everywhere and is
    reachable only where that module is imported. Any other effect name is
    `E0202`. The primitive set stays closed.
45. **`mutate` is about the caller's own parameters (§6.1).** A function
    needs `mutate` iff it assigns to or passes on one of its `inout`
    parameters; a callee's `mutate` does not propagate through a local
    `var` (Mandelbrot's `render` calls `Grid.set` with `may alloc` only).
46. **What allocates (§6.1).** List literals, `++` and closure creation are
    `alloc`; records and variants are values and are not. A `loop while`
    without `decreases` is `diverge`. `recover` absorbs `panic`.
47. **Effect polymorphism (§6.2).** Passing a function value to a parameter of
    type `fn(...) -> U ! e` binds `e` to the value's effects beyond those
    the parameter lists; the call contributes the callee's effects with `e`
    substituted. A function value may not flow into a function-typed
    position (binding, argument, return) declaring fewer effects (`E0201`).
    Fixtures: `checker/ok_effects`, `e0201_fn_value_flow`.
48. **Purity of contracts.** A `const fn` declares no effects; `requires`,
    `ensures`, `decreases` and `where` clauses may allocate and nothing else.
49. **Impl effects (§3.6).** An impl function declaring effects beyond the
    interface's is `E0334`. Fixture: `checker/e0334_impl_effects`.
50. **Examples completed (§18.2, §18.3).** The reporting and checkout examples
    referenced modules and functions the spec did not show; `app.config`,
    `app.auth`, `vendor.payments`, `Request`, `Order`, `Basket`,
    `load_basket`, `record_order` and the `no_third_party_assumes` policy are
    now in `examples/`, and `Receipt` is `payments.Receipt`.

51. **Contract conveniences (§3.9, §5.3).** A bare variant in a pattern
    (`result is Ok`, `| Ok ->`) matches any payload, like `Ok(..)`; and a
    quantifier whose domain has type `Result[List[T], E]` or `Option[List[T]]`
    ranges over the contained list and is vacuously true for `Err`/`None`.
    Both appear in the spec's own examples (§3.8.1, §18.2, §18.3).

## M4 — const evaluator

52. **`const fn` may allocate (§3.8.1).** The spec's own `parse_select`
    returns an AST, which allocates; a `const fn` therefore declares at most
    `alloc` (M3 item 48 narrowed). Its signature in §3.8.1 gains `may alloc`.
53. **`ConstError` and `TypeInfo` in the library (§3.8.1).** `ConstError` is
    the record `std.check.ConstError { offset, message }` (prelude);
    `offset` indexes the graphemes of the constant text. A `const fn` reads
    a type through `std.typeinfo` (`TypeInfo.name`, `TypeInfo.fields`), whose
    intrinsics exist only at check time. `Spec` values wait for the verifier.
54. **When check-time checks run.** At a call whose arguments are all
    constant, the callee's `requires proved` clauses are evaluated; false is
    `E0700`, located at the offending grapheme of the literal passed for the
    callee's first `const` Text parameter when a `ConstError` was produced.
    Clauses with runtime arguments are left to the verifier. `select` no
    longer needs `.ok`: `columns_match` takes the text and the row type.
55. **Check-time failures.** A contract failing or an intrinsic panicking
    during evaluation is `E0701`; a `const` that is not evaluable is `E0701`;
    exceeding the step budget is `E0501`, naming the function.
56. **Examples at check time (§5.2).** An `example` whose statements are all
    evaluable (pure functions, constant values) runs at check time and a
    false assertion is `E0702`; one that needs the runtime is deferred to the
    generated tests of milestone 5.

## M5 — codegen, everything checked

57. **Obligations are objects (impl spec §3.5).** The contracts pass creates
    one per site of §12.1 with status `checked`, except `requires proved`
    clauses the const evaluator discharged (`proved`). Codegen inserts a
    runtime check iff `checked`.
58. **Where checks live.** A callee checks its own non-pinned `requires` and
    parameter refinements on entry, on behalf of every call site; call-site
    refinement obligations stay in the ledger but emit no second check.
    `ensures`, the return type's refinement, `let`/`var`/assignment flows,
    record and variant field refinements, loop invariants and `decreases`
    are checked at their sites. Int and Duration `+ - * / %` go through
    checked runtime arithmetic (`overflow`).
59. **`inout` convention (impl spec §6).** A function with `inout` parameters
    returns `[result, ...parameters]` and the caller reassigns its variables;
    intrinsics follow the same convention (`Grid.set`). Intrinsic shims pass
    `const` type parameters first, then parameters, positionally.
60. **`try` unwinds with an exception** (`EarlyReturn`) caught by the
    enclosing function, instead of the impl spec's `if (r.tag === 'Err')
    return r;`, so that a `try` nested inside a larger expression keeps
    evaluation order. `match` is a labelled block of pattern tests in arm
    order, which is how guards fall through.
61. **Generics and interfaces.** Type parameters are erased; a bounded
    parameter `T: I` becomes a hidden dictionary argument and `I.f(...)`
    dispatches through it; impl functions are emitted as `I$Type$f` and each
    impl exports its dictionary `I$Type`.
62. **Tests and `main`.** Every `example`, `property` and `law` becomes a
    vitest case in `<module>.examples.test.js` (properties and laws under
    fast-check generators derived from parameter types and filtered by their
    refinements). `onus run` emits a launcher that constructs the root
    capabilities `main` names (§8.3) and maps `Ok`/`Err`/`Panic` to exit
    codes 0/1/2. `std.sql` at runtime has no driver in v0: `connect` returns
    `Err(Connection)`.

63. **Function values are positional at runtime.** A closure takes its
    parameters positionally, a call through a function value passes the
    arguments in the type's parameter order, and a declared function used as
    a value is wrapped in an adapter to its named-argument form. This is
    what lets a closure use its own parameter names against a function type
    (§3.7, item 26) without a runtime mismatch; the `tsc --strict` oracle
    caught the original defect.

## M6 — verification

64. **Lowering (impl spec §7.1).** Records and unions are not SMT datatypes:
    field access is an uninterpreted projection per type instantiation, a
    variant test compares an uninterpreted integer tag, lists have
    uninterpreted `len`/`get`, `Text` is an opaque sort whose literals are
    pairwise distinct, and every call is an uninterpreted function per
    instantiation (a fresh constant when effectful) with the callee's
    `ensures` and return refinement asserted about the result. A value's
    declared refinements are facts, recursively through record fields, union
    payloads and list elements. Floats are opaque values; a float operation
    makes only the operand it appears in unknown.
65. **Path knowledge (§3.2.1).** A body is walked once with fresh SMT
    constants per `var` assignment; `if` conditions, `match` arms (with the
    failure of earlier arms), loop conditions and invariants inside loops,
    their negation and the invariants after exit, `for` ranges and list
    membership, and `try` success are facts. Loops and branch joins forget
    the variables they assign. An early-returning branch leaves its negated
    condition in force afterwards.
66. **Constant discharge.** An obligation without a solver condition whose
    predicate and inputs are constants (the `Viewport` literal of §18.1) is
    decided by evaluation; this is how float refinements over constants are
    proved.
67. **Statuses and codes.** `unsat` → proved; `sat` → checked, or for a pinned
    clause `failed` with the model as counterexample (`E0302` ensures,
    `E0342` requires); `unknown`/timeout → checked for unpinned nonlinear
    obligations, otherwise `E0501`. The panic rule of §6.1 is `E0343`
    (a checked obligation in a function without `panic`); a `const fn` with a
    checked obligation is `E0703`. Overflow obligations are exempt from both
    in v0: the ±2^53 range is the runtime's assumption (impl spec §12.1) and
    they stay runtime checks.
68. **Codegen consumes statuses.** A callee's entry check for a `requires`
    clause or a parameter refinement is omitted when every call site proved
    it (whole-program), so Mandelbrot's generated code carries no checks.
69. **CLI.** `onus check --ledger` prints the obligations of the entry file
    with their statuses and provenance; `--budget <ms>` sets the per-obligation
    solver budget (default 500); `--no-cache` bypasses `.onus/cache/`;
    `ONUS_DUMP_SMT=<dir>` writes every problem for inspection.
70. **Checkout example (§18.3).** `recent_orders`'s `ensures forall o: Order in
    result: o.customer == who.id` needs the `Spec` mechanism and is commented
    out until it exists; its proof from the statement's `where` clause is the
    open item of item 53.

71. **Sequential solving.** The impl spec (§7.2) runs obligations in parallel
    up to the CPU count; v0 runs one `z3 -in -smt2` process at a time with
    `spawnSync`, relying on the proof cache for repeat runs. Mandelbrot,
    reporting and checkout verify in a few seconds each; parallelism is a
    performance item for later.

## M7 — reports

72. **Elided bodies (§2.3, §11.1).** `onus interface` must render "canonical
    source syntax with bodies elided to `{ ... }`" and the rendering must be
    valid Onus, so `...` is a token and `{ ... }` is a function body the
    parser accepts (`Block.elided`). Outside an interface document it is
    `E0115 elided body outside an interface document`, reported by the
    resolver; the checker never sees an elided body.
73. **Interface document shape (§11.1).** Beyond the example in the spec the
    document carries: every item of the module with its `visibility` (private
    items included, since the ledger and the assumptions must be complete);
    a module-level `ledger` of every obligation with status and provenance
    and module `obligations` totals, both of which the prose of §11 asks for;
    a `failed` count; on each contract `pinned`, `sites` (how many obligations
    the clause generated) and `checked_at` as a `file:line:col` of the first
    runtime check; loop `invariant`/`decreases` clauses listed as contracts of
    their function; `example`s and `property`s reported under the function
    of the same name (§18.1) and as items of their own otherwise. `hash` is
    `b3:` + BLAKE3 of the module's canonical text.
74. **Diagnostics (§13).** `canonical_hash` is filled for every diagnostic
    whose file has a canonical form. `onus check --json` prints one object
    per line. `repairs` are still only produced for E0001.
75. **Schemas.** JSON Schema (draft-07) for both documents lives in
    `packages/compiler/src/report/schema/`; the test suite validates every
    fixture's diagnostics and the three examples' interfaces against them.

## M8 — claims, capabilities, paths

76. **Claim participation (§7.1).** "Participates in the relevant effect" is
    given a definition: a callee participates in an asserted claim when it has
    an observable effect — `io.file`, `io.net` or a resource effect. The quiet
    effects (`alloc`, `mutate`, `panic`, `diverge`, `nondet`, `io.env`,
    `io.clock`, `io.rand`) change nothing an observer could see twice, so a
    callee with only those never has to carry the claim. An `assume` covers
    the function and everything beneath it. Intrinsics carry only what they
    declare, like their contracts (§3.12). Codes: `E0203` derived claim not
    satisfied, `E0204` asserted claim not propagated, `E0205` `assume` of a
    derived claim, `E0206` `assume` of an undeclared claim.
77. **Capability rules (§8, §8.3).** A record field of capability type is
    `E0601`; a `pub fn main` parameter of a non-root capability type is
    `E0602`; a non-test module importing a `test module` is `E0600`. `fake`
    outside a test module was already the parser's `E0012`.
78. **Paths (§9).** Reachability is breadth-first over calls in bodies,
    closures included, with interface calls resolved on concrete receivers
    through the impl table. Function values and dispatch on type parameters
    are `E0410`. New codes `E0412`–`E0415` for the bound, `forbid`, `require`
    and `policy` clauses; `E0411` for a bound that allows a forbidden effect.
    Policy scopes: `self` is the path's module; `std.*` matches `std` and
    every module beneath it.
79. **Path report (§9.1).** Adds `effects.forbid`, `obligations.failed`, `ok`,
    and `permitted_by` ∈ { `"scope"`, `"except"`, null }. `checked_at` and
    `constructed_at` are `module.fn:line:col`. Capability construction sites
    are every reachable call returning a capability, including attenuation;
    their `assumes` are empty until the stdlib records connect-time
    assumptions. `onus path <file> [<name>] --json`.
80. **Checkout example (§18.3).** Under item 76, `handle_checkout`'s claim
    requires `auth.require` (network) and `load_basket` (`sql.read`) to carry
    `Idempotent`. `Idempotent` moves to a shared `app.contracts` module
    (vendor.payments already imports app.auth, so app.auth cannot import
    vendor.payments); `auth.require` claims it, justified by having no
    participating callees; `load_basket` claims it with an `assume` that a
    select reads only. The path therefore lists three assumptions —
    `load_basket` and `record_order` in the module's own scope, `charge`
    permitted by `except` — and "exactly one assumption" (impl spec §9, M8)
    is read as exactly one external assumption, which is what the reviewer
    is trusting on another party's word. The spec's "1 assumed" presumed
    `std.sql` derives `record_order`'s idempotency from the statement (item
    53), which v0 does not do.

## M9 — `onus next`

81. **Constrained decoding (§14, impl spec §8).** `onus next <file> --offset
    <n>` takes a UTF-16 index (the implementation plan's `--offset`, not §14's
    `--at file:offset`) and returns `tokens`, `expectedType` and `inScope`.
    Tokens are the kinds the parser tests at the cursor after parsing the
    prefix; because the lexer drops a newline before a continuation token,
    a position after a newline reports the union of both tokenisations.
    Names in the vocabulary: keywords and punctuation as themselves, `ident`
    (names and soft keywords), `type-ident`, `literal:int|float|text|duration`,
    `newline`, `eof`. The expected type comes from a `Hole` expression at the
    cursor with every open bracket and block closed after it; it is null when
    the cursor is not in expression position or nothing expects a type there
    (a bare statement start). Refinements are spelled out in the type text
    and not enforced. Locals in scope are listed outermost first; module
    items are not. v0 keeps no resident state between calls (impl spec §12,
    item 5).
82. **`may` replaces `!` (§2.3, §6).** Requested by the spec author
    (`docs/CHANGE-LOG.md`, 2026-09-03): `!` reads as negation. `may` is a
    reserved word and `!` is no longer a token (`!=` remains). Applied to
    the grammar, every example in the spec, the standard library, the
    examples and the fixtures.

## M10 — the review tool

83. **Path report additions (§9.1, §15.1).** The path view must draw the
    reachable graph, and the tool computes nothing, so the report carries
    `graph.nodes` (qualified name, module, entry/fn/intrinsic, effects,
    carried claims, obligation counts, assume and recover counts) and
    `graph.edges` (caller, callee, effects at the site, location); `gates`
    (a sealed record type some reachable function returns and others demand
    as a parameter — the typestate of §18.3, drawn as the gate region);
    `recovers`; and `ledger` rows for every obligation of a reachable
    function.
84. **Interface item locations (§11.1).** Each item carries `at`, so the
    review page can show an item's canonical source when the reviewer opens
    a body; the interface itself still contains no bodies.
85. **Interface diff (§11.1, §15.1).** `onus interface <file> --diff
    <old.json>` and `onus review --against <old.json>` compare two documents
    of one module. v0 decides compatibility textually: a `requires` added or
    an `ensures` removed is breaking, the reverse compatible; a widened
    effect set or a changed signature line is breaking; new assumptions,
    recover sites and obligations that left `proved` are listed. Implication
    between clauses (a weaker `requires` written differently) is not
    checked; the module is breaking when a public item is. Schema in
    `interface-diff.schema.json`.
86. **The review tool (§15).** `packages/review` is dependency-free and
    renders one self-contained HTML page from the reports (impl spec §12,
    item 4 resolved: no framework). Views: paths (graph laid out top-down
    from the entry, assume leaves in amber and recover sites in purple as the
    only colours, unresolvable calls as a break, gate regions shaded),
    interfaces (bodies collapsed to `{ ... }`, opening counted per module in
    the page), ledger (filterable by state, with assumptions, recover sites
    and capability construction sites), diff, and diagnostics with the
    solver's counterexample. `onus review <entry> [--out <dir>] [--against
    <old.json>]` writes `index.html` and `review.json`. Not in v0: the path
    condition in the counterexample view, promotion drafts, and decisions
    or contract edits flowing back as tasks (§15.1); an invalid program's
    page shows its diagnostics only.

## Testing model (docs/CHANGE-LOG-02.md, applied 2026-09-04)

87. **`_` in `try ... else` (§2.3).** The verify example in §20.2 writes
    `else _: false`; the binder may now be `_`, which binds nothing. The
    printer keeps it.
88. **`verify` blocks (§20.2).** `verify` is a reserved word and a
    continuation token, so `verify(...)` on the line after an `assume`
    attaches to it. A block is a definition of its own (kind `verify`, parent
    the function): it sees the module and its parameters, not the function's
    locals; its calls are not the function's (no false recursion); its
    obligations are its own and the `panic` rule applies to it; it yields
    Bool, each bare expression being an assertion and `try ... else _: v`
    yielding `v`. Its declared effects must contain its body's and may not
    exceed its function's (`E0207`); its parameters must be capabilities
    (`E0208`).
89. **The environment (§20.2, §20.6).** `onus test --assumptions` supplies
    each parameter from a `test module` whose public zero-parameter functions
    return capabilities — `fake`s in practice — named by `onus.json`
    (`test.env`) or `--env`; `io.Files`, `io.Env`, `io.Net` and `io.Clock`
    come from the runtime when the environment gives none. A parameter with
    no source is `E0603`. Generated code exports each block as
    `verify$<n>` only in that mode, and a generated launcher runs them and
    prints the outcomes.
90. **The ledger (§20.3).** `.onus/ledger/assumptions.json`, keyed by module
    name and the BLAKE3 of the assumption's canonical text; each record has
    `at`, `target`, `result`, `claim`, `def`. The interface and path
    reports carry `verifiable` and `last_verified` per assumption; the
    review page shows *assumed, verified <when> against <target>* or
    *unverified*. `policy verified_assumptions_only` is the compiler's own
    policy name: `E0416` when a reachable assumption has no passing record
    younger than `onus.json` `test.max_assumption_age_days` (default 7).
91. **`onus test` (§20.6) and the checkout example.** Without flags it
    builds and runs the generated vitest suite; `--mutate` waits for M13.
    `charge`'s assumption gained a `verify` block that calls `charge` twice
    with one key; `auth.require` no longer declares `io.clock` it never
    used, so the block's effects fit `charge`'s; `examples/checkout/test_env.onus`
    and `onus.json` supply the fakes. The block passes, and the path report
    lists it as verified.

92. **Verify blocks in the reports (§20.2).** Bodies are elided from the
    interface, so the block a reviewer must read to judge a verification
    travels with the assumption: interface and path assumption entries carry
    `verify`, the block's canonical text or null, and the review page shows
    it under the assumption in the path, interface and ledger views.

## M11 — native backend

93. **One lowering, two emitters (impl spec §6).** Code generation is now
    `lower.ts` (checked AST plus obligation statuses → the target-neutral form
    in `ir.ts`) and two renderers, `js.ts` and `native.ts`. Every decision
    about what generated code does is made once in the lowering; the form is
    printed by `onus build --emit ir` and pinned for the fixture suite in
    `test/codegen/lowered/`. The JavaScript output is unchanged in behaviour.
94. **Native representation (§19.1).** `Int`/`Duration` are `i64`, `Float`
    is `double`, `Bool` is `i1`, and everything else is a pointer to an array
    of 64-bit slots (a variant's tag first), so generic code and runtime
    primitives move slots and callers convert at the boundary. `inout`
    parameters are pointers. `proved` obligations emit nothing; `checked`
    ones branch to `onus_panic`, whose message matches the JavaScript
    runtime's; `Int` arithmetic uses the overflow intrinsics; `try` is a
    branch that returns the error. The runtime is `packages/runtime/native/`
    (`onus.c`, `onus.h`), compiled and linked by `clang` from the emitted
    `.ll`. `Float` to `Text` follows JavaScript's shortest round-trip layout
    (§19.4).
95. **The v0 native subset.** Programs reaching closures or function values,
    interfaces, runtime quantifiers, `recover`, `fake`, `TypeInfo`,
    `old(...)` in a checked postcondition, structural equality on aggregates,
    `Map`, `Bytes`, `sql`, or `Text` operations needing grapheme tables are
    refused with `E0800 primitive unavailable on target`, as §19.1 allows.
    Allocation is never freed (free-at-scope-exit is deferred). `recover` via
    `setjmp`/`longjmp` and the `Int` representation obligations are M12.
96. **Differential testing (§19.5).** `onus test --target all` runs the
    examples on both targets and reports each disagreement as `E0801`;
    properties and laws run on JavaScript only. `onus build --target native`
    writes `<out>/native/<module>` and `onus run --target native` runs it.
    The C runtime's `-DONUS_BROKEN_INT_TO_TEXT` exists for the acceptance
    test that E0801 fires on a broken primitive.

97. **M12 names the JavaScript `sql` implementation.** M12's text listed
    only the C runtime's `libpq` primitives, but its acceptance (all three
    examples agree on both targets; reporting runs against Postgres) needs
    `sql` real on the JavaScript side too, which impl spec §5 has always
    described over `pg` and which v0 shipped as a stub (item 62). The
    milestone now says so, and takes `recover` from M11.

## M12 — targets complete

98. **Host claims (§19.2).** `std.host` declares the asserted claims `js`,
    `native` and `wasm`; a claim's name may be lowercase (grammar §2.3) so
    they read as `host.js`. The JavaScript-only intrinsics (`Text.len`,
    `graphemes`, `bytes`, `lower`, `trim`, `Map.*`, `Bytes.len`,
    `TypeInfo.*`) carry `claims host.js`; the native emitter refuses any
    reached function carrying it (`E0800`). A `forbid` clause may name
    claims as well as effects: a reachable function carrying one is `E0413`.
    Derived-claim predicates may name a claim by a lowercase qualified name.
99. **Representation obligations (§19.3).** Every `Int` or `Duration`
    parameter and `let`/`var` gets an obligation of kind `representation`,
    proved when the binding's declared type keeps every value within
    ±2^53 - 1 and otherwise `checked`. They are reported in the ledger and
    exempt from the `panic` rule like overflow. The slow path is not
    implemented: a checked binding keeps the number representation, and the
    existing overflow checks panic rather than switch to arbitrary
    precision. The ledger says which values that concerns.
100. **`std.sql` on both targets (§8.1, §18.2; impl spec §5).** JavaScript:
    `sql.ts` over `pg`, driven synchronously by a worker thread with
    `Atomics.wait` (Onus calls are synchronous; `pg` is not). Native:
    `onus_sql.c` over `libpq`, found through `pg_config`, Homebrew's keg or
    `ONUS_LIBPQ`; without it `std.sql` is `E0800`. `connect(mode: ReadOnly)`
    sets `default_transaction_read_only = on`, verifies it, and refuses a
    superuser role, which could not be held to it; the remaining assumption
    is named at the construction site in the path report. `restrict` sets
    the search path, `deadline` the statement timeout (`Err(Timeout)`).
101. **Row decoders (§18.2).** For each `sql.select` whose row type is a
    record the compiler generates a decoder in the target-neutral form
    (`decoder` on the call, `reject` statements): one column per primitive
    field, then the record's refinements; a failure is `Err(Refinement)`
    with the row and column, a missing or ill-typed column `Err(Malformed)`.
    JavaScript passes it as `$decode`; natively it is a generated function
    the C runtime calls per row.
102. **`recover` natively (§10.2).** The body becomes a function over the
    enclosing locals' addresses, run under `setjmp`; a panic inside
    `longjmp`s back and becomes `Err(Panicked { obligation, location })`
    with the same texts as the JavaScript runtime.
103. **WebAssembly (§19).** `--target wasm` compiles the same LLVM IR with a
    WASI SDK (`WASI_SDK_PATH` or `/opt/wasi-sdk`) to `program.wasm` and
    writes `run_wasm.mjs` for Node's built-in WASI; `std.sql` is `E0800`
    there. No SDK was available where this was written, so the path is
    untested end to end; `onus build --target wasm` reports the missing SDK.
104. **Differential harness (§19.5).** Every fixture and example with
    `example` blocks is built for both targets: those in the native subset
    must agree on every example, the rest must be refused with `E0800`.
    The SQL tests run against a Postgres at `ONUS_TEST_DSN` (default: the
    `postgres:17` Docker container with password `onus`) and skip with a
    notice otherwise.

## M13 — contract mutation and coverage

105. **Assertion obligations (§5.2, §20.4).** Every bare Bool statement of
    an `example`, `property` or `law` body is an obligation of kind
    `assertion`: proved when the contracts of what it calls entail it, and
    otherwise `checked` "run as a test". A proved assertion is a fact for
    the assertions after it. Tests are not functions, so these are exempt
    from the panic rule. Lowering test bodies exposed a contract that calls
    its own function (`ensures compare(a: a, b: a) == 0`); the verifier now
    states such a contract once instead of unfolding it forever.
106. **What "detected" means (§20.4).** Weakening a contract never changes a
    body, so re-running the tests cannot notice it. A mutation of an
    `ensures` clause, a result refinement or a record field refinement is
    detected when an assertion the verifier proved from the contracts stops
    being provable without the clause: the test restates what the clause
    promised. Negating a property's guards is the one dynamic mutation: the
    property is re-run over the complement of its domain and detects the
    mutation by failing. `onus test --mutate` prints one row per mutation,
    `M0001 undetected contract weakening` for the survivors, exits 0, and
    writes `.onus/ledger/mutations.json`, which the reports read. Static
    mutations need z3 and are skipped with a notice without it.
107. **Two of §20.4's mutations are not applied.** Laws are not dropped: a
    law is itself the only test of the interface clause it states, so its
    absence could never be detected and every law would be reported. And
    parameter refinements are not widened: accepting more inputs is a
    stronger promise by the callee, not a weaker one, and nothing a caller's
    test asserts can depend on it. Result and field refinements are widened.
108. **Obligation coverage (§20.5).** The runtime records a hit per check
    reached when `ONUS_COVERAGE_DIR` is set; the generated test file writes
    them after its tests, since test runners end their workers without
    running exit handlers. `onus test` merges the hits into
    `.onus/ledger/coverage.json`, keeping the larger count per check across
    runs, and prints the coverage line. `interface.json`, `path.json` and
    the review page carry `obligation_coverage`: proved; checked and how
    many of those a test reached; assumptions, verifiable and verified; and
    mutations detected and surviving. Representation obligations have no
    runtime check and are not counted as checks. Coverage is measured on
    the JavaScript target only.
109. **The acceptance test is pinned on Mandelbrot.** The `ensures` on
    `recent_orders` stays deferred (item 36), so the milestone's acceptance
    is dropping `ensures result <= limit` on `escape_count`, which
    `property escape_bounded` detects, and widening the result refinement
    of a fixture function no test restates, which survives and is reported.
    The build directory for `onus test` is resolved to an absolute path,
    which vitest needs, and the mutated programs are written beside it in
    `out-mutate` so the program's own test run does not see them.

## M14 — regeneration loop

110. **The loop package (loop spec §1, §10).** `packages/loop` with
    `onus-loop run <task.json>`; `onus loop run` forwards to it, since the
    compiler cannot depend on a package that depends on the compiler.
    `watch` needs task intake and is not in v0. Model access is one
    interface with three implementations: scripted, for the tests; Claude
    Code as a subprocess (`claude -p`, the nested-session markers stripped
    from its environment); the Anthropic Messages API over `fetch`, which
    could not be exercised here for want of a key. The constrained-decoding
    hook of §3.7 is declared and supplied by nothing.
111. **The context (§3).** Assembled through the compiler library, never
    from an import's source: the targets with bodies elided and the
    examples and properties that name them; the interfaces of every module
    in scope and every import; sibling bodies per the context policy; every
    diagnostic of the last check as §13 JSON, except `E0115` on a target,
    which is the task itself; failing examples with their text;
    counterexamples from the task and from the diagnostics; the standard
    library interfaces the targets' types select. The one fixed text
    describes the rules and Onus syntax, which is language knowledge, not
    a convention. Simplification: diagnostics are not narrowed to callees;
    everything in scope is shown.
112. **Never a claim (§1, §4).** Model output is parsed as Onus. A target
    whose signature, contracts, effects or claims differ from the baseline
    is refused with a note; a second refusal is out of scope, with a
    proposal built from the difference. An added function is refused once
    the same way, since helper introduction (§4.1 step 3) is off. Only
    bodies are spliced, under the target's own signature, and the file is
    put in canonical form so `E0001` never reaches the model. Mechanical
    repairs apply only to spans inside a target body.
113. **Classification and the ladder (§4, §4.1).** A stall is an outcome
    identical to an earlier one, or one that grew twice running. A contract
    conflict is a counterexample against a target's clause with the same
    body proposed twice; it ends in a `weaken_postcondition` or
    `add_precondition` proposal carrying the counterexample. The ladder
    walks full history, then a wider context policy, skips steps 3 and 4
    as configured off, and stops. Examples are evaluated at check time
    (`E0702`), so a wrong body usually fails there before the verifier
    runs; the loop treats those like any other diagnostic.
114. **Changes (§6).** `.onus/changes/<task>/change.json`: the interface
    diff per module in scope (empty by construction when the baseline had
    diagnostics, as an `implement` baseline always has, since only target
    bodies are spliced and signatures are compared textually), the ledger
    delta, the body diff, the trace, metrics, proposals and audit findings.
    A blocked report adds the cause, the last diagnostics and the best
    attempt, and the working tree is left as found. `onus review` gains a
    Changes view, proposals marked *proposed by loop*.
115. **Regeneration audits (§8).** Findings are `obligation_regressed`
    and `example_failed`, each becoming a proposal (`add_example`,
    `add_claim`). Bodies that differ in callees are not reported: the
    interface documents carry no call graph.
116. **A live run.** With Claude Code as the model, `escape_count` was
    regenerated from its interface alone and was green on the first
    iteration in 41 seconds, with the loop invariant and measure intact.
    The test runs only with `ONUS_LOOP_LIVE=1`.
117. **Deferred.** Production feedback (§7), `onus loop watch`, and the
    per-repository aggregates of §11; metrics are per change.
118. **OpenRouter and key files.** A fourth model, `openrouter[:<model>]`,
    over the chat-completions protocol; the default model is
    `OPENROUTER_MODEL` or `deepseek/deepseek-v4-flash`, chosen on the
    results in item 119; `moonshotai/kimi-k2.7-code` is the alternative. The CLI reads
    `.env` and `.env.local` from the project root and the current
    directory, never overriding the real environment, so keys stay off the
    command line; both files are ignored by git. The live test takes its
    model from `ONUS_LOOP_MODEL`.
119. **What running four open-weight models taught the loop.** (a) A
    provider that never answers hangs the task; API requests now time out
    after three minutes and the task ends as a model error. (b) Each
    iteration's prompt and answer are kept in the change's work directory
    (`change.json` still carries only the prompt hash, §6), so a blocked
    task can be read. (c) A blocked report's `last_diagnostics` are the
    last iteration's, including syntax diagnostics of an answer that never
    parsed. (d) When an answer does not parse, the notes quote each
    offending line and the tokens the grammar admits there, from `onus
    next`'s machinery (§14): a model that does not know Onus writes
    `while`, is told "expected an expression", and writes `while` again;
    told that a line may start with `loop`, it has what it needs. Results
    on the Mandelbrot task: DeepSeek V4 Flash and Kimi K2.7 Code green on
    the first iteration (5 s and 20 s), GLM 5.3 Flash green on the second
    (98 s), Qwen3 Coder Next blocked on the budget without a parseable
    answer before or after (d), and Claude Sonnet 5 through OpenRouter
    green on the second (15 s) after a syntax slip on the first. The
    OpenRouter default is DeepSeek V4 Flash on these results. The runs
    are logged in `docs/BENCHMARK.md`, and `packages/loop/bench/run.mjs`
    appends a row per model so the log can be revisited.

### Deferred, not changed

- `Stream[T] ! e` as a type (§3.11) is not parsed: `-> Stream[T] ! e` is
  ambiguous between the stream's effect and the function's. To be settled
  when streams land.
- Multi-binder quantifiers and tuple comparisons in §4.1 (`forall px: Int,
  py: Int where (px, py) != (x, y)`) are not in the grammar; nested
  quantifiers (§5.3 allows depth two) express the same thing.
- `budget` annotations (§12.3) and `proves float` (§3.2) have no syntax yet.
- Structural recursion over a union (`depth(t: Tree[T])`) has no `Int`
  measure to write in `decreases`; such functions declare `diverge` for now.
  A well-founded measure on algebraic data (size, or a `decreases` over a
  field) is needed before the verifier handles them (§5.1, §17.8).
- Generated tests import `vitest` and `fast-check` by name and resolve them
  from the nearest `node_modules`; a project outside this repository needs
  both installed.
