# Onus — regeneration loop, candidate v0

*The component that owns function bodies. Companion to `onus-spec-v0.md` (language, §N references) and `onus-impl-spec-v0.md`. Candidate: every section is a proposal.* <!-- changed: 2026-09-05 — implemented as written by milestone 14 (`packages/loop`); the deviations are marked below and recorded in docs/CHANGES.md items 110–117 -->

---

## 1. Purpose

The loop turns a **task** into a **change**: a set of Onus modules whose obligations are all proved or checked, opened for human review as an interface diff. It runs unattended. A human sees its output in the review tool, not its process.

Its one discipline: **the loop edits bodies; it never edits claims.** Contracts, effects, claims, capabilities, paths, policies and `assume` leaves are the human's. If the loop cannot satisfy a contract, it stops and says so, with a proposal. It does not weaken the contract, widen an effect set, or insert an `assume` to get green. This is what makes its output trustworthy without reading it.

---

## 2. Tasks

A task is a JSON object. Kinds:

| Kind | Trigger | Loop's job |
|---|---|---|
| `implement` | A signature with contracts and no body (or a body marked `{ regenerate }`) | Write the body |
| `repair` | A failed obligation with a counterexample, from a build or from production (§7) | Change bodies until the obligation is proved or checked |
| `interface_change` | A human edited an interface: changed a contract, effect set, type, or added a path clause | Regenerate every body the change invalidates |
| `regenerate` | Explicit: discard bodies in a scope and rebuild from interfaces | Rebuild; report divergence (§8) |
| `ticket` | From task intake: a described defect or feature | First produce a `proposal` (§5) for the interface change; only after approval, `implement` |

```json
{
  "id": "task_01J...",
  "kind": "repair",
  "scope": ["app.checkout"],
  "target": { "def": "app.checkout.load_basket", "obligation": "ob_4f2a" },
  "counterexample": { "who": { "id": "c_19" }, "basket": { "items": [] } },
  "budget": { "iterations": 12, "tokens": 400000, "wall_ms": 900000 },
  "context_policy": "module",
  "origin": { "kind": "production", "ref": "trace_7c..." }
}
```

`scope` bounds what the loop may edit. Anything outside scope is read-only.

---

## 3. What the model sees

The loop assembles the model's context from compiler output, not from source files. Per iteration:

1. **The target.** Signature, contracts, effects, claims, examples and properties of the function(s) being written, in canonical Onus text.
2. **The interfaces** (§11.1) of every module in scope and every import, rendered as Onus with bodies elided. Never the bodies of imports.
3. **Sibling bodies**, governed by `context_policy`:
   - `none` — bodies of other functions are never shown. Pure local reasoning.
   - `module` (default) — bodies of functions in the same module are shown as reference. This is how "like the other handlers" transfers without being stated.
   - `scope` — bodies of everything in scope.
4. **Diagnostics** from the last check, as §13 JSON, filtered to the target and its callees. All of them, not the first.
5. **The counterexample**, if any, rendered as concrete values against the contract text and the path condition that led there.
6. **The standard library's** relevant interface entries, selected by type: if the target mentions `Grid`, `Grid`'s interface is present.
7. **Constrained decoding**, where the model runtime supports it: `onus next` (§14) supplies the legal token set and expected type at each position. Where it does not, the loop relies on the check-and-repair cycle alone. <!-- changed: 2026-09-05, item 110 — no v0 model supports it; the hook is declared only -->

Not shown, ever: prose conventions documents, prompt-style instructions about behaviour, other people's bodies outside the policy. If a convention matters, it is a claim; if it isn't a claim, the loop doesn't know about it. This is deliberate: it is how the underspecified remainder becomes visible rather than papered over.

---

## 4. The cycle

```
intake → prepare → [ generate → check → classify ]* → conclude
```

**prepare.** Parse the task, check scope, take a snapshot of the interface documents (the *baseline*), run `onus check` to confirm the baseline state, build the initial context.

**generate.** The model produces bodies for the target(s). Output is parsed immediately; unparseable output is a `E0xxx` syntax diagnostic fed back, not a retry with the same prompt.

**check.** `onus check` on the scope. Canonical form is applied automatically (`E0001` never reaches the model). Then, before invoking the model again, the loop applies any diagnostic `repairs` marked `confidence: high` mechanically and re-checks. Mechanical repair is capped at three rounds per iteration.

**classify.** The check result falls into one of:

- **green** — no diagnostics; all obligations in scope proved or checked; examples and properties pass. → conclude.
- **progress** — the diagnostic set changed and shrank, or an obligation moved from failed toward proved. → next iteration with the new diagnostics.
- **stall** — the diagnostic set is identical to a previous iteration's, or has grown twice in a row. → escalate (§4.1).
- **contract conflict** — the verifier produced a counterexample that satisfies every precondition and every path condition and violates the postcondition, *and* the model has proposed the same body shape twice. → the contract is likely wrong. Stop; emit a proposal (§5).
- **out of scope** — green would require editing outside scope, or editing a claim. → stop; emit a proposal.

**conclude.** Either open a change (§6) or emit a blocked report with the last diagnostics, the best body attempted, and any proposals.

### 4.1 Escalation ladder

On stall, in order, one step per iteration:

1. Re-prompt with the full diagnostic history, not just the last set.
2. Widen `context_policy` one level (`none → module → scope`).
3. Ask the model for the body of a *helper* with its own contract, in the same module, and retry the target against it. The helper's contract is a proposal; the loop may write it only because it is private (`sealed` to the module) and appears in the change as new interface.
4. Try a different model or sampling temperature, if configured.
5. Stop; blocked.

Steps 3 and 4 are optional and off by default. <!-- changed: 2026-09-05, item 113 — v0 skips them; a model output that adds a helper is refused once and then out of scope -->

### 4.2 Budgets

`iterations`, `tokens`, `wall_ms`. Exhausting any one → conclude as blocked. Budgets are per task; defaults are set per repository. A task that concludes blocked is not retried automatically.

---

## 5. Proposals

A proposal is the loop's only way to say "the claims should change." It is a structured object, never an edit:

```json
{
  "kind": "weaken_postcondition" | "add_precondition" | "widen_effects" | "add_claim" | "add_example" | "new_helper" | "unsatisfiable",
  "def": "app.checkout.load_basket",
  "current": "ensures result.items.len > 0",
  "proposed": "ensures result.items.len >= 0",
  "evidence": { "counterexample": { "...": "..." }, "iterations": 7 },
  "rationale": "Empty baskets exist for customers with abandoned sessions; the postcondition excludes a reachable state."
}
```

Proposals appear in the review tool as interface diffs marked *proposed by loop*, with the evidence attached. A human accepts, rejects, or edits. Accepting turns it into an `interface_change` task. The loop never acts on its own proposal.

`add_example` is the most common proposal in practice and the least contentious: the loop noticed a case the examples don't cover and wants it pinned.

---

## 6. Changes

A change is the loop's output for review. It contains:

- **interface diff** — baseline interface documents versus new. Expected to be empty for `implement` and `repair` tasks; non-empty only when a helper was introduced (§4.1 step 3) or the task was an `interface_change`. <!-- changed: 2026-09-05, item 114 — empty by construction when the baseline does not check: only target bodies are spliced and signatures are compared textually -->
- **ledger delta** — obligations whose status moved, new checked sites, anything now `assumed` (which must be zero unless a human put it there).
- **body diff** — informational. Shown collapsed; the review tool counts if it's opened.
- **trace** — every iteration: model, prompt hash, diagnostics before and after, tokens, time. Attached to the ledger, not shown by default.
- **metrics** — iterations to green, mechanical repairs applied, escalation steps used, proposals emitted.

Opening a change is the loop's last act. Merging is a human decision made in the review tool.

---

## 7. Production feedback <!-- changed: 2026-09-05, item 117 — deferred; a `repair` task may carry a production counterexample and origin already -->

The runtime's `Panicked` value carries an obligation id and, where available, the values involved. Telemetry forwards these to task intake, which produces a `repair` task whose counterexample is the production values, with `origin.kind = "production"`.

The loop treats a production counterexample differently from a solver one in one way: it first *adds it as an example* (a proposal, auto-accepted under a repository setting) so that the case is pinned before any body changes. A production failure that is fixed but not pinned will return on the next regeneration.

Checked obligations that are hit frequently in production, and never fail, are reported by telemetry as candidates for proving (tighten the contract or add an invariant) — a proposal of kind `add_claim`, with the hit count as evidence.

---

## 8. Regeneration audits

`regenerate` tasks exist to find tacit knowledge before it is lost. The loop discards the bodies in scope, rebuilds them from interfaces alone (`context_policy: none`), and reports:

- obligations that were green and now are not — the interfaces were sufficient to check but not to reconstruct; usually a missing example or invariant;
- examples or properties that fail on the regenerated bodies — something the old body did that no claim required;
- bodies that are green but differ in a way the review tool's diff can surface (different effects used, different callees). <!-- changed: 2026-09-05, item 115 — not reported in v0; the interface documents carry no call graph -->

Each finding becomes a proposal. A module that survives regeneration with no findings has interfaces that fully describe it; that is the target state, and the review tool reports the fraction of modules that meet it.

---

## 9. Boundaries and safety

- The loop runs with exactly two capabilities: the compiler, and the model API. It cannot deploy, cannot reach the network otherwise, cannot write outside the repository's working tree, and cannot merge.
- It never inserts `assume`, never edits a `path` or `policy`, never changes a public signature except via an accepted proposal.
- Every model call is logged with the full context hash; a change's trace is sufficient to reproduce it given the same model.
- If the compiler reports `E0999` (internal error), the loop stops and files it against the compiler, not against the task.

---

## 10. Interfaces

- `onus loop run <task.json>` — runs one task to conclusion; exits 0 on change opened, 2 on blocked, 1 on error.
- `onus loop watch` — consumes tasks from intake as they arrive; concurrency limited by repository setting; tasks with overlapping scope are serialised. <!-- changed: 2026-09-05, item 117 — deferred with intake; `onus loop run` forwards to `onus-loop run` in `packages/loop` -->
- Task schema, change schema and proposal schema are versioned JSON schemas in `packages/loop/schema/`.
- Model access is behind one interface: `generate(context) → text`, with an optional `next(offset)` hook for constrained decoding. First implementation: the Anthropic API; second: Claude Code as a subprocess, for repositories that already use it.

---

## 11. Metrics

Reported per change and aggregated per repository:

- iterations to green (median, p90)
- mechanical repair rate (fraction of diagnostics resolved without the model)
- blocked rate, by cause (stall / contract conflict / budget)
- proposals per task, and acceptance rate
- regeneration audit findings per module
- tokens per proved obligation

These are the numbers the environment is judged on, alongside the review tool's reviewer-minutes and body-open rate.

---

## 12. Open questions

1. Whether `context_policy: module` leaks conventions in a way that undermines the "unstated conventions become visible" goal. It probably does, a bit; the alternative is a much worse first-pass success rate. Measure both.
2. Helper introduction (§4.1 step 3) is the one place the loop writes a contract. It is private and appears in the diff, but it is still the loop deciding what to promise. Keep it off by default until there is data.
3. Auto-accepting `add_example` from production failures is a policy decision with real consequences (an example that pins a bug as correct behaviour). Default off; on only for repositories that want it.
4. How to parallelise `interface_change` tasks that invalidate many bodies — likely per-function tasks with a shared baseline, but the merge of many small changes into one reviewable change is not designed.
5. Whether the loop should ever see a body from outside scope for *reading* (a callee's body, to understand a checked obligation). The spec says no. It may prove too strict.
