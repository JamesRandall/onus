---
title: Capabilities
weight: 50
summary: An unforgeable value that grants access to a resource. It can be handed down and narrowed, never acquired or widened.
spec: "spec §8"
specurl: /spec/#8-capabilities
---

A capability is a value that grants access to a resource — a file system, a database connection — and that cannot be forged. The only way to get one is to be handed it, and it can only be narrowed on the way down: a read-write database handle can become a read-only one, never the reverse. Because effects require a capability in scope, "this function cannot write" is not a rule about the function; it is a fact about what it was given.

```
capability Db[const mode: DbMode]
  grants sql.read when mode == ReadOnly or mode == ReadWrite
  grants sql.write when mode == ReadWrite
```

Capability types have no public constructor. Root capabilities — the network, the file system, the environment, the clock — are constructed by the runtime and given to `main`, which is the only function allowed to name them as parameters, and it receives exactly the ones it names:

```
pub fn main(args: List[Text], env: io.Env, files: io.Files, net: io.Net)
  -> Result[Unit, AppError] may io.env, io.file, io.net, alloc
```

A program whose `main` does not name `io.Net` cannot, anywhere, open a socket; there is no other source of a `Net` capability. Library functions that produce capabilities take a root one as an argument (`sql.connect(net: net, ...)`) so the derivation is visible in the signature.

Attenuation is total and pure; it can only remove authority:

```
let ro: sql.Db[ReadOnly] = sql.narrow(db: rw, to: ReadOnly)
let orders: sql.Db[ReadOnly, schema: "orders"] = sql.restrict(db: ro, schema: "orders")
```

Capabilities are ordinary parameters and nothing else: they may not be stored in records or captured by closures, so the flow of authority is visible in every signature it passes through. Where a capability is constructed, the ledger records the configuration the guarantee depends on — for a read-only connection, that the database role was not granted write privileges after the connect-time check — so the reviewer's view of any path using it says where the guarantee bottoms out.

Because they are unforgeable, ordinary code cannot fake one for a test. A module declared `test module` may construct any capability with `fake` and a behaviour table; a fake grants the same effects as the real thing, so effect checking of the code under test is unchanged, and only the resource behind it differs.
