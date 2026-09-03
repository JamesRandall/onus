# CHANGES.md — Onus specification changes

Changes to `onus-spec-v0.md` and `onus-impl-spec-v0.md` made since the implementation started. Apply in order. Each entry states what changed, why, and what to do in the codebase. Entries marked **(applied to docs)** are already in the spec files; entries marked **(to apply)** need the spec text added as well as the code.

---

## 2026-09-03 — Effect marker `!` replaced by `may` **(applied to docs)**

**Change.** The effect list after a return type is introduced by the keyword `may` instead of `!`. `may` is a reserved word.

```
fn main(args: List[Text], files: io.Files) -> Result[Unit, io.Error] may io.file, alloc
fn map[T, U, e](xs: List[T], f: fn(T) -> U may e) -> List[U] may e, alloc
```

Grammar (§2.3): every `[ "!" effects ]` is now `[ "may" effects ]` — in `fn_decl`, `type` (function types), `iface_item`, and the closure form of `primary`. `Stream[T] may e` likewise.

**Why.** `!` reads as "not" in every language a model knows; `may` reads correctly for every effect (may allocate, may panic, may write) and states the declaration as the claim it is.

**Codebase.** Lexer: add `may` to keywords; `!` is no longer a token outside `!=`. Parser: four productions. Printer: emit `may`. All fixtures and the three examples updated. No semantic change.

---

## 2026-09-03 — Regeneration loop specified as a separate document **(applied to docs)**

**Change.** `docs/onus-loop-v0.md` added. It is a candidate spec for the component that drives the model against the compiler. It does not change the language.

**Codebase.** Nothing now. It depends on the compiler's JSON outputs (§9.1, §11.1, §13) being stable and on `onus next` (M9), which are already in the plan. Do not start on it until M10 is done.

---

## 2026-09-03 — Targets: dual backends as a design goal **(applied to docs; code from M11)**

**Change.** Onus programs compile to JavaScript and to native code from the same source, and later to WebAssembly. This is a stated goal, not an accident of architecture, and it adds a section to the language spec and two milestones to the implementation spec.

### Language spec: new §19 "Targets" (insert after §18 Worked examples)

> ## 19. Targets
>
> An Onus program compiles unchanged to every supported target. Observable behaviour is defined by this specification, never by the host. Where this specification is silent on something a program can observe, that is a defect in the specification.
>
> ### 19.1 Runtime primitive surface
>
> Each target provides a runtime implementing exactly the following primitives. Everything else in `std.*` is written in Onus and compiled by the same backend as user code.
>
> - Memory: allocate, free-at-scope-exit (native) or no-op (collected hosts).
> - `Int`: 64-bit signed arithmetic with overflow detection; see 19.3.
> - `Float`: IEEE 754 binary64 arithmetic; `classify`; formatting to text per the algorithm in `std.float` (shortest round-trip representation).
> - `Text`: UTF-8 storage; grapheme-cluster segmentation per Unicode 16.0 (pinned; the runtime carries the tables); byte and grapheme views; equality by code point sequence.
> - `Bytes`: contiguous byte sequence with bounds-checked access.
> - Panic: raise with an obligation id and optional model; `recover` boundary.
> - Capabilities: opaque handles for `io.Files`, `io.Env`, `io.Net`, `io.Clock`, `io.Rand`, `sql.Db`, plus the `__fake` constructor available only to test modules.
> - `io.*` and `sql.*` raw calls, each mapped one-to-one from an `assume` leaf in `std.io` / `std.sql`.
>
> The primitive surface is versioned with the specification. A backend that lacks a primitive reports `E0800 primitive unavailable on target` at build time for any program reaching it.
>
> ### 19.2 Host claims
>
> Code that can only run on one host declares it with a claim: `host.js`, `host.native`, `host.wasm`. These are asserted claims (§7.1) introduced only at `assume` leaves that call host-specific facilities, and they propagate like any claim. A `path` may `forbid { host.js, host.native, host.wasm }` to require portability, and the compiler then rejects anything reachable that depends on a host.
>
> ### 19.3 Integer representation
>
> `Int` is 64-bit signed on every target. On targets without native 64-bit integers (JavaScript), the backend chooses a representation per value: a double-precision number where the verifier has proved `|x| <= 2^53 - 1` for every value the binding can hold, and an arbitrary-precision integer otherwise. The choice appears in the ledger as an obligation of kind `representation`, so a reviewer can see which values are running on the slow path and tighten refinements to move them.
>
> ### 19.4 Fully specified behaviour
>
> The following are specified so that all targets agree: `Map` iteration is in key order under `Ord[K]`; integer division truncates toward zero and `%` takes the sign of the dividend; `Float` to `Text` is the shortest round-trip form; `example` blocks run in source order; `Stream` elements are produced on demand and never buffered beyond one element by the runtime.
>
> ### 19.5 Differential testing
>
> Every `example` and `property` runs on every built target. Any disagreement between targets on a program the compiler accepted is a backend defect, reported as `E0801 target disagreement` with the example, the two results and the targets.

### Language spec: §17 Open questions

Add: *Concurrency, when designed, must fit both a single-threaded event-loop host and a native multi-threaded one; structured concurrency over immutable inputs with channels by value is the working assumption.*

### Implementation spec: decisions table

Add a row:

| Native target | LLVM IR text emitted by the compiler; `clang` assembles and links against a small C runtime | Own lowering (semantics stay ours), borrowed instruction selection and optimisation; nothing to install beyond Xcode CLT / `clang` on Linux |

Add to §6 Codegen: the codegen pass has two emitters behind one interface, `emit(ctx, target)`. The lowering from checked AST plus obligation statuses to a target-neutral form is shared; only the final emission differs. Do not duplicate lowering logic per target.

### Implementation spec: milestones

**M11 — Native backend.** LLVM IR emitter; C runtime for the 19.1 primitive surface (no `sql` yet); `onus build --target native` produces an executable via `clang`. `proved` obligations emit no code; `checked` obligations emit compare-and-branch to `onus_panic` with the obligation id; `recover` via `setjmp`/`longjmp`. `Int` is `i64` with `llvm.*.with.overflow` intrinsics. Accept: Mandelbrot builds natively and writes an identical PGM to the JS build; every `example` passes on both targets; `E0801` fires on a deliberately broken runtime primitive.

**M12 — Targets complete.** `sql` primitives in the C runtime over `libpq`; host claims; `Int` representation obligations in the JS backend; differential test harness running all fixtures on both targets; WebAssembly emission via the same LLVM path (`--target wasm`), with `io.*` mapped to WASI. Accept: all three examples build and agree on both native and JS; the reporting example runs natively against Postgres; a `path` with `forbid { host.js }` rejects a JS-only `assume` leaf.

**Codebase now.** Nothing changes before M10. When starting M11: the shared lowering in `codegen/` is the design constraint — if the JS emitter has lowering logic tangled into emission, separate it first, and add a fixture set for the target-neutral form.

---

## 2026-09-03 — Documents added, no spec impact

- `docs/onus-pitch.md` — a short pitch. Its example uses `E0201` on a `may sql.read, alloc` signature; if the compiler's `E0201` text ends up different from the illustrative one, the pitch follows the compiler, not the reverse.

---

## Not changed, but decided

- The syntax borrows F#'s data model only (unions with `of`, `match ... with`, `when`, `{ x with ... }`) and is deliberately not F# elsewhere. Already in §2 "Borrowing policy". Do not import F# conventions the spec does not name.
- Product output is JavaScript in one step; `--emit ts` is a fixture-suite oracle only. Already in the implementation spec and CLAUDE.md.
- The compiler is the only checker. No warnings, no lint, ever.
