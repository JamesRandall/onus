# Onus

A programming language in which a model writes function bodies, a human
reviews contracts, and the compiler is the only checker.

- `docs/onus-spec-v0.md` — the language specification (normative)
- `docs/onus-impl-spec-v0.md` — the implementation plan and milestones
- `docs/grammar-v0.md` — the grammar as implemented and the canonical form
- `docs/CHANGES.md` — spec changes forced by implementation
- `docs/CHANGE-LOG.md`, `docs/CHANGE-LOG-02.md` — changes made by the spec author, dated, with what the codebase must do about each; applied in file order
- `docs/onus-loop-v0.md` — the regeneration loop, a candidate spec for the component that drives the model against the compiler
- `docs/onus-pitch.md` — the pitch

## Status

Milestones 1–14 done, and of 15 the prerequisites stage, the front end in Onus (`self/`: lexer, parser, canonical printer and `fmt`, byte-identical to the TypeScript front end on every source) and the checker in Onus (loading, resolution, types, constant evaluation and effects, agreeing with the TypeScript checker on every source), every walk proved to terminate: lexer, parser, canonical printer, `onus fmt`; module
loading, name resolution, the type checker, the check-time evaluator, the
effects pass, obligation objects and the z3-backed verifier (`onus check`,
`--ledger` shows every obligation's status; `--to <pass>` stops early);
JavaScript output with a runtime check for every obligation the verifier did
not prove, generated vitest files for examples, properties and laws, and
`onus build` / `onus run`; `onus interface` renders a module's interface
document (§11.1) as JSON or as canonical source with bodies elided; claims,
capability rules and `path` checking with `onus path` reports (§9.1);
`onus next` gives the legal next tokens, expected type and names in scope
at an offset (§14); `onus review` writes the review page (§15) over the
interface, path and diagnostics reports, and `onus interface --diff`
compares two interface documents; `onus test` runs the generated tests, and
`onus test --assumptions` runs `verify` blocks against an environment module
and records the ledger the reports and `policy verified_assumptions_only`
read (§20). Code generation is one lowering with two emitters: JavaScript,
and native via LLVM IR and `clang` (`--target native`, §19; `--target wasm`
with a WASI SDK), for the subset in `docs/CHANGES.md` item 95; `onus test
--target all` runs the examples on both and reports disagreement as E0801.
`std.sql` is real on both targets, over `pg` and `libpq`; the SQL tests use a
Postgres at `ONUS_TEST_DSN`, by default `docker run -d -e
POSTGRES_PASSWORD=onus -p 5432:5432 postgres:17`, and skip without one.
`onus test` records which checked obligations the tests reached and reports
obligation coverage (§20.5) in `interface.json`, `path.json` and the review
page; `onus test --mutate` weakens contracts one at a time and reports the
weakenings no example or property detects as `M0001` rows (§20.4).
The regeneration loop of `docs/onus-loop-v0.md` lives in `packages/loop`:
`onus loop run <task.json>` writes function bodies against the compiler,
edits nothing else, and opens a change under `.onus/changes/` that the
review page shows; models are Claude Code (`--model claude-code`), the
Anthropic API (`--model anthropic`), OpenRouter (`--model
openrouter[:<model>]`) or a scripted answer file. Keys go in a `.env.local`
at the repository root (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
optionally `OPENROUTER_MODEL`), which is ignored by git and read by the
loop; `ONUS_LOOP_LIVE=1 ONUS_LOOP_MODEL=openrouter pnpm --filter
@onus/loop test` runs the live Mandelbrot case against it, and
`node packages/loop/bench/run.mjs mandelbrot <model-spec>... --append
docs/BENCHMARK.md` logs a run per model in `docs/BENCHMARK.md`. Effects are declared with `may`
(`-> Int may alloc`). `z3`
must be on PATH for verification; without it every obligation is checked at
runtime.

## Commands

```
pnpm install
pnpm -r build
pnpm -r test
pnpm onus check <file.onus> [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>] [--ledger] [--budget <ms>] [--no-cache]
pnpm onus interface <file.onus> [--json]
pnpm onus path <file.onus> [<name>] [--json]
pnpm onus next <file.onus> --offset <n> [--json]
pnpm onus interface <file.onus> --diff <old-interface.json> [--json]
pnpm onus review <entry.onus> [--out <dir>] [--against <old-interface.json>]
pnpm onus test <entry.onus> [--out <dir>] [--target js|native|all]
pnpm onus test <entry.onus> --assumptions [--env <test_module.onus>] [--target <name>]
pnpm onus fmt <file.onus> [--stdout]
pnpm onus build <entry.onus> [--out <dir>] [--emit js|ts|ir] [--target js|native]
pnpm onus run <entry.onus> [--out <dir>] [--target js|native] [-- args]
```
