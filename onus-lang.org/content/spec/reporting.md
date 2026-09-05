---
title: "Example: monthly report"
layout: example
weight: 70
lede: The second worked example (spec §18.2). A read-only SQL report, a query checked at compile time by the SQL library's own parser, and a path that forbids writing.
params:
  example: reporting
  files: [reporting.onus, app/config.onus]
---

`monthly_totals` holds a read-only handle to one schema and may do nothing but read and allocate. The query text is a `const` parameter: `std.sql`'s `parse_select` runs while checking and rejects anything but a single `SELECT`, with the error at the character in the string. `main` is where authority enters — the root capabilities are its parameters and nowhere else — and where it is narrowed before being handed down. The `path` at the end states the rule the pitch's example is about, once, for everything reachable from the report.
