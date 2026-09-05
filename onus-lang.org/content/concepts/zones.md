---
title: Zones
weight: 120
summary: Every module is draft, hardened or critical. Nothing at a higher zone rests on a claim from a lower one. Promotion is earned, not declared.
spec: "spec §21 (change log 3)"
specurl: /spec/changes/#log-3
---

Every module is in a zone — `draft`, `hardened` or `critical` — that sets how strict the rules are and what the model may change. Nothing at a higher zone may depend on a claim from a lower one. Promotion is earned by throwing the module's bodies away and regenerating them from its interfaces; what doesn't come back was never written down.

| Zone | Interfaces | Bodies | Ledger | Extra rules |
|---|---|---|---|---|
| `draft` | change freely, by human or model | may be human-edited | recorded, not authoritative | none |
| `hardened` | the human's | the model's | authoritative | the loop may not edit interfaces; every assumption has a justification |
| `critical` | the human's | the model's | authoritative | every public entry on a `path`; no unverified assumptions; no `recover`; no runtime check without an example that exercises it |

Zones are declared in the project manifest, not in modules, because a zone change is a decision about the project and its diff is what a reviewer approves:

```toml
[zones]
"app.core.*"      = "critical"
"app.reporting"   = "hardened"
"app.payments.*"  = "draft"
default           = "draft"
```

A module may depend on another only at the same zone or higher. The one exception is what makes building a new subsystem against a stable core possible: a `draft` module may mark individual public items `hardened`, and higher zones may depend on those items and only those. The item's contract is then checked to the hardened standard while its body stays draft. Harden the boundary first; the core is permitted to see only the boundary.

`onus zone promote <module> <zone>` runs a regeneration audit at the target zone's standard, and every finding — an obligation that was green and now isn't, an example the regenerated body fails — becomes a proposal. It succeeds only with no findings, and there is no manual override. Demotion is always permitted and always recorded, and marks every guarantee that rests on the demoted module as *conditional* in the ledger until it is promoted again.

Zones were specified on 5 September 2026 and are not yet implemented; the [status page](/status/) says when that changes.
