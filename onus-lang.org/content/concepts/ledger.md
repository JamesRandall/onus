---
title: The ledger
weight: 80
summary: Every obligation's state, every assumption, every runtime-check site, every capability's origin. What the reviewer reads instead of the code.
spec: "spec §11, §12.2"
specurl: /spec/#11-modules-and-the-interface
---

Every obligation ends in one of three states: *proved*, *checked* at runtime, or *assumed*. The ledger is the record of which, for every obligation in the program, along with every assumption, every runtime-check site, and where each capability was constructed. It is what a reviewer reads instead of the code.

| State | Meaning |
|---|---|
| **proved** | Discharged by the solver. No runtime cost; no code is emitted. |
| **checked** | Not provable within the fragment or the budget; a runtime check is inserted. Requires the `panic` effect. |
| **assumed** | Introduced by `assume`, or the contract of an intrinsic. Recorded, never checked. |

The compiler never silently downgrades. A function may pin an obligation's state — `requires proved ...` means "fail compilation if this cannot be proved" — and a path may require that no obligation on it is checked.

The state also decides what is emitted. Onus compiles to JavaScript, or to native code through LLVM, from one lowering. A proved obligation produces no code on either target. A checked one becomes a compare-and-branch to a panic that carries the obligation's id, in the JavaScript output and in the native binary alike, so the ledger is also the exact list of runtime checks in the program you ship. `onus test --target all` runs the examples on both targets and reports any disagreement as a diagnostic.

The ledger is not a separate document; it is the part of a module's **interface** the compiler generates. For every public item, the interface holds the signature with effects and claims; every `requires`, `ensures`, `invariant` and `law`; every `example` and `property` and their status; every `assume` with its justification; and each obligation with its location and state. Bodies are not in it. If an interface is insufficient to trust a module, that is a defect in the module's contracts, not a reason to read the body.

```
Module checkout: 6 proved · 0 checked · 0 assumed · 0 failed
  requires    parse_select(text: text) is Ok          load_basket       proved   const evaluator   pinned
  refinement  it >= 0                                 load_basket       proved   z3
  ensures     result is Ok implies caller == customer app.auth.require  proved   z3
  ...
Assumptions on path checkout (3)
  Idempotent at checkout.load_basket        in scope   "A select reads only; it has no observable effect."
  Idempotent at vendor.payments.charge      external   "Vendor API deduplicates on key for 24h; see contract §4.2"
  Idempotent at checkout.record_order       in scope   "The insert is `on conflict (receipt_id) do nothing`."
```

Each assumption also records whether a `verify` block exists for it and when it last passed against which environment, so the review tool can say *assumed, verified 4 September against staging* rather than just *assumed*. Each runtime check records whether any `example` or `property` exercises it. Obligation coverage — proved; checked, and of those exercised; assumed, and of those verified — is the only test metric reported. Line coverage is not.

Diffing two interface documents is how the compiler enforces compatibility: a public contract may not be weakened, nor an effect set widened, without a major version change.
