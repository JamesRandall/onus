# AGENTS.md — Onus

Onus is a programming language in which a model writes function bodies, a human reviews contracts, and the compiler is the only checker. This repository is the v0 compiler, runtime, standard library and review tool.

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
- **Structured diagnostics only.** Every user-facing error is a `Diagnostic` object with a code from `report/codes.ts`. Never `console.error` a message to the user. Text rendering is a view over the object.
- **Codes are never reused or renumbered.** Add new ones at the end of their range.
- **No `any`, no `!`, no `as` outside `syntax/ast.ts`.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` stay on.
- **Passes are pure over `Context`.** No module-level mutable state. A pass writes only its own tables.
- **User errors are diagnostics; exceptions are compiler bugs.** A caught exception becomes `E0999` and gets a fixture.
- **The AST is immutable after parsing.** Everything else lives in side tables keyed by `NodeId`.
- **The printer is the formatter.** There is exactly one canonical form. Never write a second pretty-printer.
- **The product output is JavaScript, in one step.** `onus build --emit ts` is a fixture-suite oracle only; its output must pass `tsc --strict` with no casts, and a failure there is a codegen bug. Never route users through it.
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

## Repository map

See `docs/onus-impl-spec-v0.md` §2. Short version:

- `packages/compiler` — the compiler and CLI (`onus check | build | run | fmt | interface | path | next`)
- `packages/runtime` — what generated code imports
- `packages/stdlib` — `std.*` written in Onus
- `packages/review` — the review tool, a static page over the JSON reports (last milestone)
- `packages/loop` — the regeneration loop of `docs/onus-loop-v0.md` (`onus loop run <task.json>`), which edits bodies only
- `examples/` — mandelbrot, reporting, checkout: the three worked examples from the spec, used as integration tests from milestone 2 onward

## Commands

```
pnpm install
pnpm -r build
pnpm -r test                 # all packages
pnpm --filter compiler test  # one package
pnpm onus check <file>       # after build
pnpm onus fmt <file>
```

`z3` must be on `PATH` for milestone 6 onward (`brew install z3` / `apt install z3`). Tests that need it are tagged and skipped with a notice if it is missing.

## Definition of done for a task

- The acceptance tests for the current milestone pass.
- Every new diagnostic code has a fixture.
- Every new public function has a signature comment with contracts.
- `pnpm -r test` and `pnpm -r build` are green.
- The summary lists: files changed, spec sections implemented, any spec changes opened, anything deliberately left `checked` rather than `proved` and why.

## When unsure

Stop and ask rather than guess, and say what you'd guess and why. Prefer questions of the form "the spec says X in §N, implementing it literally implies Y, is that intended?" over open-ended ones. Don't ask about things the spec already answers.
