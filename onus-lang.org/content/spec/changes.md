---
title: Changes
layout: changes
weight: 50
lede: Every change to the specification since it was written, dated. Useful precisely because it shows the design moving and why.
---

Two kinds of change are recorded. The **change logs** are the spec author's: each entry says what changed in the documents and what the codebase must do about it, and is marked *(to apply)* until the code has caught up. The **changes forced by implementation** are the compiler's: each is a rule that turned out unworkable or underspecified when built, marked in the spec text with `changed:` and pinned by a fixture. Nothing is changed silently, in either direction.
