# Onus

**A programming language for code that a model writes and a person has to trust.**

## The problem

Most of the effort in AI-assisted development now goes into steering: prompt wording, conventions documents, linters bolted on after the fact, and review that means reading every line the model produced. The specification of what the code must not do lives in prose, and prose is not enforced. When the model gets it wrong, someone notices — or doesn't — after the fact.

That is a language problem, not a prompting problem. Current languages were designed so a human could write them quickly. They trade checkability for convenience at every turn: inferred types, implicit conversions, reflection, exceptions, ambient state. None of that convenience helps a model, and all of it hides things a reviewer needs to see.

## What Onus does

Onus moves the constraints out of the prompt and into the compiler.

- **Pure by default.** A function that can touch a file, the network, or a database says so in its signature, and the compiler proves that nothing beneath it does anything it didn't declare.
- **Authority is handed down, never acquired.** Access to a resource is a value that only the program's root can create and that can only be narrowed on the way to the code that uses it. A function that receives a read-only database handle cannot write, because it has nothing to write with.
- **Contracts are checked, not commented.** Preconditions, postconditions and invariants are part of the language. Each one ends up in exactly one of three states — proved by the compiler, checked at runtime, or explicitly assumed — and the compiler tells you which.
- **Critical paths are declared once.** A `path` declaration states what a section of the program may do, and the compiler checks every function reachable from it. If the path declaration is right and the program compiles, the bodies don't matter.
- **Everything the reviewer needs is in the interface.** Signatures, contracts, effects, examples, assumptions. Bodies are the model's problem. The review tool shows what you are trusting, where each guarantee bottoms out, and what changed — without a source diff.
- **One compiler, no linter.** There are no warnings and no configurable rule sets. A convention that matters becomes a claim or a path rule and is checked like everything else.

## What it looks like

```
fn recent_orders(db: sql.Db[ReadOnly, schema: "orders"], who: auth.AuthedCustomer)
  -> Result[List[Order], sql.Error] may sql.read, alloc
  ensures forall o: Order in result: o.customer == who.id
```

The signature says: read-only access to one schema, a caller who has already passed authentication (the type can only be produced by the auth module), no other effects, and every returned order belongs to that customer. The compiler proves the last claim from the query itself. A reviewer reads this line and moves on.

## One example

A team's conventions document says: *reporting code must never write to the database.* Today that lives in a prompt, a checklist, and a reviewer's memory. In Onus it is the function's own signature:

```
pub fn monthly_totals(db: sql.Db[ReadOnly], year: Int)
  -> Result[List[MonthlyTotal], sql.Error] may sql.read, alloc
```

`may sql.read, alloc` is the complete list of what this function may do, and everything it calls must fit inside it. The model, asked to add run logging, writes an `insert` into a helper the report calls. The build fails before anyone sees it:

```
reporting.onus:17:3: E0201 undeclared effect
  in monthly_totals
  calling `log_run` has effect `sql.write`, which `monthly_totals` does not declare
```

The model reads the diagnostic, moves the logging to the caller that holds write access, and the build is green. No prompt was edited, no reviewer read a diff, and the rule cannot be forgotten by the next model or the next person, because it is not advice — it is the function's type. For rules a signature can't express — required guarantees, which assumptions are acceptable, what must hold across a whole critical section — a `path` declaration applies the same check over every function reachable from an entry point.

## Why now

None of the pieces are new. Contracts shipped in Eiffel, JML and .NET Code Contracts; effect systems, refinement types, capability security and SMT solvers are all decades old. What shipped, though, was mostly runtime checking: an `assert` with a nicer name, which told you about a violation after it happened. The tools that proved contracts at compile time stayed in research, for two reasons — the annotations proving needs (invariants, measures, precise types) were a real burden on a human author, and the verifiers were slow and failed on things that were obviously true.

Both have changed. Solvers now cover most of what real code needs to prove, quickly. And the annotations are no longer a person's cost: verbosity costs tokens, being wrong costs trust. Onus still falls back to a runtime check where a proof isn't available — the difference is that it tells you exactly which obligations did, instead of checking everything at runtime and calling it a contract.

## What it doesn't do

Onus does not make the specification correct. If the contract says the wrong thing, the compiler will faithfully enforce the wrong thing. What it does is make that the only kind of mistake left, and make it visible in a place a person can actually read.

## Status

The v0 language specification and all thirteen milestones of its implementation plan are done: the compiler, runtime, standard library and review tool, in TypeScript, with z3 discharging obligations, and two backends from one lowering — JavaScript, and native code through LLVM (WebAssembly through the same path, untested for want of a toolchain). Three worked examples — a Mandelbrot renderer, a read-only SQL report, and a payment endpoint — exercise every mechanism in the language and pass end to end: Mandelbrot's ledger is fully proved and its examples agree on both targets, the report runs against Postgres on both targets with no assumptions on its path, and the checkout path passes with exactly one external assumption, named and verifiable. `onus test` reports obligation coverage and, with `--mutate`, which contract weakenings the examples fail to detect. Next: the regeneration loop that drives a model against the compiler, specified as a candidate in `onus-loop-v0.md`.
