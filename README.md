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

Milestones 1–11 done: lexer, parser, canonical printer, `onus fmt`; module
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
and native via LLVM IR and `clang` (`--target native`, §19), for the subset
in `docs/CHANGES.md` item 95; `onus test --target all` runs the examples on
both and reports disagreement as E0801. Effects are declared with `may`
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
