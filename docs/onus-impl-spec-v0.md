# Onus — implementation specification, v0

Companion to `onus-spec-v0.md` (the language spec). This document says how to build the compiler, in what order, and what "done" means at each step. Section references of the form §N are to the language spec.

---

## 1. Decisions

Syntax note: the language spec borrows F#'s data-model syntax (unions with `of`, `match ... with`, `when` guards, `{ x with ... }`) and is deliberately not F# elsewhere (§2 of the language spec, "Borrowing policy"). Do not import F# conventions the spec does not name — no inference, no currying, no `|>`, no light syntax.

| Decision | Choice | Reason |
|---|---|---|
| Implementation language | TypeScript, strict, Node 22+ | Output runs in a browser; review tool is a web page; fastest iteration |
| Target | JavaScript (ES modules), emitted directly | One step for users; Onus types don't map onto TS types without casts. `onus build --emit ts` exists as a dev-only oracle for the fixture suite |
| Parser | Hand-written recursive descent, LL(1) | `onus next` (§14) needs the parse state exposed; generators hide it |
| Solver | External `z3` binary, SMT-LIB 2 over stdin, one process per obligation with timeout | Keeps the compiler pure TS; solver is swappable (cvc5) |
| AST | One tree, side tables keyed by node id | No parse/typed tree duplication; obligations and diagnostics reference nodes by id |
| Diagnostics | Structured objects from day one (§13); text rendering is a view | Never retrofit |
| Runtime numbers | `Int` as `number` with range checks at ±2^53; overflow beyond that is a v0 limitation flagged in the ledger | BigInt is correct and slow; revisit |
| Package manager / test runner | pnpm, vitest | Conventional |
| Native target | LLVM IR text emitted by the compiler; `clang` assembles and links against a small C runtime | Own lowering (semantics stay ours), borrowed instruction selection and optimisation; nothing to install beyond Xcode CLT / `clang` on Linux <!-- changed: 2026-09-03, docs/CHANGE-LOG.md "Targets" --> |

Non-goals for v0 implementation: performance of generated code, incremental compilation beyond obligation caching, IDE integration beyond `onus next`, concurrency, FFI.

---

## 2. Repository layout

```
onus/
  package.json            workspace root (pnpm)
  packages/
    compiler/             the compiler library and CLI
      src/
        lexer/            tokens, lexer, position mapping
        syntax/           ast.ts (node types), parser.ts, printer.ts (canonical form)
        resolve/          scopes, name binding, module graph
        types/            type representation, checker, exhaustiveness, flow knowledge
        effects/          effect sets, containment, alloc inference
        consteval/        check-time evaluator (§3.8), TypeInfo, Spec
        contracts/        obligation objects, VC lowering, path knowledge
        verify/           SMT-LIB emission, z3 driver, cache
        claims/           claim tiers, assume tracking, policies (§7)
        capabilities/     capability types, attenuation, root rules (§8)
        paths/            reachability, provenance, path reports (§9)
        codegen/          TS emission, runtime-check insertion
        report/           diagnostics (§13), interface documents (§11.1), path reports (§9.1)
        cli/              onus check | build | run | interface | path | next | fmt
      test/
        roundtrip/        parse→print→parse fixtures
        checker/          positive and negative programs, one file per rule
        verify/           obligation fixtures with expected proved/checked
        examples/         the three worked examples end to end
    runtime/              the TS runtime the generated code imports
      src/                int.ts, text.ts, list.ts, grid.ts, result.ts, capability.ts, sql.ts, io.ts, panic.ts
    stdlib/               Onus source for std.* (§16), compiled by the compiler
      std/                int.onus, float.onus, text.onus, list.onus, grid.onus, results.onus (`result` is a keyword), io.onus, sql.onus, config.onus
    review/               the review tool (§15) — a static web page over the JSON reports; last milestone
    loop/                 the regeneration loop (docs/onus-loop-v0.md; M14): tasks, model access, the cycle, changes and proposals
      schema/             task, change and proposal JSON schemas (loop spec §10)
      src/                task.ts, model.ts, project.ts, context.ts, edit.ts, cycle.ts, change.ts, cli/
      test/               scripted-model fixtures, one per task kind and per stopping cause
    self/                 the compiler in Onus (M15), staged against the TypeScript compiler as oracle
  examples/
    mandelbrot/
    reporting/
    checkout/
```

Every package has its own `tsconfig.json` extending the root, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.

---

## 3. Core data structures

### 3.1 Nodes and ids

```ts
type NodeId = number & { readonly __brand: 'NodeId' };

interface Node { id: NodeId; kind: NodeKind; span: Span; }
interface Span { file: FileId; start: number; end: number; }   // byte offsets into the canonical source
```

Every AST node has a stable id assigned by the parser in pre-order. Side tables are `Map<NodeId, T>` or dense arrays indexed by id. Nothing is stored on nodes after parsing; the parser's output is immutable.

The AST kinds follow the grammar in §2.3 one-to-one. Do not add convenience kinds that the grammar doesn't have; canonical printing must be a pure function of the tree.

### 3.2 Canonical printing

`print(ast): string` is the single formatter. Properties, tested in `test/roundtrip`:

- `parse(print(parse(s)))` deep-equals `parse(s)` for every valid `s`.
- `print(parse(s)) === print(parse(print(parse(s))))` (idempotent).
- For each fixture pair `(messy.onus, canonical.onus)`: `print(parse(messy)) === canonical`.

`E0001` is emitted by `onus check` when `print(parse(s)) !== s`, with the canonical text as the repair. `onus fmt` writes it.

Definition hashes (§2.2, §12.4): BLAKE3 over the canonical text of the definition, excluding comments. Use `@noble/hashes`.

### 3.3 Types

```ts
type Type =
  | { k: 'prim'; name: 'Int' | 'Float' | 'Bool' | 'Text' | 'Unit' | 'Bytes' | 'Duration' }
  | { k: 'refined'; base: Type; pred: ExprId; self: NodeId }       // `it` binds to self
  | { k: 'record'; def: DefId; args: TypeArg[] }
  | { k: 'union';  def: DefId; args: TypeArg[] }
  | { k: 'fn'; params: Param[]; ret: Type; effects: EffectSet }
  | { k: 'stream'; elem: Type; effects: EffectSet; finite: boolean }
  | { k: 'capability'; def: DefId; args: TypeArg[] }
  | { k: 'param'; id: TParamId }                                    // generic type parameter
  | { k: 'typeinfo' } | { k: 'spec' };                              // check-time only
type TypeArg = { k: 'type'; type: Type } | { k: 'const'; value: ConstValue };
```

Subtyping is refinement subsumption only: `refined(base, p) <: base`, and `refined(base, p) <: refined(base, q)` iff `p ⟹ q` as an obligation. There is no other subtyping. Type equality on generics is nominal on `def`.

### 3.4 Effects

```ts
type Effect = { k: 'prim'; name: PrimEffect } | { k: 'claim'; def: DefId } | { k: 'param'; id: EParamId };
type EffectSet = ReadonlySet<Effect>;   // normalised: params substituted before comparison
```

Containment is set inclusion after substitution. `alloc` is inferred for a function body if any allocating operation or call to an allocating function appears; the inferred set must be ⊆ the declared set, else `E0201 undeclared effect`.

### 3.5 Obligations

```ts
interface Obligation {
  id: ObligationId;
  kind: 'requires' | 'ensures' | 'refinement' | 'invariant-entry' | 'invariant-step'
      | 'decreases' | 'index' | 'law' | 'property' | 'overflow' | 'const-check';
  at: NodeId;                 // where it must hold
  def: DefId;                 // enclosing definition
  formula: Formula;           // lowered, see §6
  knowledge: Formula[];       // path knowledge in scope at `at`
  status: 'pending' | 'proved' | 'checked' | 'assumed' | 'failed';
  pinned?: 'proved';          // `requires proved` etc.
  counterexample?: Model;
  hashKey: string;            // for the cache
}
```

Obligations are created by the contract pass, resolved by the verifier, and consumed by codegen (insert a runtime check iff `checked`) and by the report generators. They are first-class from milestone 5 onward; never represent them as booleans.

### 3.6 Diagnostics

Exactly the JSON shape in §13. `Diagnostic` objects are accumulated in a `DiagnosticSink`; passes never throw on user errors. `onus check` prints all diagnostics and exits non-zero if any. There is no warning severity anywhere in the codebase; do not add one.

Diagnostic codes are declared in one file, `report/codes.ts`, as a `const` object with a title per code, and that file is the catalogue. Codes are never reused.

---

## 4. Passes

The compiler is a pipeline; each pass takes the AST plus the side tables produced so far and adds its own. Order:

1. **lex + parse** → AST, `E0xxx` syntax diagnostics. Parser must recover at statement boundaries so multiple errors are reported.
2. **canonical check** → `E0001`.
3. **resolve** → module graph, scope tables, `DefId` for every definition, import resolution. Cycles between modules are `E0101`.
4. **types** → type of every expression, exhaustiveness, `sealed` enforcement, `inout` rules, closure capture rules, const parameter binding.
5. **consteval** → values of `const` items and const arguments; `const fn` bodies run under the step budget; `E0700` from `ConstError` results; `TypeInfo`/`Spec` values materialised.
6. **effects** → effect set per definition, containment at every call, `alloc` inference.
7. **flow** → path knowledge per node (§3.2.1): a list of `Formula` in scope, computed by walking each body with branch conditions, `match` arms, loop conditions, and killed on `var` assignment and `inout` passes.
8. **contracts** → obligations (§3.5) for every site listed in §12.1. Also `decreases` obligations and recursion cycle detection (`E0320`).
9. **claims** → tiers, `assume` sites recorded, derived claims expanded to effect predicates, propagation over the call graph. Records `verify` blocks on `assume` sites; they are type- and effect-checked like functions in passes 4 and 6 but excluded from codegen except under `onus test --assumptions`. <!-- changed: 2026-09-03, docs/CHANGE-LOG-02.md -->
10. **capabilities** → capability parameter rules, root rules for `main`, attenuation typing, `fake` only in `test module`.
11. **verify** → obligation statuses.
12. **paths** → reachability, provenance, per-path checks, `E0410`/`E0411`.
13. **codegen** → TS files into `out/`.
14. **report** → `interface.json` per module, `path.json` per path, `diagnostics.json`. Each assumption entry carries `verifiable` and `last_verified` (§20.3 of the language spec); each module and path carries an `obligation_coverage` block (§20.5). <!-- changed: 2026-09-03, docs/CHANGE-LOG-02.md -->

Passes 5–12 can be skipped by `onus check --to <pass>` for development. Each pass has a single entry point `run(ctx: Context): void` and writes only to its own tables; a pass that needs another pass's output reads it from `ctx`.

---

## 5. Runtime

`packages/runtime` is imported by generated code. It is small and fully typed. Key modules:

- `int.ts` — `checkedAdd/Sub/Mul` throwing `Panic` on leaving the safe integer range; used only where the obligation is *checked*.
- `text.ts` — `Text` as a branded `string`; `len` is grapheme count via `Intl.Segmenter`; `concat`; no indexing exported.
- `list.ts` — immutable arrays; `get` with a check only where the obligation is *checked*.
- `grid.ts` — `Float64Array`/`Int32Array` backed, dimensions in the type parameters at compile time, plain numbers at runtime.
- `result.ts` — `Ok`/`Err` tagged unions; `Option` likewise.
- `panic.ts` — `class Panic extends Error { obligation: ObligationRef; model?: unknown }`; `recover(fn)` wraps it into `Result<T, Panicked>`.
- `capability.ts` — base class with a private constructor and a static `__fake` only reachable from generated test modules (guarded by a module-level token the compiler emits).
- `io.ts` — `Files`, `Env`, `Net`, `Clock` capabilities over Node APIs; constructed only by `runtime.main(entry)`.
- `sql.ts` — `Db` capability over `pg`; `connect(mode: ReadOnly)` sets `default_transaction_read_only` and queries `pg_roles` for the privilege check; `narrow`, `restrict`, `deadline`; `query` returning `Result`, decoding rows through the generated row decoder which applies refinements and returns `Err(Refinement)`.

Capabilities are ordinary objects at runtime. Every guarantee is static; the runtime only has to make forging inconvenient, not impossible.

`.onus/ledger/assumptions.json`, keyed by module and `assume` location hash, holds each assumption's `last_verified` record as written by `onus test --assumptions` (§20.3 of the language spec). <!-- changed: 2026-09-03, docs/CHANGE-LOG-02.md -->

---

## 6. Codegen

Mapping:

| Onus | TypeScript |
|---|---|
| `module a.b` | `out/a/b.js`, one file per module, ESM |
| `fn` | `export function` (or plain for private); named args → a single object parameter `{x, y}` destructured; call sites pass object literals |
| `record` | `interface` plus a generated constructor function that applies refinement checks where *checked* |
| `union` | tagged union `{ tag: 'Escaped', at: number }`; `match ... with` compiled to a labelled block of pattern tests in arm order (guards fall through to the next arm), ending in `rt.unreachable()` <!-- changed: M5, item 60 --> |
| `sealed` | constructor function not exported; `test module` output receives it via a compiler-emitted internal export |
| refinements | no runtime representation; a check is inserted at the obligation site iff `checked` |
| effects | erased; the type system already enforced them |
| capabilities | typed handles from the runtime; erased mode/index parameters |
| `inout` | the callee returns `[result, ...inout parameters]` and the caller reassigns its variables; grids are mutated in place inside the runtime because nothing else holds them <!-- changed: M5, docs/CHANGES.md item 59 --> |
| `try` | `rt.unwrap(expr)` throws `EarlyReturn`, caught by the enclosing function, which returns its value; `else` converts through `rt.unwrapElse(expr, e => ...)` <!-- changed: M5, item 60 --> |
| `recover` | `runtime.recover(() => { ... })` |
| `for` over range | `for (let i = a; i < b; i++)` |
| `loop while` + `decreases` | `while` plus, where the `decreases` obligation is *checked*, a runtime assertion that the measure decreased |
| `example` | a generated test file `out/a/b.examples.test.js` for vitest |
| `property` | a generated test with `fast-check` generators derived from parameter refinements |
| `const fn` | not emitted; it ran at check time. If also called at runtime, it is emitted as an ordinary function |

The product output is JavaScript. Under `--emit ts` (fixture suite only) the same codegen emits TypeScript with types derived from the erased Onus types; that output must pass `tsc --strict` with no `any` and no casts. A `tsc` failure there is a codegen bug: add a fixture. Never let `--emit ts` become a user-facing path.

Two targets, one lowering (§19 of the language spec). The codegen pass has two emitters behind one interface, `emit(ctx, target)`. The lowering from checked AST plus obligation statuses to a target-neutral form is shared; only the final emission differs. Do not duplicate lowering logic per target. <!-- changed: 2026-09-03, docs/CHANGE-LOG.md "Targets" -->

---

### 6.1 Generics on the native target (decided 2026-09-06)

A native slot carries no type, so generic code cannot compare, copy, hash or describe a value of a type parameter. The native lowering therefore monomorphises: after the shared, target-neutral lowering, a native-only step specialises every generic function per distinct instantiation reachable from `main` and the examples (the checker records every instantiation; the worklist is the emitter's reachability walk), so that inside each specialisation the type parameters are concrete and equality, `old(...)`, `TypeInfo` and `Dict` keys resolve to the concrete type's comparer, copier, descriptor constant and hash. Interface-bounded parameters keep dictionary passing as the lowering produces it. The JavaScript target is unchanged. The alternatives considered and rejected: runtime type descriptors passed as hidden arguments (an indirection on every generic operation, a type algebra in the C runtime) and tagged values (a tag on every value and a narrower `Int`, contrary to §19.3). The rule this needs is in M15.5: polymorphic recursion is a checker error.

## 7. Verification

### 7.1 Formula representation

```ts
type Formula =
  | { k: 'lit'; v: number | boolean }
  | { k: 'var'; name: string; sort: Sort }
  | { k: 'app'; fn: string; args: Formula[] }          // + - * / % = < <= and or not ite implies
  | { k: 'select'; seq: Formula; i: Formula }          // sequences: List, Bytes, Grid (flattened)
  | { k: 'len'; seq: Formula }
  | { k: 'forall' | 'exists'; vars: [string, Sort][]; body: Formula }
  | { k: 'ctor'; def: DefId; variant?: string; args: Formula[] } // ADTs
  | { k: 'proj'; of: Formula; field: string }
  | { k: 'uf'; fn: DefId; args: Formula[] };            // uninterpreted call to a user function
type Sort = 'Int' | 'Bool' | 'Real' | { seq: Sort } | { adt: DefId };
```

Lowering: `Int` → `Int`; `Float` → not lowered in v0 (every float obligation is *checked*); `Bool` → `Bool`; records and unions → SMT datatypes; `List`/`Bytes`/`Grid` → `(Seq Int)` or `(Array Int T)`, whichever proves faster in practice (start with `Array` + a `len` symbol); `Text` → uninterpreted sort with `len` and equality. Calls to user functions in formulas are uninterpreted functions with the callee's `ensures` asserted as axioms about the result.

Sorts and projections are named by the qualified type (`ast.Stmt`, `std.list.List_ast.Arg`; docs/CHANGES.md item 161): a bare name collides across modules and the collision is a soundness hole. Type-derived facts (`typeFacts`) are asserted only where a refinement is reachable within the depth bound, decided once per type and depth; a list's length bound is an axiom of its sort, printed with the declarations (item 162).

### 7.2 Discharge

For each obligation: emit

```
(set-logic ALL)
(set-option :timeout <budget-ms>)
<declarations>
<assert knowledge_1> ... <assert knowledge_n>
<assert callee ensures axioms>
(assert (not formula))
(check-sat)
(get-model)
```

`unsat` → `proved`. `sat` → if pinned `proved`, `failed` with the model as counterexample (`E0302` family); otherwise `checked`. `unknown`/timeout → `E0501` (hard error, per §12.3) unless the obligation is not pinned and the fragment was known-nonlinear, in which case `checked`.

Default budget 500 ms per obligation, overridable per obligation with `budget` and globally with `--budget`.

Two points of the walk that produces the knowledge (`verify/vc.ts`, `self/vc.onus`) are easy to get wrong and were (docs/CHANGES.md items 150–151): a call with an `inout` argument binds the variable to a fresh post-call term, the callee's `ensures` seeing that term for the parameter and the passed term for `old(param)`; and a `match` joins like an `if`, keeping each fall-through arm's facts and assignments under the arm's condition, with the disjunction of those conditions as a fact. <!-- changed: 2026-09-05 — docs/CHANGES.md items 150–151 -->

### 7.3 Cache

Key: BLAKE3 of (canonical text of the enclosing def, canonical text of every def referenced by the formula, solver name and version, budget). Value: status and model. Stored in `.onus/cache/`. Never cache `E0501`.

Above the proof cache sits a module cache (`verify/modcache.ts`, `self/modcache.onus`; docs/CHANGES.md item 160). Key: BLAKE3 of the module's canonical text, the keys of the modules it imports (so a change anywhere below invalidates), the compiler that verified it (`ts` or `self`, so the two compilers never replay each other), the solver version, the budget and a format number. Value: the final status and provenance of each of the module's obligations, in creation order, stored only when verifying the module reported no diagnostic. On a hit the verifier assigns the stored statuses and builds no conditions for the module; the panic and const-fn rules still run and, being deterministic on statuses, report nothing again. Stored beside the proof cache; `--no-cache` disables both. <!-- changed: 2026-09-06 — docs/CHANGES.md item 160 -->

### 7.4 Running z3

`child_process.spawn('z3', ['-in', '-smt2'])`, write, read, kill on timeout. Run obligations in parallel up to `os.cpus().length`. If `z3` is not on `PATH`, `onus check` degrades to every obligation *checked* and emits a single informational line to stderr — not a diagnostic, because the program is still valid.

---

## 8. `onus next`

`onus next <file> --offset N --json` returns

```json
{ "tokens": ["ident", "(", "it", "result", "old", "forall", "exists", "fn", "try", "recover", "-", "not", "literal:int", "literal:float", "literal:text", "literal:duration"],
  "expectedType": "Int where 0 <= it and it <= 10000",
  "inScope": ["cx", "cy", "limit", "zx", "zy", "i"] }
```

Implementation: run the parser on the prefix with a recording token source; when the source is exhausted, the parser's current production's FIRST set is `tokens`. Run the type checker on the prefix with a synthesised hole at the cursor; the hole's expected type is `expectedType`. Refinement constraints are reported but not enforced by `next` (§14).

Deliver this last; it depends on the parser being cleanly LL(1), which milestone 1 establishes.

---

## 9. Milestones

Each milestone has acceptance tests in `test/`. Do not start the next milestone with the previous one's tests failing.

**M1 — Front end.** Lexer, parser for the full §2.3 grammar, AST, canonical printer, `onus fmt`, `onus check` reporting syntax errors and `E0001`. Accept: round-trip properties hold on all fixtures; all three worked examples parse and print canonically; `test/roundtrip` has at least 30 fixtures including every grammar production.

**M2 — Types.** Resolve, types, records, unions, exhaustiveness with guards, generics with bounds, interfaces and `impl` (contracts parsed, laws parsed, obligations not yet generated), `sealed`, `inout`, closures, `const` parameters bound (evaluator for literals and simple arithmetic only). Accept: every negative fixture in `test/checker` produces exactly its expected codes; Mandelbrot type-checks.

**M3 — Effects.** Accept: an Onus program that calls `io.write` from a pure function is `E0201`; effect-polymorphic `map` works; `alloc` is inferred; all three examples type- and effect-check.

**M4 — Const evaluator.** Full `const fn` support with step budget, `TypeInfo`, `ConstError` → `E0700` with offsets, `Spec` values. Accept: a stdlib `parse_select` that accepts a `SELECT` and rejects an `UPDATE` with the error at the right character; column/field mismatch detected.

**M5 — Codegen, all checked.** Runtime package; every obligation *checked*; generated tests for `example` and `property`. Accept: `onus run examples/mandelbrot` writes a correct PGM without any intermediate compile step; `example` blocks pass under vitest; the fixture suite's `--emit ts` output passes `tsc --strict`; a deliberately violated `requires` panics with the obligation in the message.

**M6 — Verification.** Flow knowledge, obligation lowering, z3 driver, cache, statuses feeding codegen. Accept: Mandelbrot's ledger matches §18.1 (no `checked` obligations); `test/verify` fixtures produce expected statuses; a pinned `proved` that fails reports a counterexample; timeouts are `E0501`.

**M7 — Reports.** `interface.json` (§11.1), `diagnostics.json` (§13) complete, text renderers. Accept: JSON validates against schemas checked into `report/schema/`; the text rendering of an interface is valid Onus with bodies elided.

**M8 — Claims, capabilities, paths.** Assume tracking, derived claims, policies, root rules, attenuation, `test module` and `fake`, reachability with provenance (v0: function values unresolvable), `path.json` (§9.1). Accept: reporting example's `path monthly_report` passes; checkout example's `path checkout` passes with exactly one assumption; removing the `except` fails the policy; adding a `sql.write` to a reachable function fails the bound. Added 2026-09-03 (docs/CHANGE-LOG-02.md; done 2026-09-04, docs/CHANGES.md items 87–91): `verify` blocks parsed, checked, and stored; `onus test --assumptions` runs them against capabilities constructed from a repository config; ledger fields populated; `policy verified_assumptions_only`. Accept: the checkout example's `Idempotent` assumption has a `verify` block that passes against a fake payments service and the path report shows it as verified.

**M9 — `onus next`.** Accept: for every fixture, the token set at every offset is a superset of the token actually present; expected types are correct at 20 hand-picked positions.

**M10 — Review tool.** Static page in `packages/review` rendering `interface.json` and `path.json`: the path view (graph, ledger rows), interface view, ledger view, diff view. Reads files; computes nothing beyond layout. Accept: the checkout path renders with the assumed leaf highlighted and the gate region drawn. Added 2026-09-03 (docs/CHANGE-LOG-02.md; done 2026-09-04): assumption freshness shown in the path and ledger views.

<!-- changed: 2026-09-03, docs/CHANGE-LOG.md "Targets: dual backends as a design goal" — M11 and M12 added -->

**M11 — Native backend.** LLVM IR emitter; C runtime for the §19.1 primitive surface (no `sql` yet); `onus build --target native` produces an executable via `clang`. `proved` obligations emit no code; `checked` obligations emit compare-and-branch to `onus_panic` with the obligation id; `recover` via `setjmp`/`longjmp`. `Int` is `i64` with `llvm.*.with.overflow` intrinsics. Accept: Mandelbrot builds natively and writes an identical PGM to the JS build; every `example` passes on both targets; `E0801` fires on a deliberately broken runtime primitive. Before emitting anything: the shared lowering in `codegen/` is the design constraint — if the JS emitter has lowering logic tangled into emission, separate it first, and add a fixture set for the target-neutral form. Done 2026-09-04 (docs/CHANGES.md items 93–96) except `recover`, which moves to M12 with the rest of the native subset's gaps.

**M12 — Targets complete.** `sql` real on both targets: the JavaScript runtime's `sql.ts` over `pg` as §5 describes (the v0 stub returns a `Connection` error, docs/CHANGES.md item 62) and `sql` primitives in the C runtime over `libpq`, both with the read-only session setup and privilege check of §8.1 and the row decoder that applies refinements and returns `Err(Refinement)`; `recover` via `setjmp`/`longjmp` natively; host claims; `Int` representation obligations in the JS backend; differential test harness running all fixtures on both targets; WebAssembly emission via the same LLVM path (`--target wasm`), with `io.*` mapped to WASI. Accept: all three examples build and agree on both native and JS; the reporting example runs natively against Postgres; a `path` with `forbid { host.js }` rejects a JS-only `assume` leaf. Done 2026-09-05 (docs/CHANGES.md items 98–104); WebAssembly emission is written but untested for want of a WASI SDK, and the `Int` slow path is reported but not switched (item 99).

<!-- changed: 2026-09-03, docs/CHANGE-LOG-02.md "Testing model" — M13 added -->

**M13 — Contract mutation and coverage.** `onus test --mutate` with the four mutation kinds; `M0001` reporting (a report row of the test run, not a diagnostic: there are no warnings); obligation coverage in `interface.json`, `path.json` and the review tool. Accept: dropping the `ensures` on `recent_orders` is detected by its property; dropping a deliberately unexercised refinement in a fixture survives and is reported. Done 2026-09-05 (docs/CHANGES.md items 105–109): the acceptance is pinned on `escape_count` and `property escape_bounded`, since the `ensures` on `recent_orders` stays deferred; laws are not mutated (item 107).

---

<!-- changed: 2026-09-05 — M14 and M15 added at the author's request: the regeneration loop from docs/onus-loop-v0.md, and the compiler in Onus -->

**M14 — Regeneration loop.** `packages/loop` implements `docs/onus-loop-v0.md` §1–§6 and §8–§10 as written, which makes that document normative for the loop from here on: tasks (`implement`, `repair`, `interface_change`, `regenerate`; `ticket` produces a proposal only); the context of §3 assembled from compiler output through the compiler library, never from source files of imports; the cycle of §4 with its five classifications, mechanical repair of high-confidence diagnostics whose span lies inside a target body (never outside: a repair to a signature is a claim edit), capped at three rounds; the escalation ladder steps 1 and 2, with 3 and 4 present as configuration and off; budgets; the proposals of §5, never an edit; the changes of §6 written under `.onus/changes/<task>/` and rendered by the review tool as *proposed by loop*; the regeneration audits of §8; the boundaries of §9, including stopping on `E0999` and restoring the working tree when blocked. Model access is one interface, `generate(context) → text`, with three implementations: a scripted model for the tests, the Anthropic API, and Claude Code as a subprocess. `onus loop run <task.json>` forwards to `onus-loop run`. Deferred: `watch` (needs task intake), production feedback (§7), constrained decoding (§3.7). Accept, all with the scripted model: an `implement` task whose first body is wrong and second right reaches green in two iterations and opens a change with an empty interface diff and a ledger delta; a `repair` task with a counterexample reaches green; a pinned postcondition no body can satisfy ends in a contract-conflict proposal with the counterexample, and the file is unchanged; model output that changes a signature, or adds a helper, is blocked as out of scope with a proposal; a `regenerate` task whose regenerated body passes its contracts but fails an example reports the finding as a proposal; a model that repeats the same wrong body walks the ladder and is blocked as stalled; a budget of one iteration is blocked as exhausted. With a real model, tagged and skipped by default: the Mandelbrot `escape_count` body regenerated from its interface passes. Done 2026-09-05 (docs/CHANGES.md items 110–117): every scripted case passes, and Claude Code regenerated `escape_count` green on its first iteration.

**M15 — Onus in Onus.** The compiler written in Onus, in stages, each differential-tested against the TypeScript compiler over the whole fixture suite and the three examples; the TypeScript compiler stays the oracle until the last stage. Stages:

- *M15.0 — Prerequisites.* (a) The standard library a compiler needs: `Text` code points and graphemes, slicing, search, split and join, `Int`/`Float` parsing and printing, a builder; `List` sort, slices, index operations, fold; `Map` on every target with insertion order (today `host.js` only, so a native map in the C runtime); `Bytes`; `io.Files` whole-file read and write and directory listing; process exit codes; a `Process` capability to run z3. (b) Recursion, which the spec states in §5.1 but the implementation has only had loops to exercise: audit that a `decreases` obligation is generated at every recursive call site and discharged; mutual recursion across modules (`E0320`); measures over `List` length, `Text` length and record fields, which structural recursion over an AST needs; and a stack-depth story for a recursive-descent parser on both targets (explicit stacks, or a documented and checked bound). Accept: a fixture set per new standard library module; recursion fixtures for direct, mutual and structural recursion with proved measures, and the `E0320` cases. Done 2026-09-05 (docs/CHANGES.md items 120–125) except native `Map`, the `Process` capability and the stack-depth story, deferred to the stages that need them.
- *M15.1 — Front end in Onus.* Lexer, parser and canonical printer; `onus fmt` reimplemented. Accept: byte-identical canonical output to the TypeScript printer on every fixture and example, and identical syntax diagnostics (codes and positions). Done 2026-09-05: the lexer, parser and printer in `self/` agree with the TypeScript front end on every source in the repository (the lexer on both targets), `self/fmt.onus` prints every source without syntax errors byte-for-byte as `onus fmt` does, and every tree walk is proved to terminate by a structural measure (docs/CHANGES.md items 126–138).
- *M15.2 — Checker in Onus.* Resolve, types, effects, const evaluation. Accept: identical diagnostic codes and spans across the fixture suite. Done 2026-09-05: `self/check.onus` runs loading, resolution, types, constant evaluation and effects and agrees with the TypeScript checker on every source in the repository (docs/CHANGES.md items 139–149).
- *M15.3 — Verifier and reports in Onus.* Contracts, SMT-LIB emission, z3 through the process capability, claims, capabilities, paths, the JSON reports. Accept: identical ledgers and reports. Done 2026-09-05: contracts, the verifier, claims, capabilities, paths and the §11.1, §9.1 and §13 documents are in `self/`, and `self/check.onus` agrees with the TypeScript compiler on every source in the repository — diagnostics as JSON objects, the ledger entry for entry, the interface and path documents byte for byte (docs/CHANGES.md items 150–159). Porting the verifier found and fixed a soundness bug in the TypeScript lowering of `inout` contracts and a precision gap in its `match` join; porting the reports found the parser diagnostics, the evaluator's messages and a deferred example that the earlier code-and-span differentials had let through. Not ported: the assumption ledger and test coverage tables the reports read (zero here), `ONUS_DUMP_SMT` (`--dump` instead) and contract mutation.
- *M15.4 — Codegen and CLI in Onus; fixed point.* The JavaScript emitter first, then native. Accept: the Onus compiler compiled by itself is byte-identical to itself compiled by the TypeScript compiler, and the fixture suite passes under it. The fixed point is checked by `scripts/bootstrap.sh`: stage0 (the TypeScript compiler until `bootstrap/` exists) builds `self/` into stage1, stage1 into stage2, stage2 into stage3, and stage2 must equal stage3 file for file. JavaScript target done 2026-09-06 (docs/CHANGES.md items 163–166): the form, the lowering, the JavaScript emitter and `emitAll` are in `self/`, the codegen differential agrees on every source, and the chain reaches the fixed point with stage1 (as the TypeScript compiler emits it) identical to stage2 and stage3. Verifying the port found two bugs in the TypeScript verifier (items 161 and 162: sort names colliding across modules, and type facts fanning out through recursive types). The native emitter followed the same day (item 167): `self/native.onus` agrees with `emitNative` on the LLVM IR and the E0800 diagnostics of every source. The command line followed (items 169–170): `self/cli.onus` provides `check`, `fmt`, `build` (JavaScript, native and wasm through `clang`), `run`, `interface` (with `--diff`) and `path`, agrees with the TypeScript command line on a fixed set of invocations (`test/self/cli.test.ts`), and `scripts/bootstrap.sh` builds the compiler with `onus build` at every stage. Remaining, with the TypeScript `onus` until M15.6: `test`, `review`, `loop` and `next`; and three small language changes the port exposed — an exit status chosen by `main`, a process primitive that inherits the standard streams, and a clock reading — made in M15.6.
- *M15.5 — A native compiler.* The aim: a platform-native `onus`, built by the compiler in Onus from its own source (`onus build self/cli.onus --target native`), that runs with neither TypeScript nor node and compiles any Onus program written with every language feature to date — checking, constant evaluation, verification with z3 through `io.run`, the reports, and both targets: JavaScript for the whole language, native for the §19.1 subset as this milestone extends it. Zones and views (CHANGE-LOG-03, -04) come after it. The delta, measured 2026-09-06 by building `self/cli.onus` for the native target: 481 of the compiler's functions refused, 461 of them for `Dict` or `Map`, 8 for `Text.trim`, `lower`, `len` and `graphemes`, 2 for `blake3_hex`, 1 for equality on a type parameter (`List.index_of`); and five primitives the emitted code calls that the C runtime lacks (`io.run`, `io.mkdir`, `Text.code_points`, `Text.of_code_points`, `Text.contains`). The compiler's source has no closures, function values or interfaces, so the native subset's largest gaps do not arise. Work, in order of size: (1) `Dict` and `Map` in the C runtime — insertion-ordered, keyed by `Int` and `Text`, `Map.put` copying — and the emitter representing them as pointers, which retires the `host.js` claim on `std.map`; (2) the five primitives, `io.run` over `posix_spawn` with pipes; (3) BLAKE3 in C, from the reference implementation; (4) grapheme segmentation and case mapping in C for `Text.graphemes`, `lower`, `len` and `trim`, since the constant evaluator must implement them faithfully for user programs — a rewrite avoids only the `trim` on z3 and `pg_config` output; (5) `List.index_of`'s equality on a type parameter, by the caller's concrete type or by monomorphising the intrinsic; (6) whatever a second census shows, the first reporting one cause per function. Accept: `onus build self/cli.onus --target native` produces an executable with no E0800; with node absent from PATH, that executable checks and builds every source in the repository with diagnostics, ledgers, JavaScript and LLVM IR identical to the node-hosted compiler's — the differentials under `test/self/` run against it; `scripts/bootstrap.sh` gains a native stage, the native `onus` building `self/cli.onus` for both targets with outputs equal to the node-hosted stage2's; and mandelbrot built by the native `onus` for the native target renders the same image. **The whole language natively (decided 2026-09-06).** The native target compiles every language feature built so far, not only what the compiler needs, so E0800 is left for what a host genuinely cannot provide. Beyond the census above that means, in the emitter: closures and function values (a closure is a code pointer with its captured environment; a declared function used as a value gets an adapter, as on the JavaScript target), interfaces (dictionary passing, which the lowering already does: a dictionary is a record of function pointers), quantifiers evaluated at runtime as loops, `fake` in test modules, `old(...)` snapshots in checked postconditions (a deep copy by type), equality and `TypeInfo` on values whose type is a type parameter, `Spec` values, and the small gaps (`try` on an `Option` inside a `Result` function without `else`, a row decoder over a non-record); in the C runtime, the JavaScript runtime's surface (115 functions today against a 2,300-line C runtime): the 22 primitives that still claim `host.js` — `Map`, `Text` (`bytes`, `compare`, `graphemes`, `len`, `lower`, `upper`, `starts_with`, `trim`, with Unicode tables), `Bytes`, `hash.blake3_hex`, `typeinfo.fields` and `name` — and `sql` through `libpq` as now. One design decision falls out of equality, `old` and `TypeInfo` on type parameters, since a slot carries no type: either the native lowering monomorphises generic functions per instantiation (the checker records every instantiation; each specialisation then knows its concrete types, and descriptors are constants) or values carry runtime type descriptors. Decided 2026-09-06: monomorphisation (§6.1), for the zero-cost representation and the Rust shape. It costs one language rule, made through the language-change process before the native lowering relies on it: polymorphic recursion — a generic function calling itself, directly or through others, at an instantiation that wraps one of its own type parameters — is a checker error on every target, since the set of specialisations would be unbounded (Rust and Go reject it likewise). The checker accepts it today; the fixture is a nested type `Nest[T] = Leaf of T | Node of Nest[Pair[T]]` with `depth[T]` calling `depth[Pair[T]]`. What is lost: nested data types whose type encodes a shape invariant, which Onus states as contracts instead — a perfect binary tree as a regular `Tree[T]` with `perfect` and `depth` predicates proves everything except the postcondition that establishes the shape, because the verifier reasons through contracts and never unfolds a body; a definitional axiom for functions with proved termination would close that (§12 open questions). Accept, in addition: every fixture and example that builds for the JavaScript target builds for the native target, its examples pass on both, and the §19.5 differential over the whole fixture suite reports no E0801. **Release (decided 2026-09-06).** The milestone ends with a released command-line compiler: a native `onus` executable for macOS (arm64 and x86_64), Linux (x86_64 and arm64) and Windows (x86_64). That adds: the standard library's sources, the C runtime (`onus.c`, `onus.h`, `onus_sql.c`) and the JavaScript runtime embedded in the executable as generated constants, so that `onus` needs no repository, no `--stdlib` and no `--runtime` — the loader reads `std.*` from the bundle when no `--stdlib` is given, a JavaScript build writes the runtime next to the program it emits and the launcher imports it from there, and a native build writes the C sources for `clang` (the emitted JavaScript changes by that import, so both compilers change under the process); a Windows port of the C runtime (process creation, paths, console and file names in UTF-8) and of anything platform-specific in the emitted IR; `onus --version`; a continuous-integration matrix that builds the compiler on each platform from `bootstrap/` (node and clang are dependencies of the build, not of the released binary) and publishes one archive per platform. On a machine with none of node, TypeScript or the repository, `onus check` and `onus build` work; `onus build --target native` and `onus run --target native` work with `clang` installed; z3 remains optional (§12: absent, every obligation is `checked` with one line on stderr). Windows builds are assumed to use `clang` with the MSVC linker; `wasm` is not part of the release.
- *M15.6 — The rest of the toolchain in Onus.* `test` (native examples and `--assumptions` and `--mutate` natively; the generated JavaScript tests keep vitest as a dependency of the tests, not of the compiler), `review`'s page renderer, `next`, and `loop`'s entry point; and the three language changes the command-line port exposed — an exit status chosen by `main`, a process primitive that inherits the standard streams, a clock reading — each made through `.claude/skills/language-change/SKILL.md` on the native compiler, which is the process's first exercise there (docs/CHANGES.md item 169). Accept: the TypeScript `onus` has no command the native one lacks; the three changes reached the fixed point through the process.
- *M15.7 — Retire the oracle.* The native fixed-point build of `self/` becomes `bootstrap/`, the stage0 of every later change; a fixture runner in Onus replaces vitest over the TypeScript library for the fixture suite; the TypeScript compiler, frozen since the M15.4 fixed point and kept in the tree with its differential tests until M15.6 has carried the process end to end on the native compiler (decided 2026-09-06), is removed. From here a language change is made in `self/` only. Accept: the fixture suite and the three examples pass under a compiler built from `bootstrap/` without invoking the TypeScript compiler; a deliberate change to an emitter in `self/` is caught by the stage comparison before promotion.

## 10. Testing conventions

- Fixtures are Onus source files with an adjacent `.expect.json` listing expected diagnostic codes (with spans) or expected obligation statuses. A test runner in `test/harness.ts` diffs actual against expected; no hand-written assertions per fixture.
- Every diagnostic code has at least one fixture that produces it.
- Every rule in the language spec that says "is a syntax error" or "is `E0xxx`" has a fixture.
- Property tests (fast-check) for the printer round-trip over a generated AST, and for effect containment.
- The three worked examples are integration tests run end to end at every milestone from M2 onward, with the expected results tightening as milestones land.

---

## 11. Conventions for the code

- No `any`, no non-null assertions, no `as` casts outside `syntax/ast.ts` constructors.
- Passes are pure over `Context`; no module-level mutable state.
- Errors from user programs are diagnostics; exceptions are compiler bugs. A caught exception in a pass becomes `E0999 internal error` with the stack in `context`, and a fixture is added.
- No reflection-style tricks in generated code or runtime; the generated TS should read as if a careful person wrote it.
- Function bodies in the compiler are expected to be model-written against signatures and doc-comment contracts written first. Keep signatures narrow and documented; this project is also the first test of its own thesis.
- The compiler's own source (`self/`) uses only what the previous fixed-point compiler accepts (stage0, `bootstrap/`; the TypeScript compiler until M15.5): a language feature is implemented in `self/` in one change and used there only in a later one. A change to `self/` is reviewed by its interface diff and its ledger delta, never by its bodies. The process is `.claude/skills/language-change/SKILL.md`.

---

## 12. Open implementation questions

- **Definitional unfolding in the verifier.** The verifier reasons about a call through the callee's contract and never its body, so a recursive predicate such as `perfect(t)` over a tree is opaque, and the postcondition that establishes a shape invariant comes back `checked`. A function whose termination is proved could be given a definitional axiom — one step of unfolding of its `match` body under a trigger — which would prove such postconditions from the definition. A §12 change; noted 2026-09-06, not scheduled.

- **Self-contained native backend.** The native target emits LLVM IR as text and spawns `clang` to compile and link it (M11), the GHC and Nim shape. The intended end state is Rust's: code generation in-process through LLVM as a library (or an own backend), with an external process only for the final link, so that the compiler in Onus depends on nothing it did not build. Decided 2026-09-06 as a direction; M15.5 makes the compiler itself native but still through `clang`; the in-process backend is not scheduled.

Recorded, to be settled in the milestone where they bite:

1. `Int` as `number` vs `bigint` (M5). Start with `number`; the ledger reports the ±2^53 assumption as a runtime-level `assume`.
2. `(Seq Int)` vs `(Array Int Int)` for sequences (M6). Try `Array` first.
3. How much of `std.sql`'s SELECT grammar to support in `parse_select` (M4). Enough for the two examples; reject everything else with a clear `ConstError`.
4. Whether the review tool should be a dependency-free page or use a small framework (M10). Dependency-free unless the diff view forces the issue.
5. Incremental checking to a cursor for `onus next` (M9). Acceptable to re-run the full pipeline on the prefix for v0.
