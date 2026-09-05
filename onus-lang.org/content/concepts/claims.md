---
title: Claims and assumptions
weight: 60
summary: A named property that travels through the call graph. Where nobody can check it, `assume` records that trust entered, and why.
spec: "spec §7"
specurl: /spec/#7-claims
---

A claim is a named property that travels through the call graph: a function may carry it only if everything it calls does too. Some claims the compiler understands directly; some are defined in terms of those; and some — "this vendor's API is idempotent" — cannot be checked by anyone. The last kind are introduced with `assume`, which records where trust enters and why, and the ledger lists every one.

| Tier | Defined by | Checked by |
|---|---|---|
| primitive | the compiler: the effects | the compiler |
| derived | a predicate over primitives and other claims, like `claim Total := not diverge and not panic` | the compiler, by expansion |
| asserted | a name and a description | propagation only, from `assume` leaves |

```
pub claim Idempotent "Calling twice with the same arguments has the same observable effect as calling once."

pub fn charge(client: Client, key: Text, amount: Int where it >= 0, who: auth.AuthedCustomer)
  -> Result[Receipt, Error] may io.net, alloc
  claims Idempotent
{
  assume Idempotent "Vendor API deduplicates on key for 24h; see contract §4.2"
  ...
}
```

An asserted claim is sound relative to its `assume` leaves and nowhere else. The compiler propagates it exactly as it propagates effects — `handle_checkout` may claim `Idempotent` only if every function it calls that does anything observable claims it too — and records every `assume` in the ledger with its justification and location. The justification is not a comment; it is a field the reviewer reads.

A path or a module can constrain where assumptions are allowed:

```
policy no_third_party_assumes
  forbid assume outside { self, std.* }
```

This is how a critical path refuses to depend on a library's word. Where an outside assumption is unavoidable, the path names it as an exception, and it is reported individually, in colour.

An assumption can also be tested against reality. An `assume` may carry a `verify` block — an Onus body that exercises the assumption against the real resource — which `onus test --assumptions` runs against a staging environment, recording when and with what result. A path may require that every assumption on it has a recent passing verification.
