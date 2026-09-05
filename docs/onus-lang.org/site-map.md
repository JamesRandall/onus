# onus-lang.org — site map and content plan

Six pages plus a comparison. Every page is sourced from documents that already exist; the mapping below says which sections go where and what needs writing fresh. Tone throughout: the pitch's — plain statements, no hero copy, no gradient headings, code where a sentence would be vaguer.

---

## 1. Home — `/`

**Purpose.** State the thesis in under a screen, show one thing that no other language site can show, and route people to the right depth.

**Content, in order.**

1. Title and one line: *A programming language for code that a model writes and a person has to trust.* (pitch, title)
2. "The problem" — the steering-and-verifying paragraph. (pitch §The problem)
3. "What Onus does" — the seven bullets. (pitch §What Onus does)
4. "What it looks like" — the `recent_orders` signature and its two-sentence reading. (pitch)
5. **The ledger, live.** The checkout path report rendered from real compiler output: the graph with the one amber leaf, and the four ledger rows beneath. Caption: *This is the review artefact for the checkout endpoint. Bodies are not shown because the reviewer does not need them.* Until the compiler emits it, use the mock, labelled as a mock.
6. "One example" — the `E0201` walkthrough. (pitch §One example)
7. Three links: *In practice* → `/practice`, *Read the specification* → `/spec`, *Status* → `/status`.

**Fresh writing needed.** The caption in 5. Nothing else.

---

## 2. In practice — `/practice`

**Purpose.** For the reader who accepts the thesis and wants to know what a real project looks like.

**Content.**

1. "A project is not uniformly trusted" — zones, promotion, the invariant. (pitch §A project is not uniformly trusted)
2. "An HTTP API" — the router, three paths, the policy explained, forty path reports. (pitch §A concrete example)
3. "Testing" — the where-things-live table and the `verify` block example, with one paragraph each on assumption verification and contract mutation. (CHANGE-LOG-02 §20.1, §20.2, §20.4)
4. "The loop" — one screen: what the model sees, the cycle, the one rule (bodies, never claims), proposals. (loop spec §1, §3, §4 condensed)
5. "The workbench" — what review looks like: path view, interface view, diff view, promotion. Two screenshots when they exist; the mocks until then, labelled. (spec §15)

**Fresh writing needed.** Condensing the loop spec to one screen; a paragraph introducing the workbench. Both short.

---

## 3. Specification — `/spec`

**Purpose.** The normative document, readable online with navigation.

**Content.** `onus-spec-v0.md` as-is, with:

- a left sidebar of §1–§22 (after the changelogs are folded in: §19 Targets, §20 Testing, §21 Zones, §22 Views become real sections);
- the three worked examples as their own sub-pages, each with its ledger beneath it once the compiler emits it;
- a version line at the top: *v0 — provisional sections marked. Changes are recorded in the changelog.*

**Fresh writing needed.** None; the work is folding CHANGES.md and CHANGE-LOG-02/03/04 into the spec body so the site doesn't publish changelogs as if they were chapters. That's an editorial pass, not new content.

**Sub-page: `/spec/changes`.** The changelogs, verbatim, dated. Useful precisely because they show the design moving and why.

---

## 4. Environment — `/environment`

**Purpose.** The argument that this is a platform, for the reader who got that far.

**Content.**

1. The nine-part map — the diagram from the conversation, and the table (part, owns, reduces, status). (conversation, 5 Sep)
2. One paragraph per part, linking to the relevant spec section or document: language and compiler → `/spec`; loop → loop spec; ledger → spec §9.1, §11.1, CHANGE-LOG-02 §20.3; review tool → spec §15; zones → §21; targets → §19; task intake, telemetry, registry → marked *not yet specified*, one sentence each on intent.
3. "What we haven't built" — an honest list, dated. Task intake, telemetry, registry, concurrency, FFI beyond `assume`.

**Fresh writing needed.** The nine short paragraphs in 2, and the list in 3. Perhaps 600 words.

---

## 5. Status — `/status`

**Purpose.** Dated truth. This page is what makes the rest credible.

**Content.** A table, updated whenever it changes:

| Milestone | State | Date |
|---|---|---|
| M1–M8 language, verification, capabilities, paths | done | … |
| M9 constrained decoding (`onus next`) | done | … |
| Self-hosted compiler | in progress / done | … |
| Native target via LLVM | done | … |
| M10 workbench | in progress | … |
| M11–M15 | planned | — |

Below it: the three examples with their current ledger numbers on both targets, and a one-line note of any spec change in the last month. Nothing aspirational on this page.

**Fresh writing needed.** The table, kept current. It's the cheapest page and the most important one.

---

## 6. Concepts — `/concepts`

**Purpose.** Plain explanations of the parts Onus is built from, for a reader who has never met them. Each is one screen: what it is, why Onus uses it, one small example, a link to the spec section. No page assumes another has been read. The drafts below are the paragraph each page opens with.

**Pages.**

**Contracts.** A contract is a statement about a function that the compiler checks: what must be true before it runs (`requires`), what it promises when it finishes (`ensures`), and what stays true throughout a loop (`invariant`). In most languages this is a comment or a test. In Onus it is part of the function's type, and the compiler either proves it holds for every input, inserts a runtime check, or refuses the program. → spec §5

**Obligations and the solver.** Every contract, refinement and bound generates an *obligation*: a small logical statement the compiler has to establish. Onus hands each one to a *solver* — a program that decides whether a logical statement can be false. If the solver finds no way to make it false, the obligation is proved and no code is emitted for it. If it finds a way, that is a *counterexample*: concrete values that break the contract, shown to you. If it can't decide within a budget, the obligation becomes a runtime check. Onus uses Z3, a mature solver from Microsoft Research; it is not part of the language, and could be swapped. → spec §12

**Refinement types.** A refinement narrows a type with a condition: `Int where 0 <= it and it <= 255` is an integer that carries proof of its range wherever it goes. Passing a plain `Int` where a refined one is expected creates an obligation; the solver discharges it from what is known at that point in the code. Refinements are how "this index is in bounds" or "this count is never negative" stop being things you remember and start being things the compiler knows. → spec §3.2

**Effects.** An effect is something a function does beyond computing a result: reading a file, writing to a database, allocating memory, possibly not terminating. In Onus a function's effects are listed in its signature after `may`, and a function may only call functions whose effects fit inside its own. A function with no `may` clause is pure and cannot touch anything. This is what lets the compiler prove that a report handler, and everything it calls however deep, never writes. → spec §6

**Capabilities.** A capability is a value that grants access to a resource — a file system, a database connection — and that cannot be forged. The only way to get one is to be handed it, and it can only be narrowed on the way down: a read-write database handle can become a read-only one, never the reverse. Because effects require a capability in scope, "this function cannot write" is not a rule about the function; it is a fact about what it was given. → spec §8

**Claims and assumptions.** A claim is a named property that travels through the call graph: a function may carry it only if everything it calls does too. Some claims the compiler understands directly; some are defined in terms of those; and some — "this vendor's API is idempotent" — cannot be checked by anyone. The last kind are introduced with `assume`, which records where trust enters and why, and the ledger lists every one. → spec §7

**Paths.** A path names an entry point — a route handler, a job, `main` — and states what everything reachable from it may do, must guarantee, and may assume. The compiler walks the call graph and checks the whole region at once. It is how a critical section of a program gets a guarantee declared once at the top rather than repeated in every function. → spec §9

**The ledger.** Every obligation ends in one of three states: *proved*, *checked* at runtime, or *assumed*. The ledger is the record of which, for every obligation in the program, along with every assumption, every runtime-check site, and where each capability was constructed. It is what a reviewer reads instead of the code. → spec §11, §12.2

**Sealed types.** A `sealed` type can be read anywhere but constructed only inside the module that defines it. That makes a value of the type *evidence*: if the only way to obtain an `AuthedCustomer` is through the auth module's check, then any function that demands one can only run after that check. Ordering rules become types. → spec §3.10

**Canonical form.** There is exactly one way to format an Onus program, and the compiler enforces it. Diffs become semantic, style debates do not exist, and a model never spends effort on layout. → spec §2.2

**Compile-time functions.** A `const fn` is ordinary Onus that the compiler runs while checking. Libraries use it to bring their own validators: the SQL library ships a parser that checks your query text at compile time, and a mistake is reported at the character in the string. There are no macros or compiler plugins; this is the whole extension mechanism. → spec §3.8

**Zones.** Every module is in a zone — draft, hardened or critical — that sets how strict the rules are and what the model may change. Nothing at a higher zone may depend on a claim from a lower one. Promotion is earned by throwing the module's bodies away and regenerating them from its interfaces; what doesn't come back was never written down. → spec §21

**The loop.** The loop is the component that drives a model against the compiler: it takes a task, has the model write bodies, checks, feeds back the diagnostics, and repeats until everything is proved or checked. It never edits a contract to get there; if it can't satisfy one, it stops and proposes a change for a person to accept. → loop spec

**The workbench.** The review tool. It renders the ledger, the path reports and interface diffs; it is where a person approves changes, answers counterexamples, and decides what the model does next. It computes nothing; everything it shows is compiler output. → spec §15

**Fresh writing needed.** The paragraphs above are the openers; each page wants one small code example under it (most exist in the spec) and a link. About 200 words per page beyond what's here.

---

## 7. Compared — `/compared`

See `comparison.md`. One paragraph per language, fair, with what Onus takes from each and where it differs.

---

## Global

- **Footer on every page:** *Onus is being built in the open. The compiler is written in Onus. Specification v0, last changed <date>.*
- **No newsletter, no "get started" button until there is something to start with.** When the CLI is installable, `/start` gets added with the actual commands and nothing else.
- **Repository links:** `github.com/onus-lang/onus` (compiler, stdlib, runtime), `github.com/onus-lang/workbench`, `github.com/onus-lang/site`.
- **Later:** the site itself as an Onus program compiled to JS, with its interface documents published at `/spec/site`. Not before M15.
