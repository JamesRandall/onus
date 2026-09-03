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

### Deferred, not changed

- `Stream[T] ! e` as a type (§3.11) is not parsed: `-> Stream[T] ! e` is
  ambiguous between the stream's effect and the function's. To be settled
  when streams land.
- Multi-binder quantifiers and tuple comparisons in §4.1 (`forall px: Int,
  py: Int where (px, py) != (x, y)`) are not in the grammar; nested
  quantifiers (§5.3 allows depth two) express the same thing.
- `budget` annotations (§12.3) and `proves float` (§3.2) have no syntax yet.
