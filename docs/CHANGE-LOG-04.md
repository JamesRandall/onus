# CHANGE-LOG-04.md — Onus specification changes: views and the DOM capability

Follows `CHANGE-LOG-03.md`. Apply after it. Adds what the workbench needs to be written in Onus: a `dom` capability, a `View` tree type, and a diff-and-patch runtime primitive. No framework. The type system and verifier are unchanged; this is one capability, one stdlib module, one runtime primitive, and a host claim.

---

## 2026-09-05 — Views and the DOM **(to apply)**

**Principle.** UI frameworks exist for human authors: syntax that reads like markup, components to reason about one piece at a time, lifecycle hooks, an ecosystem. A model needs none of that. What remains is the one non-ergonomic problem — keeping the DOM in sync with state without rebuilding it — and that is a small runtime primitive, not a dependency. A view in Onus is a pure function from state to a tree value; the tree is verifiable like any other value; only the patch step touches the DOM.

### Language spec: new §22 "Views" (insert after §21 Zones)

> ## 22. Views
>
> ### 22.1 The `dom` capability
>
> `dom.Root` is a capability granting access to one DOM subtree. It is constructed by the runtime for `main` on the `js` host only (host claim `host.js`, §19.2) and attenuated like any capability: `dom.subtree(root: Root, id: Text) -> Root` narrows to a child.
>
> Effects: `dom.read` (query layout, focus, scroll position), `dom.write` (patch the tree), `dom.event` (receive events). All three require a `dom.Root` in scope.
>
> ### 22.2 The `View` type
>
> `std.view` defines an immutable tree:
>
> ```
> union View[Msg] =
>   | Element of tag: Tag, attrs: List[Attr], children: List[View[Msg]], key: Option[Text]
>   | Text of value: Text
>   | Keyed of key: Text, child: View[Msg]
>
> union Attr[Msg] =
>   | Attribute of name: AttrName, value: Text
>   | On of event: EventKind, msg: Msg
>   | Property of name: PropName, value: Text
> ```
>
> `Tag`, `AttrName`, `PropName` and `EventKind` are closed unions of the HTML vocabulary; there is no string-tagged element. A view function is any pure function returning `View[Msg]`. Handlers are messages, not closures: an `On` carries a value of the application's `Msg` type, so a view cannot capture capabilities or perform effects, and the set of things a UI can do is the closed `Msg` union.
>
> ### 22.3 The program shape
>
> ```
> pub fn view(state: State) -> View[Msg] may alloc
> pub fn update(state: State, msg: Msg, api: ModelApi, clock: io.Clock) -> Result[State, AppError] may io.net, io.clock, alloc
> ```
>
> `std.view.run(root: dom.Root, init: State, view: fn(State) -> View[Msg] may alloc, update: fn(State, Msg) -> Result[State, E] may e) may dom.read, dom.write, dom.event, e, alloc, diverge` drives the loop: render, diff against the previous tree, patch, wait for an event, dispatch its `Msg` to `update`, repeat. `run` is the only function in `std.view` with `dom.write`; a `path` over a workbench entry may `forbid { dom.write }` on everything except `std.view.run` via `except`.
>
> Capabilities the UI needs (`ModelApi`, `io.Net`, the ledger store) are parameters of `update`, never of `view`. A view cannot reach anything; it can only describe.
>
> ### 22.4 Verifiable views
>
> Because a `View` is a value, properties over it are ordinary contracts:
>
> ```
> property every_button_has_handler(s: State) {
>   forall v: View[Msg] in View.descendants(of: view(state: s)) where v is Element(tag: Button, ..):
>     exists a: Attr[Msg] in v.attrs: a is On(event: Click, ..)
> }
>
> property labelled_inputs(s: State) {
>   forall v: View[Msg] in View.descendants(of: view(state: s)) where v is Element(tag: Input, ..):
>     View.has_label(tree: view(state: s), for: v)
> }
> ```
>
> `std.view` ships a small set of such properties (buttons have handlers, inputs have labels, images have alt text, no nested interactive elements) that an application opts into per view function with `claims view.accessible`. Accessibility becomes a claim, propagated and reported like any other.
>
> ### 22.5 Runtime primitive
>
> One addition to the primitive surface (§19.1): `dom.patch(root, previous: View, next: View)` — diff two trees and apply the minimal set of DOM mutations. Keyed children reorder by key; unkeyed children reconcile positionally. Events are delivered as `(EventKind, path-to-node)` pairs and mapped back to `Msg` by the runtime from the current tree. The primitive is perhaps two hundred lines in the JS runtime; on native and WASM targets it is unavailable (`E0800`) unless a host provides a DOM.
>
> ### 22.6 What is absent
>
> No component abstraction beyond functions; no local component state (all state is in `State`); no lifecycle hooks; no context or dependency injection (capabilities are parameters); no string-tagged elements; no inline styles as strings (a `Style` union in `std.view`, closed, with a `Custom` variant that carries `host.js`); no templating syntax.

### Grammar (§2.3)

No change. Views are ordinary values and functions. `is` in the property examples is the existing pattern test on unions; if the parser does not yet support `expr is pattern` in expression position, add:

```
cmp_expr    = add_expr [ CMP_OP add_expr | "is" pattern ] ;
```

### Implementation spec

**§5 Runtime.** Add `dom.ts` to the JS runtime: `Root` capability, `patch`, event delivery, `subtree`. Native and WASM runtimes return `E0800` for any `dom.*` primitive.

**Stdlib.** Add `std/view.onus`: `View`, `Attr`, `Tag`, `AttrName`, `PropName`, `EventKind`, `Style`, `run`, `descendants`, `has_label`, and the accessibility properties. Written in Onus, verified like everything else. This is the first stdlib module written against the self-hosted compiler and should be treated as a fixture for it.

**Milestones.** Add **M15 — Views.** `dom` capability, `dom.patch`, `std.view`, the accessibility claim set. Accept: a counter application (state, `view`, `update`) runs in a browser from the JS target; `every_button_has_handler` is proved for it; `forbid { dom.write }` on a path rejects a direct `dom.write` outside `std.view.run`; the same source built for native fails with `E0800` naming the primitive.

**M10 (review tool)** is redefined: the workbench's logic — path layout, interface diff rendering, ledger queries, the task queue — is written in Onus against `std.view`, in a `draft` zone, and promoted when its audit is clean. The hand-written TypeScript shell is reduced to bootstrapping `main` and nothing else. Reorder: M15 before M10's rewrite.

### Loop spec

No change. The workbench's `update` is where the loop's task-creating moves live; they were already structured. Design mode (draft zone) is the state in which the workbench itself is being built.

### Codebase now

Nothing until the self-hosted compiler is stable enough to compile `std.view`. When it is, `dom.patch` in the JS runtime is the only piece of TypeScript to write; everything else is Onus.

---

## Not changed, but decided

- No UI framework, ever. `std.view` is a tree type and a patch primitive.
- Views are pure and handlers are messages. A view cannot perform effects or hold capabilities.
- Accessibility is a claim, not a lint. It propagates and it appears in the ledger.
- The workbench is written in Onus. The only TypeScript in it is `dom.patch` and the bootstrap.
