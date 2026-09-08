# Onus — loop benchmark log

A running log of the regeneration loop (`docs/onus-loop-v0.md`, `onus loop`) against models. Revisit it whenever the loop, the context it assembles, or the models change; every row is one run, and one run is thin evidence, so add rows rather than replacing them.

## How to add rows

```
pnpm -r build
node scripts/bench.mjs mandelbrot openrouter:deepseek/deepseek-v4-flash claude-code --append docs/BENCHMARK.md
```

Keys are read from `.env.local` at the repository root (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`). Model specs are `claude-code[:<model>]`, `anthropic[:<model>]`, `openrouter[:<model id>]`. Each run works in a fresh copy of the example under `.onus-tmp/bench/`, where its `change.json` and every prompt and answer remain for reading. The script prints the rows it appends, so a run can also be logged by hand.

## Tasks

- **mandelbrot** — `implement` `mandelbrot.escape_count` from its interface with the body elided: signature, `requires limit > 0`, `ensures result <= limit`, the module's examples and property, the interfaces of its imports, and (policy `module`) the bodies of `render` and `main`. Green means the body parsed, every obligation was proved or checked, and the examples and property passed. Budget six iterations unless the note says otherwise.

## What the columns mean

- **iterations** — model calls made; green on 1 means the first answer was accepted.
- **wall time** — the whole task, including the compiler and z3 (about a second per iteration of that on the machine used).
- **tokens** — as the provider reported them, or estimated at four characters per token where it did not.
- **note** — the diagnostic codes of the first answer when it was not accepted: `E0003`/`E0005` are syntax errors in the answer itself, `E0702` a failed example, `E0302` a postcondition with a counterexample.

## Observations

- 2026-09-05. DeepSeek V4 Flash and Kimi K2.7 Code wrote the escape-time body with invariant and measure on the first try, as Claude Code had. Sonnet 5 and GLM 5.3 Flash wrote a bare `while` first and fixed it once the loop's note named `loop` among the legal tokens; that note was added this day because Qwen3 Coder Next wrote `while` six times running and never converged even with it. GLM's first attempt hung with no reply for ten minutes, which is why API requests now time out after three minutes. Price bought nothing on this task: the cheapest model gave the best result fastest, so DeepSeek V4 Flash became the OpenRouter default.

## The regeneration audit

`onus zone promote <module> <zone> --model <spec>` (docs/CHANGES.md item 204) regenerates every body of the module from the interfaces alone and records what came back as the promotion's audit. The first readings, 2026-09-07, DeepSeek V4 Flash through OpenRouter, budget twelve iterations, in fresh copies under `.onus-tmp/audit/`; each row is one run of the whole module, and a low reading is the result the instrument exists to give, not a failure of the tooling.

| date | module | functions | result | iterations | wall time | tokens | reading |
|---|---|---|---|---|---|---|---|
| 2026-09-07 | `mandelbrot` | 3 | blocked, budget | 12 | 740 s | 109770 | `escape_count` reconstructed on the first answer, as in the table below; `render` and `main` never: eleven of twelve answers for them were not Onus (`:=`, untyped `for`, `if` as an expression, unqualified `set`, `float.of`), so the finding is the model's fluency in effectful Onus, not the interfaces, and the audit's two findings read "not reconstructed" once item 204 names them so |
| 2026-09-07 | `reporting` | 2 | blocked, stall | 4 | 397 s | 49382 | two empty answers and one in another language's SQL (`strftime`, `=>` arms): the meaning of `monthly_totals` is its query, which no contract states and no example pins against a fake database — the output-shaped case predicted above |
| 2026-09-07 | `checkout` | 6 | did not run | 0 | 182 s | 0 | the provider did not answer within the loop's 180 s request timeout; recorded as "regeneration did not run" and the promotion went ahead on the policies |
| 2026-09-07 | `toml` (`self/`) | 15 | did not run | 0 | 447 s | 0 | the same timeout, after the whole compiler was checked as the project (265 s of that); no reading |
| 2026-09-07 | `mandelbrot` | 3 | passed — invalid | 1 | 62 s | 3862 | Claude Code returned all three bodies green on the first answer, byte-identical to the originals down to the variable names: the loop elided the bodies only in memory and ran the subprocess in a directory where the original file was still on disk, so it read them. Not a reading of the interfaces; the loop is fixed in item 205 (the working texts are written to disk before every model call) and the run is to be repeated |
| 2026-09-07 | `mandelbrot` | 3 | passed — invalid | 1 | 58 s | 3911 | after item 205, with the elided tree on disk: `main` came back identical to the original but for a dropped comment, viewport, image size and PGM header included, which no interface states; the subprocess had read the repository's own copy of the example (it runs in the repository, with its read tools). Item 206 restricts the subprocess's tools; the run is to be repeated once more |
| 2026-09-07 | `mandelbrot` | 3 | passed, green but different | 2 | 320 s | 8522 | the honest reading, after item 206 (empty sandbox, read tools disallowed): first answer seven syntax errors, second green with no findings. `escape_count` and `render` are the same computation, refactored; `main` is another program: a 60×24 ASCII rendering of a different viewport to `mandelbrot.txt`, where the original writes an 800×600 PGM. Nothing in `main`'s interface says what it writes — no contract can, its one comment did not, and no example or `programs` case is part of the interface — so the audit is right that the interfaces reconstruct a green module and wrong, in v0, to report nothing: this is loop spec §8's third finding, "green but differs", which the interface documents cannot see |

What the readings say so far: the instrument runs end to end and records honestly, including when it cannot run; a subprocess model with a file system is not a reading at all until the tree it sees is the elided one (item 205) and it can read nothing else (item 206) — the same caveat applies to the Claude Code row in the table below, made before both; with those in place, a capable model reconstructs a contract-shaped module green, and the reading that matters is the one v0 cannot make: `main` came back as a different program with a green ledger, because a body's purpose that no contract, example or comment states is exactly the tacit knowledge the audit exists to find, and the finding it should file is "green but different"; a contract-shaped module reconstructs whole; a query does not, and will not until an example pins it against a fake database. The next runs are reporting, checkout and `toml` under the stronger model, and a look at whether the regenerated bodies differ from the originals in ways the interface cannot see (loop spec §8's third finding, not reported in v0).

## Runs

The table is the last thing in this file so that the script can append to it.

| date | task | model | result | iterations | wall time | tokens | note |
|---|---|---|---|---|---|---|---|
| 2026-09-05 | mandelbrot | `claude-code` | green | 1 | 40.9 s | 1263 | first answer accepted |
| 2026-09-05 | mandelbrot | `openrouter:deepseek/deepseek-v4-flash` | green | 1 | 5.3 s | 1578 | first answer accepted |
| 2026-09-05 | mandelbrot | `openrouter:moonshotai/kimi-k2.7-code` | green | 1 | 19.6 s | 3315 | first answer accepted |
| 2026-09-05 | mandelbrot | `openrouter:anthropic/claude-sonnet-5` | green | 2 | 15.2 s | 5929 | first answer: E0003, E0003 (`while` for `loop while`); 1 more |
| 2026-09-05 | mandelbrot | `openrouter:z-ai/glm-5.3-flash` | green | 2 | 98.5 s | 9620 | first answer: E0003, E0003; 1 more; an earlier attempt hung for 10 min with no reply |
| 2026-09-05 | mandelbrot | `openrouter:qwen/qwen3-coder-next` | blocked, budget | 6 | 14.6 s | 11070 | first answer: E0005, E0003; `while` every iteration; before the legal-token notes |
| 2026-09-05 | mandelbrot | `openrouter:qwen/qwen3-coder-next` | blocked, budget | 6 | 12.9 s | 11839 | first answer: E0005, E0003; with the legal-token notes; best attempt used `loop while` then `break` |
