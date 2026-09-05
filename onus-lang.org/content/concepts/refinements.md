---
title: Refinement types
weight: 30
summary: A type narrowed by a condition. An integer that carries proof of its range wherever it goes.
spec: "spec §3.2"
specurl: /spec/#32-refinement-types
---

A refinement narrows a type with a condition: `Int where 0 <= it and it <= 255` is an integer that carries proof of its range wherever it goes. Passing a plain `Int` where a refined one is expected creates an obligation; the solver discharges it from what is known at that point in the code. Refinements are how "this index is in bounds" or "this count is never negative" stop being things you remember and start being things the compiler knows.

```
type Iter  = Int where 0 <= it and it <= 10_000
type Coord = Int where 0 <= it
type Ratio = Float where 0.0 <= it and it <= 1.0

record Viewport {
  x_min: Float
  x_max: Float where it > x_min
  y_min: Float
  y_max: Float where it > y_min
}

pub fn render(
  view: Viewport,
  width: Coord where it > 0,
  height: Coord where it > 0,
  limit: Iter where it > 0
) -> Grid[Iter, width, height] may alloc
```

`it` names the value being refined. A refined type is a subtype of its base — an `Iter` can go anywhere an `Int` can — but not the reverse: flowing an `Int` into an `Iter` position is an obligation. Refinements can be written inline on parameters and fields, and a field's refinement may mention the fields before it, which is how `Viewport` promises that its rectangle is not empty.

Refinements are never inferred onto declarations. If a function's interface should promise `result >= 0`, that is written as an `ensures` or a refined return type, explicitly, where the reviewer will see it. Inside a body the compiler is more generous: after `if x < 0 { return ... }`, it knows `x >= 0` for the rest of the function without anyone saying so.

What can be proved depends on the base type. Integer refinements in linear arithmetic are proved. Those involving multiplication of two variables, division or remainder are proved where the solver can and checked at runtime otherwise. Floating-point refinements are checked at runtime. In every case the ledger says which.
