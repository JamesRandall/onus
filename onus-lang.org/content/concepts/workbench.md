---
title: The workbench
weight: 140
summary: The review tool. Renders the ledger, path reports and interface diffs; the place a person approves, answers counterexamples, and decides what the model does next.
spec: "spec §15"
specurl: /spec/#15-the-review-tool
---

The review tool. It renders the ledger, the path reports and interface diffs; it is where a person approves changes, answers counterexamples, and decides what the model does next. It computes nothing; everything it shows is compiler output.

Onus assumes the developer is reviewing, not editing, and the workbench is the surface for that work. Its one design rule — that it computes nothing — means there is no second analysis that can disagree with the language. Every view is a rendering of an interface document, a path report or a diagnostics document.

- **Path view.** The reachable graph from a `path` entry, laid out top-down as authority flows: root capabilities enter at `main`, attenuate at each narrowing, and terminate at resources. Edges carry effects; nodes carry claims and obligation counts. `assume` leaves and `recover` sites are the only things drawn in colour.
- **Interface view.** A module as its signatures, contracts, examples and properties, with obligation status inline: proved is unmarked, checked is marked with the check's location, assumed with its justification. Bodies are collapsed. Opening one is permitted and counted, and the body-open rate per module is reported, because a module whose bodies must be read has contracts that are not doing their job.
- **Ledger view.** Every obligation across a module or path, filterable by state, with every assumption, every `recover`, and every capability construction site.
- **Diff view.** Two interface documents compared; source diffs are not shown. Compatible changes (a weakened `requires`, a strengthened `ensures`) are distinguished from breaking ones (the reverse, a widened effect set, a new assumption). This is the pull-request page.
- **Counterexample view.** A failed obligation with the solver's model rendered as concrete values against the contract text. Its purpose is the one judgement that needs a human: whether the contract is wrong or the body is.

What it does not do: edit bodies (that is model work, requested as a task with the failing obligation attached); run anything (the compiler evaluates examples; the tool shows results); offer opinions (no lint, no style, no suggestions).

In v0 the workbench is a static page written by `onus review` over the JSON reports beside it. The pages it wrote for the [checkout](/review/checkout/) and [Mandelbrot](/review/mandelbrot/) examples are served on this site unchanged. Decisions flowing back to the loop as tasks, and promotion — drafting the `sealed` type or `path` clause that would enforce a convention the reviewer pointed at — are specified and not yet built.
