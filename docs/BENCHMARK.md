# Onus — loop benchmark log

A running log of the regeneration loop (`docs/onus-loop-v0.md`, `packages/loop`) against models. Revisit it whenever the loop, the context it assembles, or the models change; every row is one run, and one run is thin evidence, so add rows rather than replacing them.

## How to add rows

```
pnpm -r build
node packages/loop/bench/run.mjs mandelbrot openrouter:deepseek/deepseek-v4-flash claude-code --append docs/BENCHMARK.md
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
