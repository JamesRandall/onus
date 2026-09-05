---
title: Contracts
weight: 10
summary: What must be true before a function runs, what it promises when it finishes, and what stays true through a loop — checked, not commented.
spec: "spec §5"
specurl: /spec/#5-functions-and-contracts
---

A contract is a statement about a function that the compiler checks: what must be true before it runs (`requires`), what it promises when it finishes (`ensures`), and what stays true throughout a loop (`invariant`). In most languages this is a comment or a test. In Onus it is part of the function's type, and the compiler either proves it holds for every input, inserts a runtime check, or refuses the program.

```
pub fn escape_count(cx: Float, cy: Float, limit: Iter) -> Iter
  requires limit > 0
  ensures result <= limit
{
  var zx: Float = 0.0
  var zy: Float = 0.0
  var i: Iter = 0
  loop while i < limit and zx * zx + zy * zy <= 4.0
    invariant i <= limit
    decreases limit - i
  {
    let nx: Float = zx * zx - zy * zy + cx
    zy = 2.0 * zx * zy + cy
    zx = nx
    i = i + 1
  }
  return i
}
```

`requires limit > 0` is an obligation at every call site: whoever calls `escape_count` has to have established it, and the compiler asks the solver whether they have. `ensures result <= limit` is an obligation at every `return`. The loop's `invariant` is checked on entry and at the end of every iteration, and is what the compiler knows after the loop exits; `decreases` names a non-negative quantity that gets smaller each time round, which is how termination is proved rather than hoped for.

Arguments are passed by name at every call, and there is no inference: `escape_count(cx: 0.0, cy: 0.0, limit: 100)`. Verbosity is not a cost when a model is writing; ambiguity is.

A contract is the model's specification and the reviewer's evidence at once. The model is given it and writes a body that satisfies it; the reviewer reads it and never needs the body. If the contract says the wrong thing, the compiler faithfully enforces the wrong thing — Onus makes that the only kind of mistake left, and puts it in the one place a person actually reads.
