# Onus

**A programming language for code that a model writes and a person has to trust.**

Onus is a language in which a model writes function bodies, a person reviews contracts, and the compiler is the only checker. It compiles to JavaScript or to native code through LLVM, from one lowering. The compiler is written in TypeScript and is being rewritten in Onus.

Website: [onus-lang.org](https://onus-lang.org) · Specification: [`docs/onus-spec-v0.md`](docs/onus-spec-v0.md)

```
pub fn recent_orders(
  db:  sql.Db[ReadOnly, schema: "orders"],
  who: auth.AuthedCustomer
) -> Result[List[Order], sql.Error] may sql.read, alloc
  ensures forall o: Order in result: o.customer == who.id
```

Read-only access to one schema, a caller who has already passed authentication (the type can only be produced by the auth module), no other effects, and every returned order belongs to that customer. The compiler proves the last line from the query itself. A reviewer reads this and moves on.

## Getting started

You need Node 22 or later, pnpm (`corepack enable` installs the pinned version), and `z3` on `PATH` for verification (`brew install z3` or `apt install z3`; without it every obligation is checked at runtime instead of proved). The native target additionally needs `clang`.

```
git clone https://github.com/JamesRandall/onus.git
cd onus
pnpm install
pnpm -r build
pnpm -r test
```

Then check and run a worked example:

```
pnpm onus check examples/mandelbrot/mandelbrot.onus --ledger   # every obligation and its status
pnpm onus run examples/mandelbrot/mandelbrot.onus              # writes mandelbrot.pgm
pnpm onus review examples/checkout/checkout.onus --out review  # the review page over the reports
pnpm onus run examples/mandelbrot/mandelbrot.onus --target native
```

The SQL tests need a Postgres at `ONUS_TEST_DSN` (`docker run -d -e POSTGRES_PASSWORD=onus -p 5432:5432 postgres:17`) and skip without one. The website in `onus-lang.org/` builds with Hugo: `cd onus-lang.org && hugo server`. The full command list is [below](#commands).

## The problem

Most of the effort in AI-assisted development now goes into steering: prompt wording, conventions documents, linters bolted on after the fact, and review that means reading every line the model produced. The specification of what the code must not do lives in prose, and prose is not enforced. When the model gets it wrong, someone notices — or doesn't — after the fact.

The root of it is the language. Current languages were designed so a human could write them quickly. They trade checkability for convenience at every turn: inferred types, implicit conversions, reflection, exceptions, ambient state. None of that convenience helps a model, and all of it hides things a reviewer needs to see.

The tools inherit the problem. A linter runs after the code exists and can only pattern-match what the language failed to say. A review tool shows a diff because there is nothing better to show. A prompt carries the rules because nowhere else can hold them. All of them try to catch problems after they exist, and none of them can see what the model was actually told. Fixing this starts at the language, but it does not end there: once the compiler knows what the code is allowed to do, the loop that drives the model, the ledger, and the review tool can be built on what it knows instead of on what it cannot see.

## What Onus does

Onus moves the constraints out of the prompt and into the compiler.

- **Pure by default.** A function that can touch a file, the network, or a database says so in its signature, and the compiler proves that nothing beneath it does anything it didn't declare.
- **Authority is handed down, never acquired.** Access to a resource is a value that only the program's root can create and that can only be narrowed on the way to the code that uses it. A function that receives a read-only database handle cannot write, because it has nothing to write with.
- **Contracts are checked, not commented.** Preconditions, postconditions and invariants are part of the language. Each one ends up in exactly one of three states — proved by the compiler, checked at runtime, or explicitly assumed — and the compiler tells you which.
- **Critical paths are declared once.** A `path` declaration states what a section of the program may do, and the compiler checks every function reachable from it. If the path declaration is right and the program compiles, the bodies don't matter.
- **Everything the reviewer needs is in the interface.** Signatures, contracts, effects, examples, assumptions. Bodies are the model's problem. The review tool shows what you are trusting, where each guarantee bottoms out, and what changed — without a source diff.
- **One compiler, no linter.** There are no warnings and no configurable rule sets. A convention that matters becomes a claim or a path rule and is checked like everything else.
- **Projects grow by zone.** New code starts as `draft`, where interfaces change freely and nothing is authoritative, next to a core that is already `hardened` or `critical`. The compiler keeps the core from depending on anything the draft has not yet hardened, and a module moves up only by earning it: its bodies are regenerated from its interfaces alone, and anything that does not come back was never written down.

## Not just a language

The language is the root, and it is the smaller half. Around it sits the environment: the loop that drives the model, the ledger the compiler writes, and the workbench a person reviews in. Each exists because the compiler knows what the code is allowed to do, and none of them guesses.

1. **A person writes the claims.** Signatures, contracts, effects, capabilities, paths, and each module's zone. This is the whole specification, and it is the only thing a person writes. If a convention matters, it is a claim; if it is not a claim, nothing downstream knows about it.
2. **The model writes bodies, inside the claims.** The loop drives the model against the compiler. It sees interfaces and diagnostics, never a conventions document. It edits bodies and never claims, and the module's zone decides what it may touch at all. When a contract cannot be met it stops and proposes, rather than weakening anything to get green.
3. **The compiler checks everything, once.** Every obligation ends proved, checked at runtime, or assumed, and the ledger records which, with every assumption's justification and where every capability came from. There is no linter and no second analysis: nothing runs after the fact to catch what the language failed to say.
4. **A person reviews claims, not diffs.** The workbench renders the ledger, path reports and interface diffs, and computes nothing of its own. Approvals, contract edits and answers to counterexamples return to the loop as tasks. A module earns promotion to a stricter zone by regenerating cleanly from its interfaces alone.

Those four stages run once per change. **Zones** run across the project's whole life, and each module moves through them on its own. A module starts as `draft`, is promoted to `hardened` when it goes into service and to `critical` when it becomes load-bearing, each step earned by regenerating its bodies from its interfaces and finding nothing missing. Nothing forces the project to move together: a subsystem being sketched sits beside a core that is already critical, the compiler refuses to let the core depend on anything the sketch has not yet hardened, and a module that needs rework is demoted alone, with everything that rested on it marked conditional until it earns its way back.

## One example

A team's conventions document says: *reporting code must never write to the database.* Today that lives in a prompt, a checklist, and a reviewer's memory. In Onus it is the function's own signature:

```
pub fn monthly_totals(db: sql.Db[ReadOnly], year: Int)
  -> Result[List[MonthlyTotal], sql.Error] may sql.read, alloc
```

`may sql.read, alloc` is the complete list of what this function may do, and everything it calls must fit inside it. The model, asked to add run logging, writes an `insert` into a helper the report calls. The build fails before anyone sees it:

```
reporting.onus:17:3: E0201 undeclared effect
  in monthly_totals
  calling `log_run` has effect `sql.write`, which `monthly_totals` does not declare
```

The model reads the diagnostic, moves the logging to the caller that holds write access, and the build is green. No prompt was edited, no reviewer read a diff, and the rule cannot be forgotten by the next model or the next person, because it is not advice — it is the function's type. For rules a signature can't express, a `path` declaration applies the same check over every function reachable from an entry point.

## Status

Dated truth lives at [onus-lang.org/status](https://onus-lang.org/status/) and in [`docs/onus-impl-spec-v0.md` §9](docs/onus-impl-spec-v0.md). In short, as of 5 September 2026:

- **Milestones 1–14 are done.** The TypeScript compiler has the front end and canonical printer (`onus fmt`); module loading, name resolution, the type checker, the check-time evaluator and the effects pass; obligation objects and the z3-backed verifier (`onus check`, with `--ledger` showing every obligation's status and `--to <pass>` stopping early); claims, capability rules and `path` checking with `onus path` reports; `onus interface` (and `--diff`); `onus next` for constrained decoding; `onus review`, which writes the review page over the interface, path and diagnostics reports; and `onus test`, which runs the generated tests, records obligation coverage, runs `verify` blocks with `--assumptions`, and with `--mutate` reports contract weakenings no example detects as `M0001` rows.
- **Two targets from one lowering.** JavaScript, with a runtime check for every obligation the verifier did not prove, and native code via LLVM IR and `clang` (`--target native`; `--target wasm` with a WASI SDK is written but untested). `onus test --target all` runs the examples on both and reports disagreement as `E0801`. `std.sql` is real on both, over `pg` and `libpq`; the SQL tests use a Postgres at `ONUS_TEST_DSN` (by default `docker run -d -e POSTGRES_PASSWORD=onus -p 5432:5432 postgres:17`) and skip without one.
- **The regeneration loop** of `docs/onus-loop-v0.md` lives in `packages/loop`: `onus loop run <task.json>` writes function bodies against the compiler, edits nothing else, and opens a change under `.onus/changes/` that the review page shows. Models are Claude Code (`--model claude-code`), the Anthropic API (`--model anthropic`), OpenRouter (`--model openrouter[:<model>]`) or a scripted answer file. Keys go in `.env.local` at the repository root (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, optionally `OPENROUTER_MODEL`); `node packages/loop/bench/run.mjs mandelbrot <model-spec>... --append docs/BENCHMARK.md` logs a run per model in `docs/BENCHMARK.md`.
- **Milestone 15, the compiler in Onus, is in progress.** The front end (`self/`: lexer, parser, canonical printer and `fmt`) is byte-identical to the TypeScript front end on every source; the checker (loading, resolution, types, constant evaluation, effects), the verifier (contracts, lowering to SMT-LIB, z3 through the `Process` capability, claims, capabilities and paths) and the reports (interface, path and diagnostic documents) agree with the TypeScript compiler on every source: diagnostics, the ledger entry for entry, the documents byte for byte; every walk is proved to terminate. Porting the verifier found a soundness bug in the TypeScript one (a callee's `ensures` about an `inout` parameter was a contradiction, so every obligation in a function that pushed to a builder was proved vacuously) and fixed it in both. Code generation and the CLI remain.
- **Zones** are specified (`docs/CHANGE-LOG-03.md`) and not yet implemented.

Effects are declared with `may` (`-> Int may alloc`). `z3` must be on `PATH` for verification; without it every obligation is checked at runtime.

## Repository

- `docs/onus-spec-v0.md` — the language specification (normative)
- `docs/onus-impl-spec-v0.md` — the implementation plan and milestones
- `docs/grammar-v0.md` — the grammar as implemented and the canonical form
- `docs/CHANGES.md` — spec changes forced by implementation
- `docs/CHANGE-LOG.md`, `docs/CHANGE-LOG-02.md`, `docs/CHANGE-LOG-03.md` — changes made by the spec author, dated, with what the codebase must do about each; applied in file order
- `docs/onus-loop-v0.md` — the regeneration loop
- `docs/onus-pitch.md` — the pitch
- `docs/BENCHMARK.md` — the loop benchmark log
- `packages/compiler` — the compiler and CLI
- `packages/runtime` — what generated code imports
- `packages/stdlib` — `std.*`, written in Onus
- `packages/review` — the review tool, a static page over the JSON reports
- `packages/loop` — the regeneration loop
- `self/` — the compiler in Onus
- `examples/` — mandelbrot, reporting, checkout: the three worked examples from the spec, used as integration tests
- `onus-lang.org/` — the website, a Hugo site that mounts the documents and examples above so it never carries a stale copy

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
pnpm onus loop run <task.json>
```

The website builds with `cd onus-lang.org && hugo server`.

## License

[MIT](LICENSE).
