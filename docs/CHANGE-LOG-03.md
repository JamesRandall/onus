# CHANGE-LOG-03.md — Onus specification changes: trust zones

Follows `CHANGE-LOG-02.md`. Apply after it. Adds zones — per-module levels of strictness — to `onus-spec-v0.md`, `onus-impl-spec-v0.md` and `onus-loop-v0.md`. The type system and verifier are unchanged; zones add a manifest, a dependency rule, per-zone policy bundles, a promotion command, and zone-aware loop behaviour.

---

## 2026-09-05 — Trust zones **(to apply)**

**Principle.** Trust in Onus is per artefact: interfaces are the human's, bodies are the model's, and the ledger records what each obligation rests on. A project is not uniformly trusted at any moment in its life — a hardened core coexists with a subsystem being prototyped against it — so strictness is declared per module, and the only rule that matters is that nothing at a higher level of trust ever rests on a claim from a lower one.

### Language spec: new §21 "Zones" (insert after §20 Testing)

> ## 21. Zones
>
> Every module belongs to exactly one zone. A zone is a level of strictness. There are three:
>
> | Zone | Meaning |
> |---|---|
> | `draft` | Being designed. The ledger is recorded but not authoritative. Interfaces may change freely, by human or model. Bodies may be human-edited. |
> | `hardened` | In service. Interfaces are the human's, bodies are the model's (loop spec §1). The ledger is authoritative. |
> | `critical` | In service and load-bearing. `hardened`, plus every public entry is on a `path`; no unverified assumptions; no `recover`; no `checked` obligation without an exercising `example` or `property`. |
>
> Zones are declared in the project manifest (21.4), not in modules, because a zone change is a decision about the project and its diff is what a reviewer approves.
>
> ### 21.1 The dependency rule
>
> A module may depend on another module's interface only if that interface is at the same zone or higher. `draft` may depend on anything. `hardened` may depend on `hardened` and `critical`. `critical` may depend only on `critical`.
>
> One exception makes integration possible: a `draft` module may mark individual public items `hardened`. A hardened or critical module may depend on those items — and only those — from the draft module. A hardened item in a draft module is checked to the hardened standard: its contracts may not be changed by the loop, its obligations appear in the authoritative ledger, and its `assume` leaves are subject to the depending zone's policies. Its body remains draft.
>
> ```
> -- in a draft module
> pub hardened fn charge(client: Client, req: ChargeRequest) -> Result[Receipt, Error] may io.net, alloc
>   ensures ...
> ```
>
> This is the mechanism for building a new subsystem against a stable core: harden the boundary first, and the core is permitted to see only the boundary.
>
> Violations are `E0900 dependency crosses zone boundary`, naming both modules, the zones, and the item.
>
> ### 21.2 Zone policies
>
> Each zone applies a fixed bundle of the policies that already exist:
>
> - `draft`: none. `assume` unrestricted; `recover` unrestricted; `checked` unrestricted.
> - `hardened`: `no_loop_authored_claims` (the loop may not edit interfaces; loop spec §1 and §5); assumptions must have a justification string.
> - `critical`: `hardened` plus `verified_assumptions_only` (§20.3), `forbid { recover }` on every path, `checked_requires_example`, and `no_third_party_assumes` unless individually excepted in the manifest.
>
> A module may add policies beyond its zone's bundle. It may not remove any.
>
> ### 21.3 Promotion and demotion
>
> `onus zone promote <module> <zone>` runs the regeneration audit (loop spec §8) on the module at the target zone's standard: bodies are regenerated from interfaces alone, and every finding becomes a proposal. Promotion succeeds only when the audit reports no findings and the zone's policies pass; the manifest change is opened for review like any other change. The audit result is stored in the ledger as the promotion record.
>
> `onus zone demote <module> <zone>` is always permitted and always recorded. Demoting a module that others depend on does not break the build; it marks every dependent's guarantees that rest on the demoted module as *conditional* in the ledger and the path reports, until the module is promoted again.
>
> Zones only ever change through these commands. Editing the manifest directly is `E0901 manifest edited outside zone command`.
>
> ### 21.4 Manifest
>
> `onus.toml` at the repository root:
>
> ```toml
> [zones]
> "app.core.*"      = "critical"
> "app.reporting"   = "hardened"
> "app.payments.*"  = "draft"
> default           = "draft"
>
> [zones.exceptions]
> "app.core.checkout" = { third_party_assumes = ["vendor.payments.charge"] }
> ```
>
> Patterns match module names; the most specific match wins. `default` applies to modules not matched. A new module is `draft` unless the manifest says otherwise.
>
> ### 21.5 Reporting
>
> The interface document, path report and ledger carry the zone of every item. A path report additionally lists the zones it crosses and every hardened-item-in-draft-module it depends on. The review tool renders zones as regions, with draft regions visibly distinct, and the promotion history of each module.

### Grammar (§2.3)

```
visibility  = [ "pub" ] [ "hardened" ] [ "sealed" ] ;
```

`hardened` as a visibility modifier is permitted only on `pub` items in `draft` modules; elsewhere it is `E0902 hardened modifier outside draft zone`. `hardened` is a reserved word.

### Implementation spec

**§2 Layout.** Add `zones/` under `compiler/src/`: manifest parsing, zone resolution, dependency rule, policy bundles.

**§4 Passes.** Add pass 12a, after paths: **zones** — resolve every module's zone from the manifest, check the dependency rule (`E0900`), apply zone policy bundles (feeding the same checks paths and policies already run), record zone per item for reports.

**§7 Reports.** `interface.json` items gain `zone`; `path.json` gains `zones_crossed` and `draft_dependencies`; ledger gains `promotions` (module, from, to, audit result, timestamp) and `conditional` flags on obligations resting on demoted modules.

**CLI.** `onus zone promote`, `onus zone demote`, `onus zone show`. Promote depends on the loop for the regeneration audit; before the loop exists it runs the audit's static half only (policies) and records that the body-regeneration half was skipped.

**Milestones.** Add **M14 — Zones.** Manifest, dependency rule, policy bundles, `hardened` modifier, zone fields in reports, `onus zone` commands (static half). Accept: the checkout example split into `app.core.*` critical, `app.reporting` hardened and a new `app.payments` draft module with one `hardened` item that `app.core.checkout` depends on; a dependency on a non-hardened draft item fails `E0900`; demoting `app.reporting` marks the reporting path conditional.

Add to **M10** (review tool): zones as regions; promotion history.

### Loop spec

**§3 What the model sees.** Context policy defaults by zone: `draft` → `scope`, and the model may also see the conversation history for the module (design mode); `hardened` → `module`; `critical` → `none`.

**§1 and §5.** The rule "the loop never edits claims" applies in `hardened` and `critical`. In `draft` the loop may edit interfaces directly and proposals are unnecessary; the ledger records the edits as loop-authored so the promotion audit can find them.

**§4.1 Escalation.** In `critical`, escalation goes to the frontier model on the first stall, and `widen_effects` proposals are never emitted — an effect widening on a critical module is a human decision from the start.

**§8 Regeneration audits.** The audit is the promotion mechanism; its standard is the target zone's policy bundle.

### Codebase now

The manifest format and the dependency rule can be implemented as soon as M8 is done, since they reuse policy checks. The `hardened` modifier is a one-token grammar change; do it with the next grammar touch rather than separately.

---

## Not changed, but decided

- Zones are per module, declared in the manifest, changed only by command. There is no per-function zone; the `hardened` modifier is the sole finer grain, and it exists only to expose a boundary from a draft module.
- Nothing at a higher zone rests on a claim from a lower one. This is the invariant everything else serves.
- Promotion is earned by the regeneration audit; there is no manual override.
