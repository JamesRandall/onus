---
title: Sealed types
weight: 90
summary: Readable anywhere, constructible only in its own module. A value of the type is evidence that the module's check ran.
spec: "spec §3.10"
specurl: /spec/#310-visibility-and-sealed-types
---

A `sealed` type can be read anywhere but constructed only inside the module that defines it. That makes a value of the type *evidence*: if the only way to obtain an `AuthedCustomer` is through the auth module's check, then any function that demands one can only run after that check. Ordering rules become types.

```
module app.auth

-- AuthedCustomer is evidence: only `require` produces one.
pub sealed record AuthedCustomer {
  id: Text
}

pub fn require(service: Service, caller: Text, customer: Text, clock: io.Clock)
  -> Result[AuthedCustomer, Error] may io.net
  ensures result is Ok implies caller == customer
{
  if caller == customer {
    return Ok(value: AuthedCustomer { id: customer })
  }
  return Err(error: Unknown(caller: caller))
}
```

Anywhere else, `AuthedCustomer { id: "x" }` is a compile error, and so is `{ who with id: "x" }`. So a function that takes one —

```
fn load_basket(
  db: sql.Db[ReadOnly],
  who: auth.AuthedCustomer
) -> Result[Basket, sql.Error] may sql.read, alloc
```

— has "the caller has been authenticated" as a precondition that needs no contract and no solver: the type system checks it, at every call site, forever. The path report draws this as a *gate*: the region of the graph that is callable only with the evidence, and the one function that produces it.

`sealed` is the whole mechanism for typestate in Onus. There is no separate feature for "a connection that has been opened" or "a request that has been validated"; each is a sealed type returned by the function that establishes the state. A `test module` may call sealed constructors of the modules it imports, which is how a test gets an `AuthedCustomer` without a real auth service.
