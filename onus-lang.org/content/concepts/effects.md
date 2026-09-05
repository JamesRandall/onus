---
title: Effects
weight: 40
summary: What a function does beyond computing a result, listed in its signature. A callee's effects must fit inside its caller's. No `may` clause means pure.
spec: "spec §6"
specurl: /spec/#6-effects
---

An effect is something a function does beyond computing a result: reading a file, writing to a database, allocating memory, possibly not terminating. In Onus a function's effects are listed in its signature after `may`, and a function may only call functions whose effects fit inside its own. A function with no `may` clause is pure and cannot touch anything. This is what lets the compiler prove that a report handler, and everything it calls however deep, never writes.

```
pub fn monthly_totals(
  db: sql.Db[ReadOnly, schema: "orders"],
  year: Int where 2000 <= it and it <= 2100
) -> Result[List[MonthlyTotal], sql.Error] may sql.read, alloc
```

The set of primitive effects is closed and small:

| Effect | Meaning |
|---|---|
| `alloc` | may allocate on the heap |
| `mutate` | may mutate one of its own `inout` parameters |
| `panic` | may halt on a runtime contract violation — a function without it must have every obligation proved |
| `diverge` | may fail to terminate |
| `nondet` | result depends on something other than its arguments: a clock, randomness, scheduling |
| `io.file`, `io.net`, `io.env`, `io.clock`, `io.rand` | access to the corresponding resource, via a capability |

Resource effects such as `sql.read` and `sql.write` are declared by the capability that grants them, and any other effect name is an error. Anything a library wants to say about itself beyond these is a [claim](/concepts/claims/).

Composition is one rule, checked structurally: a callee's effect set must be a subset of the caller's. Calling `log_run`, which may `sql.write`, from `monthly_totals` is diagnostic `E0201 undeclared effect`, and the fix is not to add `sql.write` to the report — it is to move the logging to a caller that legitimately holds write access. Higher-order functions are effect-polymorphic: `map` has whatever effects the function you pass it has, plus `alloc`.

Named predicates over effects are definable anywhere and fully checked:

```
claim Pure := effects == {}
claim Total := not diverge and not panic
claim RealtimeSafe := Total and not alloc
```
