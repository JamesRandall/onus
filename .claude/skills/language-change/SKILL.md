---
name: language-change
description: Apply a change to the Onus language (a CHANGE-LOG entry, or a spec problem found while implementing) through the spec, the fixtures, the compiler in Onus and the bootstrap chain, with the ledger and the interface diff of self/ as the review artefacts. Use for any change to docs/onus-spec-v0.md, docs/grammar-v0.md, a diagnostic code, a runtime primitive or a stdlib contract.
---

# Changing the language

Onus compiles itself. A change to the language is therefore a change to a
program, `self/`, that must keep compiling under the compiler that exists
before the change. The proof that a change is right is produced by the
compiler, not by a person reading bodies: the fixtures, the interface diff of
`self/`, the ledger delta of `self/`, and the bootstrap fixed point. Follow
the order below every time. Do not reorder it and do not skip a step because
the change is small.

## Vocabulary

- **stage0** — the last compiler that reached the fixed point, as the
  JavaScript it emitted for itself (`self/cli.onus` built with `onus build`),
  under `bootstrap/`, with the runtime it carries beside it. Until `bootstrap/` exists, stage0 is the TypeScript
  compiler (`pnpm onus`).
- **stage1** — `self/` after the change, compiled by stage0.
- **stage2** — `self/` compiled by stage1. **stage3** — `self/` compiled by stage2.
- **fixed point** — stage2 and stage3 are byte-identical, file for file.
- **the change** — one `CHANGE-LOG-NN.md` entry, or one problem found while
  implementing and recorded as one `docs/CHANGES.md` item. One change per
  pass through this skill.

## The order

### 1. Spec first

- Apply the entry's text to `docs/onus-spec-v0.md` (mark changed text with
  `<!-- changed: <date>, docs/CHANGES.md item N — <reason> -->`),
  `docs/grammar-v0.md` and `docs/onus-impl-spec-v0.md`. Add the
  `docs/CHANGES.md` item at the end, numbered after the last one. Flip the
  entry's marker from **(to apply)** to **(applied; …)** with the date.
- If implementing shows the entry is wrong or underspecified, edit the entry
  and the spec, and say so in the summary. Never deviate silently
  (`CLAUDE.md`, "Changing the spec"). Prefer the smallest change.
- A change that needs a new diagnostic code takes the next number at the end
  of its range in `packages/compiler/src/report/codes.ts`. Codes are never
  reused or renumbered. `self/codes.onus` is generated from it.

### 2. Fixtures before code

- One fixture per new or changed diagnostic code, one accepting fixture per
  new rule, under `packages/compiler/test/<area>/`, before any compiler code.
- New syntax gets a canonical-form fixture: the printer is the only formatter
  and there is exactly one canonical form.
- A rule with no fixture is unfinished. A code with no fixture is unfinished.

### 3. Contracts in `self/` before bodies

- Save the interface of every module the change will touch — bodies included,
  since the document carries the module's ledger and step 6 diffs it:
  `pnpm onus interface self/<m>.onus --json --root self > .onus/before/<m>.json`.
- Change signatures and contracts first: types, `requires`, `ensures`,
  effects, claims, `decreases`. Do not edit bodies yet.
- Produce the interface diff:
  `pnpm onus interface self/<m>.onus --json --diff .onus/before/<m>.json --root self`.
  This diff is what the human reviews. Bodies are not reviewed.

### 4. Bodies in `self/`, under the self-application rule

- Implement the bodies. The compiler's own source may use only the language
  **stage0** accepts. A feature lands in two changes: first implemented in
  `self/` without being used there, promoted to stage0; then, if wanted, used
  in `self/` as an ordinary change.
- A change that removes or tightens a rule first makes `self/` conform under
  the old rule: `self/` must check clean under both stage0 and stage1.
- A change to `packages/stdlib/std`, to the JavaScript runtime or to the C
  runtime regenerates what the compiler carries: `node scripts/bundle.mjs`
  rewrites `self/bundle.onus` (the runtime package built first), and
  `test/self/bundle.test.ts` fails until it is done.
- Check with stage0 as you go: `pnpm onus check self/check.onus --root self`
  (and per module while iterating). Every obligation of a changed function is
  `proved`, or `checked` with the reason written in the `CHANGES.md` item.

### 5. Bootstrap to the fixed point

- Build stage1 with stage0, stage2 with stage1, stage3 with stage2, and
  compare stage2 with stage3 byte for byte, file for file:
  `scripts/bootstrap.sh`. It builds `self/cli.onus` with `onus build` at
  every stage and stops at the first stage that reports a diagnostic.
- The native stage follows (M15.5): stage2 builds the compiler for the
  native target, and that executable, with neither node nor TypeScript on
  its path, must build the compiler for JavaScript to stage2's files and
  for the native target to the LLVM IR stage2 emitted for it. The script
  does this after the fixed point; a difference is a bug in the native
  backend or the runtime.
- A difference is a compiler bug or nondeterminism. Fix it in the compiler.
  Never edit emitted JavaScript or anything under `bootstrap/` by hand.

### 6. Acceptance, all under stage2

- The fixture suite passes under stage2.
- The differentials under `packages/compiler/test/self/` pass with the
  programs of `self/` running natively: `pnpm --filter compiler
  test:self-native` (`ONUS_SELF_NATIVE=1`), which builds each driver with
  `onus build --target native` and compares its lexing, parsing, printing,
  checking, verification, reports, code generation and command line against
  the TypeScript compiler on every source.
- `self/` verifies clean under stage2, and the ledger of `self/` is diffed
  against its pre-change ledger: obligations added, removed, and every status
  change. A regression from `proved` to `checked` in `self/` needs its reason
  in the `CHANGES.md` item; nothing pinned is re-pinned silently.
- The three examples build under stage2 and their emitted JavaScript agrees
  with stage0's, except for differences the change intends, which the
  `CHANGES.md` item lists.
- `pnpm -r build` and `pnpm -r test` are green.

### 7. Promote

- stage2 becomes `bootstrap/` (the next change's stage0). The human commits;
  the summary lists files changed, spec sections, the `CHANGES.md` item, the
  interface diff, the ledger delta and anything left `checked` and why.

## While the TypeScript compiler exists

Until M15.7 provides the fixture runner in Onus, the fixture suite and the
differential tests under `packages/compiler/test/self/` run over the
TypeScript library, so a language change is implemented in both compilers
and the differentials must agree on every source; `bootstrap/` is stage0 as
soon as it exists (M15.4 reached the fixed point on 2026-09-06). From M15.7
the TypeScript compiler is frozen: no language rule is added to it, and every
later change is made in `self/` only. It stays in the tree, with the
differential tests, until this process has been carried end to end on the
compiler in Onus building for the native target. Removing it, with a fixture runner in Onus in place of vitest
over the TypeScript library, is its own change (M15.7), never a side effect
of another.

## Never

- Implement in `self/` before the spec text and the fixtures exist.
- Use a new feature in `self/` in the change that introduces it.
- Edit emitted code or `bootstrap/` by hand, or "fix" a fixed-point
  difference by regenerating until it happens to agree.
- Add a warning, a severity or a lint to make a change easier to land.
- Land a change with a `self/` obligation that regressed without a reason.
- Retire or bypass the oracle in the middle of a change.
- Remove the TypeScript compiler before this process has been exercised on
  the native compiler in Onus.
