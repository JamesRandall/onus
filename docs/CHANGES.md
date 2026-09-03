# Spec changes

Changes to `onus-spec-v0.md` forced by implementation, by milestone. Each is
marked in the spec with `<!-- changed: reason -->` and pinned by a fixture.

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
    `var` (Mandelbrot's `render` calls `Grid.set` with `! alloc` only).
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
    `alloc` (M3 item 48 narrowed). Its signature in §3.8.1 gains `! alloc`.
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

### Deferred, not changed

- `Stream[T] ! e` as a type (§3.11) is not parsed: `-> Stream[T] ! e` is
  ambiguous between the stream's effect and the function's. To be settled
  when streams land.
- Multi-binder quantifiers and tuple comparisons in §4.1 (`forall px: Int,
  py: Int where (px, py) != (x, y)`) are not in the grammar; nested
  quantifiers (§5.3 allows depth two) express the same thing.
- `budget` annotations (§12.3) and `proves float` (§3.2) have no syntax yet.
