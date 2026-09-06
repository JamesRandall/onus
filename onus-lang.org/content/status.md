---
title: Status
lede: Dated truth. This page is what makes the rest credible; nothing on it is aspirational.
---

## Milestones

Dates are the commit that closed the milestone. The milestone definitions are in the [implementation plan](/spec/implementation/#9-milestones).

<div class="status">

| Milestone | State | Date |
|---|---|---|
| M1–M8 front end, types, effects, const evaluator, codegen, verification, reports; claims, capabilities, paths | <span class="st-done">done</span> | 3 September 2026 |
| M9 constrained decoding (`onus next`) | <span class="st-done">done</span> | 3 September 2026 |
| M10 review tool | <span class="st-done">done</span> — promotion drafts not built | 3 September 2026; assumption freshness 4 September |
| M11 native backend via LLVM | <span class="st-done">done</span> | 4 September 2026 |
| M12 targets complete: `sql` real on both targets, differential testing | <span class="st-done">done</span> — WebAssembly written, untested | 5 September 2026 |
| M13 contract mutation and obligation coverage | <span class="st-done">done</span> | 5 September 2026 |
| M14 regeneration loop (`packages/loop`) | <span class="st-done">done</span> — `watch`, production feedback and constrained decoding deferred | 5 September 2026 |
| M15.0 prerequisites: standard library for a compiler, recursion with proved measures | <span class="st-done">done</span> — native `Map`, `Process` capability and the stack-depth story deferred to the stages that need them | 5 September 2026 |
| M15.1 front end in Onus | <span class="st-done">done</span> — byte-identical to the TypeScript printer on every source | 5 September 2026 |
| M15.2 checker in Onus | <span class="st-done">done</span> — identical diagnostics on every source | 5 September 2026 |
| M15.3 verifier and reports in Onus | <span class="st-done">done</span> — ledgers, interface and path documents byte-identical; porting found a soundness bug and a precision gap in the TypeScript verifier, fixed in both | 5 September 2026 |
| M15.4 codegen and CLI in Onus; the fixed point | <span class="st-done">done</span> — `check`, `fmt`, `build`, `run`, `interface` and `path` in Onus; the compiler built by itself equals itself built by the TypeScript compiler, file for file | 6 September 2026 |
| M15.5 a native compiler: `onus` built by itself for the native target, the whole language natively, standard library and runtimes embedded, released | <span class="st-done">done</span> — Windows set aside for want of a machine | 6 September 2026 |
| M15.6 the rest of the toolchain in Onus | <span class="st-progress">in progress</span> — `io.now`, `io.exec`, `main`'s exit status and `onus test` done through the language-change process on the native compiler; `test --assumptions`, `test --mutate`, `review`, `next` and `loop` remain | 6 September 2026 |
| M15.7 retire the oracle: `bootstrap/` as stage0, a fixture runner in Onus, the TypeScript compiler removed | <span class="st-planned">planned</span> | — |
| Zones (change log 3, spec §21) | <span class="st-planned">specified, not built</span> — after M15.7 | specified 5 September 2026 |
| Views and the DOM (change log 4, spec §22) | <span class="st-planned">specified, not built</span> — after zones | specified 5 September 2026 |
| Task intake, telemetry, registry | <span class="st-planned">not specified</span> | — |

</div>

**5 September 2026.** Porting the verifier to Onus found a soundness bug in the TypeScript one: a callee's `ensures` about an `inout` parameter was lowered as a contradiction, so every obligation in a function that pushed to a builder was proved vacuously. Fixed in both, with fixtures.

**6 September 2026.** The compiler compiles itself natively. `onus build self/cli.onus --target native` produces an `onus` that needs neither node nor the repository, and the first release, v0.0.0, is on GitHub for macOS on Apple Silicon and Linux on x86_64 and arm64, installable with `brew install JamesRandall/onus/compiler`. The TypeScript compiler is frozen at the fixed point and kept as the oracle until the language-change process has been carried end to end on the native compiler; M15.7 removes it.

## The three worked examples

The examples exercise every mechanism in the language. Numbers below are read at build time from the review output checked in under `examples/`, so they are only as current as the last `onus review` run that was committed.

{{< example-ledgers >}}

## The loop

The regeneration loop has one benchmark task so far: regenerate `mandelbrot.escape_count` from its interface with the body elided. On 5 September 2026 Claude Code, DeepSeek V4 Flash and Kimi K2.7 Code wrote the body with invariant and measure on the first try; Sonnet 5 and GLM 5.3 Flash needed one repair after writing a bare `while`; Qwen3 Coder Next never converged in six iterations. The full log, with tokens and wall time per run, is `docs/BENCHMARK.md` in the repository.

## Specification changes

The specification is v0. The design had been taking shape for months; it was written down as a document on 2 September 2026 and has changed since: four change logs from its author (effects marked with `may`, the loop as a separate document and dual targets on 3 September; the testing model on 3 September; trust zones and views on 5 September) and {{< changes-count >}} numbered changes forced by implementation, each marked in the spec text and pinned by a fixture. All of them are on the [Changes](/spec/changes/) page.
