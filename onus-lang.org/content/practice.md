---
title: In practice
lede: For the reader who accepts the thesis and wants to know what a real project looks like.
---

## A project is not uniformly trusted

Trust in Onus is per artefact: interfaces are the human's, bodies are the model's, and the ledger records what each obligation rests on. A project is not uniformly trusted at any moment in its life — a hardened core coexists with a subsystem being prototyped against it — so strictness is declared per module, and the only rule that matters is that **nothing at a higher level of trust ever rests on a claim from a lower one.**

Every module belongs to exactly one *zone*:

| Zone | Meaning |
|---|---|
| `draft` | Being designed. The ledger is recorded but not authoritative. Interfaces may change freely, by human or model. Bodies may be human-edited. |
| `hardened` | In service. Interfaces are the human's, bodies are the model's. The ledger is authoritative. |
| `critical` | In service and load-bearing. `hardened`, plus every public entry is on a `path`; no unverified assumptions; no `recover`; no `checked` obligation without an exercising `example` or `property`. |

Zones are declared in the project manifest, not in modules, because a zone change is a decision about the project and its diff is what a reviewer approves:

```toml
[zones]
"app.core.*"      = "critical"
"app.reporting"   = "hardened"
"app.payments.*"  = "draft"
default           = "draft"

[zones.exceptions]
"app.core.checkout" = { third_party_assumes = ["vendor.payments.charge"] }
```

**The dependency rule.** A module may depend on another module's interface only if that interface is at the same zone or higher. `draft` may depend on anything; `critical` may depend only on `critical`. One exception makes integration possible: a `draft` module may mark individual public items `hardened`, and a hardened or critical module may depend on those items — and only those. A hardened item in a draft module is checked to the hardened standard; its body remains draft. This is how a new subsystem is built against a stable core: harden the boundary first, and the core is permitted to see only the boundary.

```
-- in a draft module
pub hardened fn charge(client: Client, req: ChargeRequest)
  -> Result[Receipt, Error] may io.net, alloc
  ensures ...
```

**Promotion.** `onus zone promote <module> <zone>` runs the regeneration audit on the module at the target zone's standard: bodies are thrown away and regenerated from interfaces alone, and every finding becomes a proposal. Promotion succeeds only when the audit reports no findings and the zone's policies pass. What doesn't come back was never written down. Demotion is always permitted and always recorded; it marks every dependent's guarantees that rest on the demoted module as *conditional* until it is promoted again. There is no manual override.

<div class="note">Zones are specified — <a href="/spec/changes/#log-3">change log 3, 5 September 2026</a>, adding §21 to the language spec — and not yet implemented. The <a href="/status/">status page</a> says when that changes.</div>

## An HTTP API

A service has entry points; each one is a `path`. Take a shop with three: a public catalogue, a checkout, and a nightly export for finance. Their handlers are ordinary functions whose signatures already say most of what matters — which capabilities they hold, what they may do, what they claim:

```
pub fn list_products(db: sql.Db[ReadOnly, schema: "catalogue"], page: Int where it >= 0)
  -> Result[List[Product], sql.Error] may sql.read, alloc

pub fn handle_checkout(
  req: Request,
  clock: io.Clock,
  db: sql.Db[ReadWrite, schema: "orders"],
  pay: payments.Client,
  auth: auth.Service
) -> Result[payments.Receipt, CheckoutError] may sql.read, sql.write, io.net, io.clock, alloc
  claims Idempotent

pub fn export_orders(
  db: sql.Db[ReadOnly, schema: "orders"],
  files: io.Files,
  year: Int where 2000 <= it and it <= 2100
) -> Result[Unit, ExportError] may sql.read, io.file, alloc
```

Put those three handlers in a module `app.shop`. The router is the rest of it. `main` is the only function that receives root capabilities — the environment, the file system, the network, the clock — and it constructs everything else from them: the database connection from `net`, the vendor clients from `net`. Then, per request, `route` narrows what it holds to what each handler is allowed and calls it. A handler cannot reach anything `route` did not give it, because there is nowhere else to get it from.

```
union Route =
  | GetCatalogue of page: Int where it >= 0
  | PostCheckout of req: Request
  | GetExport of year: Int where 2000 <= it and it <= 2100

union RouteError =
  | Db of detail: sql.Error
  | Purchase of detail: CheckoutError
  | Export of detail: ExportError

record Reply {
  status: Int where 200 <= it and it < 600
  body: Text
}

-- The router holds the widest authority in the program and hands each handler
-- exactly the slice it needs. The signature is the complete list of what any
-- request can do.
fn route(
  r: Route,
  db: sql.Db[ReadWrite],
  files: io.Files,
  clock: io.Clock,
  pay: payments.Client,
  auth: auth.Service
) -> Result[Reply, RouteError] may sql.read, sql.write, io.net, io.file, io.clock, alloc {
  match r with
  | GetCatalogue(page) -> {
    let ro: sql.Db[ReadOnly] = sql.narrow(db: db, to: ReadOnly)
    let catalogue: sql.Db[ReadOnly, schema: "catalogue"] = sql.restrict(db: ro, schema: "catalogue")
    let products: List[Product] = try list_products(db: catalogue, page: page) else e: Db(detail: e)
    return Ok(value: Reply { status: 200, body: products_json(products: products) })
  }
  | PostCheckout(req) -> {
    let orders: sql.Db[ReadWrite, schema: "orders"] = sql.restrict(db: db, schema: "orders")
    let receipt: payments.Receipt = try handle_checkout(req: req, clock: clock, db: orders, pay: pay, auth: auth)
      else e: Purchase(detail: e)
    return Ok(value: Reply { status: 201, body: receipt_json(receipt: receipt) })
  }
  | GetExport(year) -> {
    let ro: sql.Db[ReadOnly] = sql.narrow(db: db, to: ReadOnly)
    let orders: sql.Db[ReadOnly, schema: "orders"] = sql.restrict(db: ro, schema: "orders")
    try export_orders(db: orders, files: files, year: year) else e: Export(detail: e)
    return Ok(value: Reply { status: 202, body: "" })
  }
}

union AppError =
  | Config of detail: config.Error
  | Connect of detail: sql.Error
  | Transport of detail: io.Error
  | Handled of detail: RouteError

pub fn main(
  args: List[Text],
  env: io.Env,
  files: io.Files,
  net: io.Net,
  clock: io.Clock
) -> Result[Unit, AppError] may io.env, io.file, io.net, io.clock, sql.read, sql.write, alloc, diverge {
  let cfg: config.Config = try config.load(env: env) else e: Config(detail: e)
  let db: sql.Db[ReadWrite] = try sql.connect(net: net, dsn: cfg.orders_dsn, mode: ReadWrite)
    else e: Connect(detail: e)
  let pay: payments.Client = payments.client(net: net, key: cfg.payments_key)
  let auth: auth.Service = auth.service(net: net, issuer: cfg.auth_issuer)
  -- A server runs until stopped, so main declares diverge and the loop needs no measure.
  loop while true {
    let r: Route = try next_request(net: net) else e: Transport(detail: e)
    let reply: Reply = try route(r: r, db: db, files: files, clock: clock, pay: pay, auth: auth)
      else e: Handled(detail: e)
    try send(net: net, reply: reply) else e: Transport(detail: e)
  }
}
```

Two things to read off this. First, the catalogue handler gets a handle that has been narrowed to read-only and restricted to one schema before the call, so `list_products` could not write even if its body tried: it would have nothing to write with, and its own `may sql.read, alloc` would refuse the call anyway. Second, `main` declares `diverge` because a server does not terminate; every other function in the program is proved to. The pure helpers that render replies are elided, and `next_request` and `send` stand for a transport the standard library does not have yet — the language has capabilities for the network but no HTTP module, which the [status page](/status/) tracks.

Then three declarations state what each region of the program must satisfy, and the compiler checks every function reachable from the entry point against them:

```
path public_catalogue
  entry list_products
  effects <= { sql.read, alloc }
  forbid { sql.write, io.net, io.file }

path checkout
  entry handle_checkout
  effects <= { sql.read, sql.write, io.net, io.clock, alloc }
  require { Idempotent }
  policy no_third_party_assumes except { vendor.payments.charge }

path finance_export
  entry export_orders
  effects <= { sql.read, io.file, alloc }
  forbid { io.net }
  policy verified_assumptions_only
```

The policy on `checkout` is the interesting line. `no_third_party_assumes` forbids any `assume` outside the project and the standard library: the checkout path may not depend on a library's word about itself. The vendor's payment client cannot be checked by anyone, so the path names it as the one exception, and the exception appears in the report individually — the amber leaf on the [home page](/#the-ledger). `verified_assumptions_only` on the export path goes further: any assumption on it must have a passing `verify` run within the repository's configured age, or the build fails.

Each `path` produces one report: the reachable graph, the effects actually used against the bound, the claims, every assumption with its justification, every capability construction site, and the obligation ledger. A service with forty entry points has forty of them, each one screen, and a reviewer who has read them has reviewed the service. Nothing in a body can change what they say.

## Testing

There is no test tree parallel to the source. An example is attached to what it exemplifies, and the mechanism for each concern lives where the reviewer will look for it:

| Concern | Mechanism | Lives in |
|---|---|---|
| Behaviour, all inputs | `requires` / `ensures` / `invariant`, proved | the function's interface |
| Behaviour, specific inputs | `example` | the function's interface |
| Behaviour, generated inputs | `property` | the function's interface |
| Dependencies | capabilities passed as parameters; `fake` | `test module` |
| Scenarios across modules | `example` blocks in a `test module`, with fakes at the edges | `test module` |
| Contact with reality | `verify` blocks on `assume` leaves | next to the assumption |
| Regressions | `example` blocks pinned from counterexamples | the function's interface |
| Strength of the contracts | regeneration audits and contract mutation | `onus test` |

Functions with the `nondet` effect take their source of nondeterminism — `io.Clock`, `io.Rand` — as a capability, so a test supplies a fixed one. A test that could be flaky is not expressible.

**Assumption verification.** An `assume` may carry a `verify` block: an Onus function body that exercises the assumption against the real resource and yields `Bool`. This is the vendor assumption from the checkout example, as it is written:

{{< onus file="checkout/vendor/payments.onus" from=17 to=38 caption="The block's parameters are capabilities, supplied by the environment running `onus test --assumptions`, never constructed by the block." >}}

`verify` blocks are never run by `onus check`; they run only under `onus test --assumptions`, pointed at a staging or test environment, and the result — when, against what, passed or failed — is recorded in the ledger with the assumption. The review tool shows an assumption as *assumed, verified 4 September against staging* or *assumed, unverified*. An assumption without a `verify` block is permitted, and is reported as unverifiable.

**Contract mutation.** `onus test --mutate` weakens contracts one at a time — drops an `ensures` clause, replaces a refinement bound with its base type, negates a guard in a `property` — and reports which weakenings no example or property detects. A weakening that survives is reported as `M0001 undetected contract weakening`. It is not an error; it is the signal that the examples are not carrying the contract's meaning. Mutation never touches bodies. Bodies are the model's; weakening them is what the loop already does, implicitly, by regenerating.

The reported test metric is obligation coverage: obligations proved; obligations checked, and of those how many an `example` or `property` exercises; assumptions, and of those how many are verifiable and how many have a current passing verification; mutations detected versus surviving. Line coverage is not reported and cannot be enabled.

## The loop

The loop turns a **task** into a **change**: a set of modules whose obligations are all proved or checked, opened for human review as an interface diff. It runs unattended. A human sees its output in the review tool, not its process.

**What the model sees** is assembled from compiler output, never from source files: the target's signature, contracts, effects and examples in canonical text; the interfaces of every module in scope and every import, with bodies elided; sibling bodies in the same module, as reference for "like the other handlers"; every diagnostic from the last check, as structured JSON, not just the first; and the counterexample, if any, as concrete values against the contract text. Not shown, ever: prose conventions documents, prompt-style instructions about behaviour, other people's bodies. If a convention matters, it is a claim; if it isn't a claim, the loop doesn't know about it. This is how the underspecified remainder becomes visible rather than papered over.

**The cycle** is `generate → check → classify`, repeated. Canonical form is applied automatically, and diagnostics the compiler can fix mechanically are fixed before the model is asked again. Each check lands in one of five states: *green* (open a change), *progress* (go again with the new diagnostics), *stall* (escalate: full history, then wider context), *contract conflict* (the verifier keeps producing a counterexample that satisfies every precondition, and the model keeps proposing the same body: the contract is probably wrong; stop and say so), or *out of scope* (green would need an edit outside the task; stop and say so).

**The one rule:** the loop edits bodies; it never edits claims. Contracts, effects, claims, capabilities, paths, policies and `assume` leaves are the human's. If the loop cannot satisfy a contract, it does not weaken the contract, widen an effect set, or insert an `assume` to get green. It emits a **proposal** — a structured object, never an edit — which appears in the review tool as an interface diff marked *proposed by loop*, with the evidence attached. A human accepts, rejects, or edits. The most common proposal in practice is also the least contentious: `add_example`, when the loop noticed a case the examples don't cover and wants it pinned.

The [full loop specification](/spec/loop/) has the task kinds, the escalation ladder, budgets, regeneration audits, and what the loop is not allowed to touch. It is implemented in `packages/loop`; the [benchmark log](/status/#the-loop) records how models do against it.

## The workbench

Onus assumes the developer is reviewing, not editing. The review tool is the surface for that work, and it has one design rule: **it computes nothing**. Every view is a rendering of compiler output — interface documents, path reports, diagnostics — so there is no second analysis that can disagree with the language. Its outputs are decisions and contract edits, which return to the model as tasks.

- **Path view.** The reachable graph from a `path` entry, laid out top-down as authority flows. Edges carry effects; nodes carry claims and obligation counts. `assume` leaves and `recover` sites are the only elements rendered in colour. An unresolvable call is drawn as a break in the graph.
- **Interface view.** A module as its signatures, contracts, examples and properties, with obligation status inline. Bodies are collapsed. Expanding one is permitted and counted; body-open rate per module is reported, because a module whose bodies must be read has contracts that are not doing their job.
- **Ledger view.** Every obligation across a module or path, every `assume`, every `recover`, every capability construction site. This answers "what am I actually trusting."
- **Diff view.** Two interface documents compared. Source diffs are not shown. What is shown: added or removed items, changed signatures, widened effect sets, weakened `requires` or strengthened `ensures` (compatible) versus the reverse (breaking), new assumptions, obligations whose state moved. This is the pull-request page.
- **Counterexample view.** A failed obligation with the solver's model rendered as concrete values against the contract text. Its purpose is the one judgement that needs a human: whether the contract is wrong or the body is.
- **Promotion.** When a reviewer identifies a convention the code follows but nothing enforces, the tool drafts the enforcing declaration — a `sealed` type, a derived claim, a `path` clause, a `policy` — and files it as a change. This is the mechanism by which the underspecified remainder shrinks over time. Not yet implemented.

The pages `onus review` wrote for two of the worked examples are served here unchanged: [checkout](/review/checkout/) and [Mandelbrot](/review/mandelbrot/). They are static pages over the JSON reports beside them, which is all the tool is.
