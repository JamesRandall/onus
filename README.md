# Onus

A programming language in which a model writes function bodies, a human
reviews contracts, and the compiler is the only checker.

- `docs/onus-spec-v0.md` — the language specification (normative)
- `docs/onus-impl-spec-v0.md` — the implementation plan and milestones
- `docs/grammar-v0.md` — the grammar as implemented and the canonical form
- `docs/CHANGES.md` — spec changes forced by implementation

## Status

Milestones 1–2 done: lexer, parser, canonical printer, `onus fmt`; module
loading, name resolution and the type checker (`onus check` runs passes 1–4,
`--to <pass>` stops early). Later milestones per the implementation spec.

## Commands

```
pnpm install
pnpm -r build
pnpm -r test
pnpm onus check <file.onus> [--json] [--root <dir>] [--stdlib <dir>] [--to parse|canonical|resolve|types]
pnpm onus fmt <file.onus> [--stdout]
```
