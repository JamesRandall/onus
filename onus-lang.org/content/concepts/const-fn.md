---
title: Compile-time functions
weight: 110
summary: Ordinary Onus that the compiler runs while checking. How a library validates your SQL at compile time without a macro or a plugin.
spec: "spec §3.8"
specurl: /spec/#38-compile-time-constants
---

A `const fn` is ordinary Onus that the compiler runs while checking. Libraries use it to bring their own validators: the SQL library ships a parser that checks your query text at compile time, and a mistake is reported at the character in the string. There are no macros or compiler plugins; this is the whole extension mechanism.

```
-- in std.sql, ordinary Onus, verified like everything else
pub const fn parse_select(text: Text) -> Result[SelectAst, ConstError] may alloc

pub const fn columns_match(text: Text, record: TypeInfo) -> Result[Unit, ConstError] may alloc

pub intrinsic fn select[const text: Text, T](params: List[Param], row: TypeInfo) -> Select[T]
  requires proved parse_select(text: text) is Ok
  requires proved columns_match(text: text, record: row) is Ok
```

A `const` parameter — `[const text: Text]` — demands a value known at check time. When the reporting example calls `sql.select[text: "select ... from orders where ..."]`, the compiler evaluates `parse_select` on that literal during checking. If it returns an error, the diagnostic is `E0700 library check failed`, positioned at the offending character inside the string, not at the call. `columns_match` receives the row type as a `TypeInfo` value — its fields, names and refinements — and compares them to the columns the parser projected, so a field/column mismatch is a compile error too.

The rules keep this safe. A `const fn` must be pure apart from allocation, total, and have every obligation proved, so the check-time evaluator always terminates and never panics. Evaluation runs under the same per-obligation budget as the solver, so a library cannot make checking slow without the diagnostic saying which function did it.

A `const fn` may also return a `Spec` — a value of the contract language's own syntax tree — which a `requires` or `ensures` clause can consume as a predicate. That is how a `where` clause in a query becomes a postcondition about the rows it returns, without the compiler knowing anything about SQL. The design intent is exactly that ignorance: the compiler has no knowledge of SQL, regular expressions, date formats or URLs. A library that wants its literals checked writes the checker in Onus, ships it, and gets the same diagnostics and the same verification of its checker as user code.
