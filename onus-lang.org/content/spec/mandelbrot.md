---
title: "Example: Mandelbrot"
layout: example
weight: 60
lede: The first worked example (spec §18.1). Pure computation with refinements, a loop with an invariant and a measure, an example block, a property, and a root capability for the one file it writes.
params:
  example: mandelbrot
  files: [mandelbrot.onus]
---

Everything in this program is proved: the ledger has no checked obligations, and `onus run` writes the same PGM from the JavaScript and the native build. It is also the loop's benchmark task — `escape_count` regenerated from its interface with the body elided — and the property `escape_bounded` is what detects the contract weakening `onus test --mutate` applies to it.
