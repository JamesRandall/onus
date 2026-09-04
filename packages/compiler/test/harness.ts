/**
 * Fixture harness (impl spec §10).
 *
 * A fixture is an `.onus` file. Diagnostic fixtures have an adjacent
 * `.expect.json` listing the expected diagnostics as `{ code, span }` with
 * 1-based `[[line, col], [line, col]]` spans. Running with
 * `UPDATE_FIXTURES=1` rewrites the expectation files from actual output.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, type ContextOptions } from '../src/context.js';
import { runFrontEnd, runPipeline, type PassName } from '../src/driver.js';
import { toJson, type DiagnosticJson } from '../src/report/diagnostic.js';
import { lineColOf } from '../src/source.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository's standard library root (`packages/stdlib`). */
export const STDLIB_ROOT = join(here, '..', '..', 'stdlib');

export interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

/** Every `.onus` file directly inside `dir`, sorted by name. Effects: reads the directory. */
export function fixturesIn(dir: string): Fixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.onus'))
    .sort()
    .map((f) => ({ name: f, path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }));
}

export interface PipelineResult {
  readonly ctx: Context;
  readonly diagnostics: readonly DiagnosticJson[];
}

/** Runs passes 1–2 over one source text. Effects: none beyond the returned context. */
export function frontEnd(path: string, text: string): PipelineResult {
  const ctx = new Context();
  ctx.addFile(path, text);
  runFrontEnd(ctx);
  return { ctx, diagnostics: ctx.sink.all().map((d) => toJson(ctx, d)) };
}

/** Runs the pipeline up to `to` over one entry file with the given project root. Effects: reads imported files. */
export function pipeline(path: string, text: string, root: string | null, to: PassName = 'paths', budgetMs = 500, extra: Partial<ContextOptions> = {}): PipelineResult {
  const ctx = new Context({ root, stdlib: STDLIB_ROOT, verify: { budgetMs, cacheDir: join(here, '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined, ...extra });
  ctx.addFile(path, text);
  runPipeline(ctx, to);
  return { ctx, diagnostics: ctx.sink.all().map((d) => toJson(ctx, d)) };
}

export interface ExpectedDiagnostic {
  readonly code: string;
  readonly span: readonly [readonly [number, number], readonly [number, number]];
  /** Present when the diagnostic is in another file than the fixture (relative to the fixture's directory). */
  readonly file?: string;
}

/** One ledger row: an obligation's kind, site, predicate and status. */
export interface LedgerEntry {
  readonly kind: string;
  readonly at: readonly [number, number];
  readonly text: string;
  readonly status: string;
}

export interface Expectation {
  readonly diagnostics: readonly ExpectedDiagnostic[];
  readonly obligations?: readonly LedgerEntry[];
}

/** The obligations located in `fixturePath`, in creation order. Effects: none. */
export function ledgerOf(ctx: Context, fixturePath: string): LedgerEntry[] {
  const file = ctx.files.find((f) => f.path === fixturePath);
  if (file === undefined) return [];
  return ctx.contracts.obligations
    .filter((o) => ctx.resolve.node(o.at).span.file === file.id)
    .map((o) => {
      const p = lineColOf(file, ctx.resolve.node(o.at).span.start);
      return { kind: o.kind, at: [p.line, p.col], text: o.text, status: o.status };
    });
}

function isExpectation(v: unknown): v is Expectation {
  return typeof v === 'object' && v !== null && Array.isArray((v as { diagnostics?: unknown }).diagnostics);
}

/**
 * Compares actual diagnostics with the fixture's `.expect.json`.
 * Returns null when they match, else a message. With `UPDATE_FIXTURES=1`
 * writes the actual diagnostics and returns null.
 * Effects: may write the expectation file.
 */
export function checkExpectation(fixturePath: string, actual: readonly DiagnosticJson[], ledger: readonly LedgerEntry[] | null = null): string | null {
  const expectPath = fixturePath.replace(/\.onus$/, '.expect.json');
  const dir = dirname(fixturePath);
  const got: ExpectedDiagnostic[] = actual.map((d) => {
    const rel = relative(dir, d.location.file);
    return rel === basename(fixturePath) ? { code: d.code, span: d.location.span } : { code: d.code, span: d.location.span, file: rel };
  });
  if (process.env['UPDATE_FIXTURES'] === '1') {
    const body: Expectation = ledger === null ? { diagnostics: got } : { diagnostics: got, obligations: ledger };
    writeFileSync(expectPath, `${JSON.stringify(body, null, 2)}\n`);
    return null;
  }
  if (!existsSync(expectPath)) return `missing ${expectPath}; actual: ${JSON.stringify(got)}`;
  const parsed: unknown = JSON.parse(readFileSync(expectPath, 'utf8'));
  if (!isExpectation(parsed)) return `${expectPath} is not an expectation file`;
  const want = parsed.diagnostics;
  const same = want.length === got.length && want.every((w, i) => JSON.stringify(w) === JSON.stringify(got[i]));
  if (!same) return `expected ${JSON.stringify(want)}\n   actual ${JSON.stringify(got)}\n   (${actual.map((d) => d.context.join('; ')).join(' | ')})`;
  if (ledger !== null) {
    const wantLedger = parsed.obligations ?? [];
    const sameLedger = wantLedger.length === ledger.length && wantLedger.every((w, i) => JSON.stringify(w) === JSON.stringify(ledger[i]));
    if (!sameLedger) return `ledger differs:\n   expected ${JSON.stringify(wantLedger)}\n   actual ${JSON.stringify(ledger)}`;
  }
  return null;
}
