# CHANGE-LOG-02.md — Onus specification changes: testing

Follows `CHANGES.md`. Apply after it. Adds the testing model to `onus-spec-v0.md` and `onus-impl-spec-v0.md`. Nothing here changes the type system or the verifier; it adds two syntax forms, two ledger fields, two `onus test` modes, and one reported metric.

---

## 2026-09-03 — Testing model **(applied to docs; code pending: the M8 and M10 additions, then M13)**

**Principle.** Behaviour is established by contracts (proved) or by examples and properties (checked); dependencies are supplied as capabilities and faked in test modules; only `assume` leaves need testing against reality. There is no assertion library, no mocking library, and no separate test runner: the assertion language is the contract language, the mock mechanism is `fake`, and the runner is the compiler.

### Language spec: new §20 "Testing" (insert after §19 Targets)

> ## 20. Testing
>
> ### 20.1 What is tested and where
>
> | Concern | Mechanism | Lives in |
> |---|---|---|
> | Behaviour, all inputs | `requires` / `ensures` / `invariant`, proved | the function's interface |
> | Behaviour, specific inputs | `example` (§5.2) | the function's interface |
> | Behaviour, generated inputs | `property` (§5.2) | the function's interface |
> | Dependencies | capabilities passed as parameters; `fake` (§8.4) | `test module` |
> | Scenarios across modules | `example` blocks in a `test module`, with fakes at the edges | `test module` |
> | Contact with reality | `verify` blocks on `assume` leaves (20.2) | next to the assumption |
> | Regressions | `example` blocks pinned from counterexamples (loop spec §7) | the function's interface |
> | Strength of the contracts | regeneration audits (loop spec §8) and contract mutation (20.4) | `onus test` |
>
> There is no test tree parallel to the source. An example is attached to what it exemplifies.
>
> Functions with the `nondet` effect take their source of nondeterminism (`io.Clock`, `io.Rand`) as a capability, so a test supplies a fixed one. A test that could be flaky is not expressible.
>
> ### 20.2 Assumption verification
>
> An `assume` may carry a `verify` block: an Onus function body that exercises the assumption against the real resource and yields `Bool`.
>
> ```
> assume Idempotent "Vendor API deduplicates on req.key for 24h; see contract §4.2"
>   verify(client: payments.Client) may io.net, alloc {
>     let a: Receipt = try payments.charge(client: client, key: "verify-1", amount: 100) else _: false
>     let b: Receipt = try payments.charge(client: client, key: "verify-1", amount: 100) else _: false
>     a.id == b.id
>   }
> ```
>
> - The block's parameters are capabilities, supplied by the environment running `onus test --assumptions`, never constructed by the block.
> - The block declares its effects like any function and may not exceed the effects of the function containing the `assume`.
> - `verify` blocks are never run by `onus check`; they run only under `onus test --assumptions`, which is expected to be pointed at a staging or test environment.
> - An `assume` without a `verify` block is permitted and is reported as *unverifiable* in the ledger.
>
> ### 20.3 Ledger fields
>
> Each `assume` entry in the ledger (§9.1, §11.1) gains:
>
> - `verifiable: bool` — whether a `verify` block exists.
> - `last_verified: { at: timestamp, target: string, result: "passed" | "failed" } | null` — recorded by `onus test --assumptions`, persisted in `.onus/ledger/`.
>
> The review tool shows assumptions as *assumed, verified <when> against <target>* or *assumed, unverified*. A `path` may require `policy verified_assumptions_only`, which fails the build if any reachable `assume` lacks a passing verification within a repository-configured age.
>
> ### 20.4 Contract mutation
>
> `onus test --mutate` weakens contracts one at a time and reports which weakenings no example or property detects. Mutations applied, per obligation: drop an `ensures` clause; replace a refinement bound with its base type; negate a guard in a `property`; drop a `law`. A mutation that survives — every example and property still passes — is reported as `M0001 undetected contract weakening` with the mutation and the function. It is not an error; it is the signal that the examples are not carrying the contract's meaning.
>
> Mutation never touches bodies. Bodies are the model's; weakening them is what the loop already does implicitly by regenerating.
>
> ### 20.5 Obligation coverage
>
> The reported test metric is obligation coverage, per module and per path:
>
> - obligations proved;
> - obligations checked, and of those, how many are exercised by at least one `example` or `property`;
> - assumptions, and of those, how many are verifiable and how many have a current passing verification;
> - contract mutations detected versus surviving.
>
> Line coverage is not reported and cannot be enabled.
>
> ### 20.6 The runner
>
> `onus test` evaluates `example` and `property` blocks (already done by `onus check`), runs `test module`s, and on multi-target builds runs everything on each target, reporting disagreement as `E0801` (§19.5). `onus test --assumptions` runs `verify` blocks against supplied capabilities. `onus test --mutate` runs contract mutation. There is no plugin mechanism and no configuration file beyond the repository's target and environment settings.

### Grammar (§2.3)

```
stmt        = ...
            | "assume" TNAME STRING [ NL verify_block ]
verify_block = "verify" "(" [ params ] ")" [ "may" effects ] block ;
```

`verify` is a reserved word.

### Implementation spec

**§4 Passes.** Pass 9 (claims) records `verify` blocks on `assume` sites; they are type- and effect-checked like functions in pass 4/6 but excluded from codegen except under `--assumptions`.

**§5 Runtime.** `.onus/ledger/` gains `assumptions.json`, keyed by module and `assume` location hash, holding `last_verified`.

**§7 Reports.** `interface.json` and `path.json` gain the two ledger fields per assumption and an `obligation_coverage` block per module/path.

**Milestones.** Add to **M8** (claims, capabilities, paths): `verify` blocks parsed, checked, and stored; `onus test --assumptions` runs them against capabilities constructed from a repository config; ledger fields populated; `policy verified_assumptions_only`. Accept: the checkout example's `Idempotent` assumption has a `verify` block that passes against a fake payments service and the path report shows it as verified.

Add to **M10** (review tool): assumption freshness shown in the path and ledger views.

Add **M13 — Contract mutation and coverage.** `onus test --mutate` with the four mutation kinds; `M0001` reporting; obligation coverage in `interface.json`, `path.json` and the review tool. Accept: dropping the `ensures` on `recent_orders` is detected by its property; dropping a deliberately unexercised refinement in a fixture survives and is reported.

### Codebase now

Nothing until M8. The `fake` mechanism and `test module` already planned for M8 are the foundation; `verify` blocks reuse the same capability-construction path.

---

## Not changed, but decided

- There is no assertion library. Contracts are the assertion language.
- There is no mocking library. Capabilities and `fake` are the whole mechanism.
- There is no separate test runner or plugin system. `onus test` is the compiler.
- Line coverage is not a concept in Onus.
