---
title: "Example: checkout"
layout: example
weight: 80
lede: The third worked example (spec §18.3). A payment endpoint across four modules, with a sealed type as evidence of authentication, an asserted claim, a policy on assumptions, and the path report the home page renders.
params:
  example: checkout
  files: [checkout.onus, app/auth.onus, app/contracts.onus, vendor/payments.onus, test_env.onus]
---

`auth.AuthedCustomer` is `pub sealed`: readable anywhere, constructible only inside `app.auth`, and the only producer is `auth.require`, so any function demanding one is callable only after a successful check. `Idempotent` is an asserted claim: it propagates like an effect, and each place it is assumed is recorded with a justification. The path passes with three assumptions, of which exactly one is outside the project — the payment vendor's — and the policy names it. That assumption carries a `verify` block, and `test_env.onus` is the test module that supplies the fake capabilities `onus test --assumptions` runs it against.
