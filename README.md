# Onus

A programming language in which a model writes function bodies, a human
reviews contracts, and the compiler is the only checker.

- `docs/onus-spec-v0.md` — the language specification (normative)
- `docs/onus-impl-spec-v0.md` — the implementation plan and milestones
- `docs/grammar-v0.md` — the grammar as implemented and the canonical form
- `docs/CHANGES.md` — spec changes forced by implementation

## Status

Milestones 1–7 done: lexer, parser, canonical printer, `onus fmt`; module
loading, name resolution, the type checker, the check-time evaluator, the
effects pass, obligation objects and the z3-backed verifier (`onus check`,
`--ledger` shows every obligation's status; `--to <pass>` stops early);
JavaScript output with a runtime check for every obligation the verifier did
not prove, generated vitest files for examples, properties and laws, and
`onus build` / `onus run`; `onus interface` renders a module's interface
document (§11.1) as JSON or as canonical source with bodies elided. `z3`
must be on PATH for verification; without it every obligation is checked at
runtime. Later milestones per the implementation spec.

## Commands

```
pnpm install
pnpm -r build
pnpm -r test
pnpm onus check <file.onus> [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>] [--ledger] [--budget <ms>] [--no-cache]
pnpm onus interface <file.onus> [--json]
pnpm onus fmt <file.onus> [--stdout]
pnpm onus build <entry.onus> [--out <dir>] [--emit js|ts]
pnpm onus run <entry.onus> [--out <dir>] [-- args]
```
