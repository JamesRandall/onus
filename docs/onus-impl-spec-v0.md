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
- *M15.3 — Verifier and reports in Onus.* Contracts, SMT-LIB emission, z3 through the process capability, claims, capabilities, paths, the JSON reports. Accept: identical ledgers and reports. In progress 2026-09-05: contracts, the verifier (which found and fixed a soundness bug in the TypeScript lowering of `inout` contracts and a precision gap in its `match` join), claims, capabilities and paths are in `self/` and agree with the TypeScript compiler on every source, ledger for ledger (docs/CHANGES.md items 150–155); the JSON reports remain.
- *M15.4 — Codegen and CLI in Onus; fixed point.* The JavaScript emitter first, then native. Accept: the Onus compiler compiled by itself is byte-identical to itself compiled by the TypeScript compiler, and the fixture suite passes under it.

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

---

## 12. Open implementation questions

Recorded, to be settled in the milestone where they bite:

1. `Int` as `number` vs `bigint` (M5). Start with `number`; the ledger reports the ±2^53 assumption as a runtime-level `assume`.
2. `(Seq Int)` vs `(Array Int Int)` for sequences (M6). Try `Array` first.
3. How much of `std.sql`'s SELECT grammar to support in `parse_select` (M4). Enough for the two examples; reject everything else with a clear `ConstError`.
4. Whether the review tool should be a dependency-free page or use a small framework (M10). Dependency-free unless the diff view forces the issue.
5. Incremental checking to a cursor for `onus next` (M9). Acceptable to re-run the full pipeline on the prefix for v0.
