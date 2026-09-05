---
title: Canonical form
weight: 100
summary: Exactly one way to format any program, enforced by the compiler. Diffs become semantic; a model never spends effort on layout.
spec: "spec §2.2"
specurl: /spec/#22-canonical-form
---

There is exactly one way to format an Onus program, and the compiler enforces it. Diffs become semantic, style debates do not exist, and a model never spends effort on layout.

`onus check` reports non-canonical source as a diagnostic — `E0001`, with the canonical text as its fix — and `onus fmt` applies it. There is no configuration. Indentation is two spaces; one declaration per top-level item; one blank line between items; named arguments on the call line unless the call exceeds 100 columns, in which case one argument per line:

```
let who: auth.AuthedCustomer = try auth.require(
  service: auth,
  caller: req.caller,
  customer: req.customer,
  clock: clock
) else e: Unauthorised(detail: e)
```

The printer is the formatter, and there is only one printer. The compiler in Onus reproduces the TypeScript compiler's output byte for byte on every source in the repository; that equality is the acceptance test for its front end.

Canonical form has a second job. Every definition has a canonical byte sequence and therefore a content hash, and that hash is what proof caching is keyed on: re-checking after an edit re-verifies only the obligations whose dependencies' hashes changed. Comments are preserved by the printer but excluded from the hash, so a comment never invalidates a proof.

In the loop, canonical form is applied before the model ever sees a diagnostic; layout is never something it is asked to fix.
