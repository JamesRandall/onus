---
title: The loop
weight: 130
summary: Drives a model against the compiler until every obligation is proved or checked. Edits bodies; never edits a claim.
spec: "loop spec"
specurl: /spec/loop/
---

The loop is the component that drives a model against the compiler: it takes a task, has the model write bodies, checks, feeds back the diagnostics, and repeats until everything is proved or checked. It never edits a contract to get there; if it can't satisfy one, it stops and proposes a change for a person to accept.

```
intake → prepare → [ generate → check → classify ]* → conclude
```

A task is a JSON object — `implement` a signature that has no body, `repair` a failed obligation given its counterexample, regenerate everything an `interface_change` invalidated, or `regenerate` a scope from its interfaces to find out what they don't say — with a scope the loop may edit and a budget in iterations, tokens and time. Anything outside the scope is read-only.

What the model sees is assembled from compiler output, never from source files: the target's signature, contracts, effects and examples; the interfaces of everything in scope and everything imported, with bodies elided; sibling bodies in the same module as reference; every diagnostic from the last check as structured data; and the counterexample, if any, as concrete values against the contract. Not shown, ever: conventions documents, prompt-style instructions, other people's bodies. If a convention matters, it is a claim.

Every check is classified: **green**, open a change; **progress**, go again; **stall**, escalate — full history, then wider context; **contract conflict**, the verifier keeps finding the same counterexample and the model keeps writing the same body, so the contract is probably wrong — stop and say so; **out of scope**, green would need an edit the loop is not allowed to make — stop and say so.

Stopping produces a **proposal**: a structured object, never an edit, that appears in the review tool as an interface diff marked *proposed by loop*, with the evidence attached. A human accepts, rejects or edits it. Accepting makes it a new task. The loop never acts on its own proposal.

Its output is a **change**: an interface diff (expected to be empty for `implement` and `repair`), a ledger delta, a trace of every model call, and metrics. Opening the change is the loop's last act; merging is a human decision. It runs with two capabilities — the compiler and the model — and cannot deploy, reach the network otherwise, write outside the working tree, or merge.

The loop is implemented in `packages/loop` with three model back ends; the [benchmark log](/status/#the-loop) records how models do against it.
