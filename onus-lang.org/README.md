# onus-lang.org

The Onus website, built with [Hugo](https://gohugo.io) (extended, v0.146 or later; no theme, no JavaScript build step).

```
cd onus-lang.org
hugo server          # http://localhost:1313/
hugo --minify        # writes public/
```

## Deploying

`netlify.toml` at the repository root builds this directory with Hugo 0.165 and publishes `public/`. Deploy previews and branch deploys are built with their own base URL. Because the site mounts `../docs` and `../examples`, the Netlify ignore rule also watches those directories, so a change to the specification or an example rebuilds the site.

## Where the content comes from

The site is a view over the repository, not a copy of it. `hugo.yaml` mounts:

| On the site | From |
|---|---|
| `/spec/` | `docs/onus-spec-v0.md` |
| `/spec/grammar/`, `/spec/implementation/`, `/spec/loop/` | `docs/grammar-v0.md`, `docs/onus-impl-spec-v0.md`, `docs/onus-loop-v0.md` |
| `/spec/changes/` | `docs/CHANGE-LOG*.md` and `docs/CHANGES.md`, rendered in order |
| `/spec/mandelbrot/` etc. | `examples/*/*.onus`, with the ledger from `examples/*/review/review.json` |
| `/compared/` | `docs/onus-lang.org/comparison.md` |
| the ledger on the home page and `/status/` | `examples/checkout/review/review.json`, `examples/mandelbrot/review/review.json` |
| `/review/checkout/`, `/review/mandelbrot/` | the review pages `onus review` wrote, unchanged |

Those files carry no front matter; titles and ordering come from the `cascade` block in `hugo.yaml`. `<!-- changed: … -->` notes in the documents are rendered as visible margin notes.

Hand-written pages live in `content/`: the home page (`layouts/home.html`), `practice.md`, `environment.md`, `status.md` and the concept pages under `concepts/`. The plan they follow is `docs/onus-lang.org/site-map.md`.

## Onus source on the site

There is no Chroma lexer for Onus. Fenced code blocks with no language or with `onus` go through `layouts/_partials/onus-code.html`, a small tokenizer that colours keywords, capitalised names, strings and `--` comments. The `{{</* onus file="checkout/checkout.onus" from=20 to=30 */>}}` shortcode embeds a range of lines from a file under `examples/`.
