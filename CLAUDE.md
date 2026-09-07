# CLAUDE.md — Onus

Onus is a programming language in which a model writes function bodies, a human reviews contracts, and the compiler is the only checker. This repository is the v0 compiler (written in Onus, under `self/`, and carried as the JavaScript it emitted for itself under `bootstrap/`), the runtimes, the standard library and the fixture suite.

## Read first

- `docs/onus-spec-v0.md` — the language specification. **Normative.** If code and spec disagree, the spec wins unless a spec change is made explicitly (see below).
- `docs/onus-impl-spec-v0.md` — the implementation plan: decisions, data structures, passes, milestones, acceptance tests. Follow the milestone order.
- `docs/CHANGE-LOG.md`, `docs/CHANGE-LOG-02.md`, … — dated changes the spec author makes to both documents, each saying what the codebase must do. Entries marked **(to apply)** are work; apply them in file order, then entry order, and flip the marker when done.

Read both before writing any code. When a task touches a language rule, quote the spec section in the commit message.

## Working method

This project is also the first test of its own thesis. Work as Onus expects its users to work:

1. **Signatures and contracts first.** Before implementing a function, write its signature and a doc comment stating preconditions, postconditions and effects (what it reads, what it mutates, what it may throw). Then implement the body.
2. **Tests are specs.** Every language rule gets a fixture before the code that enforces it. A diagnostic code with no fixture is unfinished.
3. **Milestones are gates.** Do not begin milestone N+1 with milestone N's acceptance tests failing. If a later milestone reveals an earlier design mistake, fix it in the earlier layer and re-run its tests; do not patch around it downstream.
4. **Small, reviewable changes.** One pass, one rule, or one fixture set per change. The human reviews interfaces and tests, not bodies; make that possible.

## Hard rules

- **No warnings.** Diagnostics are errors. Do not add a severity field, a warning level, or a "lint" concept anywhere.
- **Structured diagnostics only.** Every user-facing error is a `Diagnostic` record with a code from `self/codes.onus`. Never print a message to the user outside a diagnostic. Text rendering is a view over the record.
- **Codes are never reused or renumbered.** Add new ones at the end of their range.
- **No `any`, no `!`, no `as`** in the TypeScript that remains (`packages/runtime`). `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` stay on.
- **Passes are pure over `Context`.** No module-level mutable state. A pass writes only its own tables.
- **User errors are diagnostics; exceptions are compiler bugs.** A caught exception becomes `E0999` and gets a fixture.
- **The AST is immutable after parsing.** Everything else lives in side tables keyed by node id.
- **The printer is the formatter.** There is exactly one canonical form. Never write a second pretty-printer.
- **The product output is JavaScript or a native executable, in one step.** There is no intermediate TypeScript.
- **No reflection tricks** in the runtime or generated code. No `Proxy`, no `Function` constructor, no property-name string manipulation to reach private state. The `__fake` hook for test modules is the only exception and is gated by a compiler-emitted token.
- **Obligations are objects** with a status, from milestone 5 on. Never a boolean.
- **z3 is optional at runtime of the compiler.** Absence degrades every obligation to `checked` with one line on stderr; it is not a diagnostic.

## Changing the spec

The spec will be wrong in places; the grammar in §2.3 is explicitly provisional. When implementation shows a rule is unworkable or underspecified:

1. Do not silently deviate.
2. Open a change: edit `docs/onus-spec-v0.md`, mark the changed text with `<!-- changed: <reason> -->`, and record the change in `docs/CHANGES.md` with the milestone that forced it.
3. Add or update the fixtures that pin the new behaviour.
4. Say so in the summary you return, so the human reviews the spec change, not just the code.

Prefer the smallest change that resolves the problem. Do not "improve" the language while implementing it.

The full process for a language change — spec text, fixtures, contracts in `self/` before bodies, the bootstrap chain to a fixed point, acceptance under the new compiler, promotion — is the `language-change` skill in `.claude/skills/language-change/SKILL.md`. Follow it for every change to the spec, the grammar, a diagnostic code, a runtime primitive or a stdlib contract. The compiler's own source uses only what the previous fixed-point compiler accepts; a feature is implemented in `self/` in one change and used there only in a later one.

## Repository map

See `docs/onus-impl-spec-v0.md` §2. Short version:

- `self/` — the compiler in Onus: every pass, both emitters, the command line (`onus check | build | run | fmt | interface | path | next | review | test | loop`) and the fixture runner (`fixtures.onus`)
- `bootstrap/` — stage0: the compiler as the JavaScript it emitted for itself at the last fixed point, with its runtime; `node bootstrap/run_cli.js` is `onus`, and the chain (`scripts/bootstrap.sh`) rebuilds it from `self/`
- `packages/runtime` — what generated JavaScript imports, and the C runtime for the native target
- `packages/stdlib` — `std.*` written in Onus
- `test/` — the fixture suite: one directory per area with a `fixtures.json` manifest (impl spec §10)
- `docs/schema/` — the JSON schemas of the interface, diagnostic, path, task, change and proposal documents
- `examples/` — mandelbrot, reporting, checkout: the three worked examples from the spec, used as integration tests

## Commands

```
pnpm install
pnpm -r build                # the runtime (the compiler needs no build: bootstrap/ runs as is)
pnpm test                    # the fixture suite under bootstrap/ (scripts/fixtures.sh)
pnpm onus check <file>       # node bootstrap/run_cli.js
pnpm onus fmt <file>
scripts/bootstrap.sh         # the chain: self/ built by bootstrap/ to a fixed point, then natively
```

`z3` must be on `PATH` for verification (`brew install z3` / `apt install z3`) and `clang` for the native target; fixture sections that need one are skipped with a notice when it is missing.

## Definition of done for a task

- The acceptance tests for the current milestone pass.
- Every new diagnostic code has a fixture.
- Every new public function has a signature comment with contracts.
- `pnpm -r build`, `scripts/bootstrap.sh` and the fixture suite under its stage2 (`scripts/fixtures.sh`) are green.
- The summary lists: files changed, spec sections implemented, any spec changes opened, anything deliberately left `checked` rather than `proved` and why.

## When unsure

Stop and ask rather than guess, and say what you'd guess and why. Prefer questions of the form "the spec says X in §N, implementing it literally implies Y, is that intended?" over open-ended ones. Don't ask about things the spec already answers.
