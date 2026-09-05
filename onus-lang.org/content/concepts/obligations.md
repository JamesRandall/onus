---
title: Obligations and the solver
weight: 20
summary: Every contract becomes a small logical statement the compiler must establish. A solver decides each one; what it cannot decide becomes a runtime check.
spec: "spec §12"
specurl: /spec/#12-verification
---

Every contract, refinement and bound generates an *obligation*: a small logical statement the compiler has to establish. Onus hands each one to a *solver* — a program that decides whether a logical statement can be false. If the solver finds no way to make it false, the obligation is proved and no code is emitted for it. If it finds a way, that is a *counterexample*: concrete values that break the contract, shown to you. If it can't decide within a budget, the obligation becomes a runtime check. Onus uses Z3, a mature solver from Microsoft Research; it is not part of the language, and could be swapped.

Obligations arise everywhere a claim meets a value:

- every `requires` at a call site, and every `ensures` at a `return`;
- every refinement at a binding — passing an `Int` where `Int where it >= 0` is expected;
- every `invariant` at loop entry and at the end of each iteration, and every `decreases`;
- every index into a list or grid;
- every `law` on an interface implementation, and every `property`.

```
fn clamp(x: Int, lo: Int, hi: Int where it >= lo) -> Int where lo <= it and it <= hi {
  if x < lo { return lo }   -- obligation: lo <= lo and lo <= hi. proved.
  if x > hi { return hi }   -- proved.
  return x                  -- here: not (x < lo) and not (x > hi). proved.
}
```

The solver's knowledge is path-sensitive: inside a branch, the branch condition and everything implied by earlier conditions are available. The compiler never *changes* a binding's type on a branch — `x` is still `Int` — it simply discharges the obligation from what it knows at that point.

The fragment the solver works in is deliberately small: linear integer arithmetic, equality, algebraic datatypes, and quantification over a stated domain — a range, a list, a finite type — so every obligation is decidable. Nonlinear arithmetic is attempted with a small budget and falls back to a runtime check; floating-point refinements are checked at runtime unless a function opts into real-arithmetic reasoning. A solver timeout is a hard error, not a silent fallback, because a build that behaves differently on repeated runs is worse than one that fails consistently.

Obligations are cached by the content hash of everything they depend on, so re-checking after an edit re-verifies only what the edit could have changed.
