# Onus compared

Onus is assembled from ideas that already exist. This page says where each came from, what Onus takes, and where it differs. It is written to be fair; if you maintain one of these projects and think it isn't, the repository accepts corrections.

*Descriptions of other projects are as of September 2026 and based on their public documentation. They change; this page will lag.*

---

## Rust

**What it is.** A systems language whose central idea is ownership: every value has one owner, borrowing is checked, and memory safety follows without a garbage collector.

**What Onus takes.** The observation that if nothing aliases, most of the hard problems in reasoning about code disappear. Onus goes further than Rust — there are no references at all, only values, `inout` parameters that cannot escape, and freeing at scope exit — and gets local reasoning without a borrow checker for the model to satisfy. Rust's diagnostics are also the standard Onus measures its own against.

**Where it differs.** Rust is designed for a human author and optimised for control; Onus is designed for a model author and optimised for what a reviewer can check. Rust has no contracts, no effect system, and `unsafe` as its only trust boundary. Onus has all three and treats `assume` as the one place trust leaks in.

---

## F#

**What it is.** A functional-first language for .NET, designed by Don Syme: discriminated unions, records, pattern matching, immutability by default, type providers, units of measure.

**What Onus takes.** The data model, almost exactly: unions with `of`, `match ... with` and `when` guards, `{ x with ... }` record update. These are the best designs available for describing data, and a model's prior for them is right. Type providers — libraries that run at compile time and produce types the compiler checks — are the ancestor of Onus's `const fn` checkers.

**Where it differs.** Deliberately everything else. F# infers types, curries, pipelines, and uses layout-sensitive syntax, all of which serve a human writing quickly. Onus requires every annotation, names every argument, has no currying and explicit braces, so that a body does not read as F# and F#'s habits are not triggered in a model writing it. Onus's spec calls this the borrowing policy: take the semantics, not the silhouette.

---

## Dafny

**What it is.** A verification-aware language from Microsoft Research: pre- and postconditions, loop invariants, termination measures, all discharged by an SMT solver at compile time.

**What Onus takes.** The contract vocabulary and the discipline — `requires`, `ensures`, `invariant`, `decreases`, `old()` — and the idea that a program's specification is checked, not commented. Dafny is the proof that this works on real code.

**Where it differs.** Dafny is a proof system first and a language second; when an obligation can't be proved, the program is rejected. Onus makes proved, checked-at-runtime and assumed three explicit states, reports which each obligation is in, and lets a program ship with checked obligations as long as the ledger says so. Dafny has no effect system, no capabilities, and no notion of trust changing over a project's life. It also assumes a human is writing the annotations; Onus assumes a model is, which is why it can afford to require more of them.

---

## Zero (Vercel Labs)

**What it is.** A language for agent-written code where effects are capabilities: a function's signature declares what "world" it can touch, and the compiler enforces it. Structured diagnostics with repair plans. The best-known project in the space.

**What Onus takes.** The capability-as-parameter idea is the same one Onus uses, arrived at independently from the object-capability tradition. Zero's diagnostics format — stable codes, typed repair plans — is a model for what Onus's should be.

**Where it differs.** Zero stops at effects. It has no contracts, no verification, no way to say what a function does beyond what it may touch. That fits its purpose, which is agents writing glue code safely; it is not a language for trusting a codebase. Onus adds contracts, refinements, paths, the ledger and zones on top of the same capability idea.

---

## MoonBit

**What it is.** A language positioned as AI-native since 2022, with a production toolchain, WebAssembly and native backends, and a grammar shaped for linear token generation: mandatory top-level annotations, flattened scope.

**What Onus takes.** The premise that the grammar should serve the decoder, and the discipline of mandatory annotations. MoonBit's toolchain maturity is a reminder of how much work sits between a spec and something usable.

**Where it differs.** MoonBit's constraints are syntactic; it has no mechanism for the compiler to catch what the model gets wrong semantically. Onus treats the grammar as the least interesting layer and puts the weight on contracts, effects and the ledger.

---

## Thermite, Vera, Vow and the verification projects

**What they are.** A cluster of small 2026 projects — mostly single-author — that require contracts on every function and discharge them with Z3, Verus, ESBMC or Lean, with runtime fallback. Thermite reports per-obligation status much as Onus does.

**What Onus takes.** The confirmation that several people arrived at the same place: contracts mandatory, verification with fallback, status visible. Thermite's per-obligation ledger is the closest existing thing to Onus's.

**Where it differs.** These are languages; Onus is a language plus an environment. None of them has an effect system alongside contracts, a capability model, paths over reachable code, zones, a specified loop, or a review tool. Most have no story for what a reviewer reads. Onus's bet is that the language is the smaller half of the problem.

---

## TypeScript

**What it is.** The language most model-written code is currently produced in, and Onus's first target.

**What Onus takes.** Nothing in the design; the JS backend exists so Onus runs everywhere TypeScript does, and so the compiler could be built quickly.

**Where it differs.** TypeScript is the case study for why Onus exists: inference, `any`, structural typing, exceptions, ambient access to everything, and a linter ecosystem carrying every rule the language couldn't state. It is an excellent language for its purpose. Its purpose was a human typing fast.

---

## What is not on this page

Lean, Idris and Agda, which are proof assistants with programming languages attached and aim at a different problem; Koka and Frank, which have the effect systems Onus's is descended from but no contracts; SPARK, which is closest to Onus in temperament and has thirty years of use in safety-critical systems, and which Onus has read carefully. None is a competitor; all are sources.
