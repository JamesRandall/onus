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
| M15.3 verifier and reports in Onus | <span class="st-progress">in progress</span> — verifier, claims, capabilities and paths agree ledger for ledger; the JSON reports remain | 5 September 2026 |
| M15.4 codegen and CLI in Onus; the fixed point | <span class="st-planned">planned</span> | — |
| Zones (change log 3, spec §21) | <span class="st-planned">specified, not built</span> | specified 5 September 2026 |
| Task intake, telemetry, registry | <span class="st-planned">not specified</span> | — |

</div>

**5 September 2026.** Porting the verifier to Onus found a soundness bug in the TypeScript one: a callee's `ensures` about an `inout` parameter was lowered as a contradiction, so every obligation in a function that pushed to a builder was proved vacuously. Fixed in both, with fixtures.

## The three worked examples

The examples exercise every mechanism in the language. Numbers below are read at build time from the review output checked in under `examples/`, so they are only as current as the last `onus review` run that was committed.

{{< example-ledgers >}}

## The loop

The regeneration loop has one benchmark task so far: regenerate `mandelbrot.escape_count` from its interface with the body elided. On 5 September 2026 Claude Code, DeepSeek V4 Flash and Kimi K2.7 Code wrote the body with invariant and measure on the first try; Sonnet 5 and GLM 5.3 Flash needed one repair after writing a bare `while`; Qwen3 Coder Next never converged in six iterations. The full log, with tokens and wall time per run, is `docs/BENCHMARK.md` in the repository.

## Specification changes

The specification is v0 and has changed since it was written on 2 September 2026: three change logs from its author (effects marked with `may`, the loop as a separate document and dual targets on 3 September; the testing model on 3 September; trust zones on 5 September) and 155 numbered changes forced by implementation, each marked in the spec text and pinned by a fixture. All of them are on the [Changes](/spec/changes/) page.
