---
title: Paths
weight: 70
summary: Name an entry point, state what everything reachable from it may do, must guarantee and may assume, and have the whole region checked at once.
spec: "spec §9"
specurl: /spec/#9-paths
---

A path names an entry point — a route handler, a job, `main` — and states what everything reachable from it may do, must guarantee, and may assume. The compiler walks the call graph and checks the whole region at once. It is how a critical section of a program gets a guarantee declared once at the top rather than repeated in every function.

```
path checkout
  entry handle_checkout
  effects <= { sql.read, sql.write, io.net, io.clock, alloc }
  require { Idempotent }
  policy no_third_party_assumes except { vendor.payments.charge }
```

- `entry` — the root of the reachable set. Exactly one.
- `effects <=` — an upper bound on the union of effects of every reachable function.
- `forbid` — effects that must not appear anywhere reachable. Redundant with the bound, but it reads better for the reviewer, and the two must agree.
- `require` — claims every reachable function with any effect must carry.
- `policy` — a rule about assumptions, with named exceptions, each reported individually.

Calls through function values are resolved where the value's provenance is known; where it is not, the check fails closed rather than guessing. A function outside the bound, a forbidden effect, a missing claim, and an assumption the policy does not permit are each a distinct diagnostic.

Every path produces a report: the reachable set, the effects actually used against the bound, the claims and whether they are satisfied, every assumption with its justification and what permitted it, every capability constructed on the path and where, the obligation counts, and the graph the review tool draws. The report is the reviewer's primary artefact for a path; the JSON is normative and the rendering has the same content. The [home page](/#the-ledger) renders the checkout example's.

The rule a path expresses cannot be forgotten by the next model or the next person, because it is not advice. A model asked to add logging to something reachable from `checkout` that needs `io.file` gets a build failure naming the path, the function and the effect, and the fix is never to widen the path — that is a human's edit — but to move the work to where the authority already is.
