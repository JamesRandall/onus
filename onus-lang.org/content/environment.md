---
title: Environment
lede: Onus is a language plus an environment. The language is the smaller half.
---

The bet is that trusting model-written code is not solved by a language alone. It takes nine parts, each of which owns one thing and reduces one burden on the person reviewing. Solid boxes are built; dashed ones are specified but not built; dotted ones are intentions.

<svg class="env-map" viewBox="0 0 900 380" role="img" aria-label="The nine parts of the Onus environment: task intake feeds the loop; the loop drives the compiler; the compiler writes the ledger; the ledger is published to the registry and rendered by the review tool, whose decisions return to the loop as tasks; telemetry from production feeds task intake; targets sit beneath the compiler; zones cut across everything.">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#3C3F52"/></marker></defs>
  <rect class="band" x="20" y="20" width="860" height="40" rx="6"/><text x="450" y="45" text-anchor="middle">zones — per-module strictness; nothing at a higher zone rests on a claim from a lower one (specified)</text>
  <rect class="box notyet" x="20" y="110" width="140" height="60" rx="8"/><text x="90" y="135" text-anchor="middle">task intake</text><text class="small" x="90" y="153" text-anchor="middle">tickets → tasks</text>
  <rect class="box" x="190" y="110" width="130" height="60" rx="8"/><text x="255" y="135" text-anchor="middle">the loop</text><text class="small" x="255" y="153" text-anchor="middle">owns bodies</text>
  <rect class="box" x="360" y="110" width="160" height="60" rx="8"/><text x="440" y="135" text-anchor="middle">language + compiler</text><text class="small" x="440" y="153" text-anchor="middle">the only checker</text>
  <rect class="box" x="550" y="110" width="150" height="60" rx="8"/><text x="625" y="135" text-anchor="middle">the ledger</text><text class="small" x="625" y="153" text-anchor="middle">proved · checked · assumed</text>
  <rect class="box notyet" x="730" y="110" width="150" height="60" rx="8"/><text x="805" y="135" text-anchor="middle">registry</text><text class="small" x="805" y="153" text-anchor="middle">interfaces, versioned</text>
  <rect class="box notyet" x="20" y="230" width="140" height="60" rx="8"/><text x="90" y="255" text-anchor="middle">telemetry</text><text class="small" x="90" y="273" text-anchor="middle">production → repair tasks</text>
  <rect class="box" x="360" y="230" width="160" height="60" rx="8"/><text x="440" y="255" text-anchor="middle">targets</text><text class="small" x="440" y="273" text-anchor="middle">JavaScript · native · wasm</text>
  <rect class="box" x="550" y="230" width="150" height="60" rx="8"/><text x="625" y="255" text-anchor="middle">review tool</text><text class="small" x="625" y="273" text-anchor="middle">computes nothing</text>
  <path class="arrow" d="M160 140 L188 140"/>
  <path class="arrow" d="M320 140 L358 140"/>
  <path class="arrow" d="M520 140 L548 140"/>
  <path class="arrow" d="M700 140 L728 140"/>
  <path class="arrow" d="M440 170 L440 228"/>
  <path class="arrow" d="M625 170 L625 228"/>
  <path class="arrow" d="M90 230 L90 172"/>
  <path class="arrow" d="M625 290 L625 330 L255 330 L255 172"/>
  <text class="small" x="265" y="322">decisions and contract edits return to the loop as tasks</text>
  <text class="small" x="20" y="365">solid: built · dashed: specified, not built · dotted: intended, not specified</text>
</svg>

| Part | Owns | Reduces | Status, {{< param statusDate >}} |
|---|---|---|---|
| Language and compiler | every claim: types, contracts, effects, capabilities, paths | review to reading interfaces | built; being rewritten in Onus |
| The loop | function bodies | prompting to writing a task | built |
| The ledger | what each obligation rests on | "what am I trusting" to a list | built |
| Review tool | rendering the ledger; decisions | reading diffs to reading claims | built; promotion not yet |
| Zones | strictness per module; promotion | one standard for the whole codebase to one per module | specified, not built |
| Targets | JavaScript, native, WebAssembly from one lowering | "does it behave the same" to a differential test | built; WebAssembly untested |
| Task intake | tickets and production failures becoming tasks | triage | not specified |
| Telemetry | which checked obligations fire, and how often | guessing which contracts to tighten | not specified |
| Registry | published interface documents, versioned | trusting a dependency by reading its code | not specified |

**Language and compiler.** The [specification](/spec/) is the contract between the person and the model: pure by default, every effect in the signature, every obligation in one of three states. The compiler is the only checker; there is no linter and no warning level. It exists in TypeScript, and is being rewritten in Onus stage by stage, each stage differential-tested against the TypeScript compiler over the whole fixture suite until the last stage reaches a fixed point.

**The loop.** The [loop](/spec/loop/) turns a task into a change. It assembles the model's context from compiler output, never from source; runs generate, check, classify until green; and never edits a claim. If a contract cannot be met, it stops and proposes. It is the only part of the environment that talks to a model.

**The ledger.** Every obligation, its location, its state, and what discharged it; every `assume` with its justification and whether it has been verified against reality, and when; every capability's construction site and the configuration it depends on. The ledger is what the reviewer reads instead of the code. Its shape is the [path report](/spec/#91-the-path-report) and the [interface document](/spec/#111-interface-document-format), and it gains a field whenever a new kind of trust is introduced.

**Review tool.** A static page over the ledger: path view, interface view, ledger view, diff view, counterexample view. It [computes nothing](/spec/#15-the-review-tool). Decisions made in it — approve, reject, accept a proposal, tighten a contract — are meant to flow back to the loop as tasks; in v0 they do not yet, and promotion (drafting the declaration that enforces a convention the reviewer spotted) is unbuilt.

**Zones.** Every module is `draft`, `hardened` or `critical`; nothing at a higher zone may depend on a claim from a lower one; promotion is earned by regenerating the module's bodies from its interfaces and finding nothing missing. Specified in [change log 3](/spec/changes/#log-3); the manifest, the dependency rule and the `hardened` modifier are the next compiler work after the rewrite.

**Targets.** One lowering, two emitters: JavaScript, and native code through LLVM. Every `proved` obligation emits nothing; every `checked` one emits a compare-and-branch. `onus test --target all` runs the examples on both and reports disagreement as a diagnostic. WebAssembly goes through the same LLVM path and is written but untested for want of a toolchain. See [§19](/spec/#19-targets).

**Task intake.** Not yet specified. The intent: a ticket — a described defect or feature — becomes a `ticket` task, whose first output is a proposal for the interface change; only after a person accepts it does an `implement` task follow. Production failures arrive the same way, through telemetry.

**Telemetry.** Not yet specified. The intent: the runtime's panic carries an obligation id and the values involved; telemetry forwards these as `repair` tasks whose counterexample is the production values, pinned as an example before any body changes. Checked obligations that are hit often and never fail are reported as candidates for proving.

**Registry.** Not yet specified. The intent: a dependency is trusted by its published interface document, not its source; the registry holds those documents versioned, and the compiler refuses a compatible-version bump that weakens a contract or widens an effect set.

## What we haven't built

As of {{< param statusDate >}}:

- **Task intake, telemetry, registry.** Intentions only, above.
- **Zones.** Specified on 5 September 2026; no code.
- **Concurrency.** The language has no story for it. Nothing in v0 spawns, and `nondet` is the only acknowledgement that scheduling exists.
- **A foreign function interface beyond `assume`.** Host claims let a program say what it needs from the runtime; anything else that crosses into another language is an assumption, and is reported as one.
- **Decisions flowing back from the review tool**, and promotion drafts.
- **Constrained decoding in the loop.** `onus next` exists; no model runtime the loop talks to can use it yet, so the hook is declared and unused.
- **Production feedback.** A `repair` task may carry a production counterexample; nothing produces one.
- **WebAssembly**, untested.
- **The compiler in Onus.** Front end, checker and verifier agree with the TypeScript compiler on every source; the reports, code generation and the CLI remain, and after them the fixed point.
