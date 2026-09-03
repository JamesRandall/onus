# Onus

A programming language in which a model writes function bodies, a human
reviews contracts, and the compiler is the only checker.

- `docs/onus-spec-v0.md` — the language specification (normative)
- `docs/onus-impl-spec-v0.md` — the implementation plan and milestones
- `docs/grammar-v0.md` — the grammar as implemented and the canonical form
- `docs/CHANGES.md` — spec changes forced by implementation

## Status

Milestones 1–5 done: lexer, parser, canonical printer, `onus fmt`; module
loading, name resolution, the type checker, the check-time evaluator, the
effects pass and obligation objects (`onus check`; `--to <pass>` stops early);
JavaScript output with every obligation checked at runtime, generated vitest
files for examples, properties and laws, and `onus build` / `onus run`.
Later milestones per the implementation spec.

## Commands

```
pnpm install
pnpm -r build
pnpm -r test
pnpm onus check <file.onus> [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>]
pnpm onus fmt <file.onus> [--stdout]
pnpm onus build <entry.onus> [--out <dir>] [--emit js|ts]
pnpm onus run <entry.onus> [--out <dir>] [-- args]
```
