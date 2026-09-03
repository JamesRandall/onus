/**
 * Fixture harness (impl spec §10).
 *
 * A fixture is an `.onus` file. Diagnostic fixtures have an adjacent
 * `.expect.json` listing the expected diagnostics as `{ code, span }` with
 * 1-based `[[line, col], [line, col]]` spans. Running with
 * `UPDATE_FIXTURES=1` rewrites the expectation files from actual output.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '../src/context.js';
import { runFrontEnd } from '../src/driver.js';
import { toJson, type DiagnosticJson } from '../src/report/diagnostic.js';

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

export interface FrontEndResult {
  readonly ctx: Context;
  readonly diagnostics: readonly DiagnosticJson[];
}

/** Runs passes 1–2 over one source text. Effects: none beyond the returned context. */
export function frontEnd(path: string, text: string): FrontEndResult {
  const ctx = new Context();
  ctx.addFile(path, text);
  runFrontEnd(ctx);
  return { ctx, diagnostics: ctx.sink.all().map((d) => toJson(ctx, d)) };
}

export interface ExpectedDiagnostic {
  readonly code: string;
  readonly span: readonly [readonly [number, number], readonly [number, number]];
}

export interface Expectation {
  readonly diagnostics: readonly ExpectedDiagnostic[];
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
export function checkExpectation(fixturePath: string, actual: readonly DiagnosticJson[]): string | null {
  const expectPath = fixturePath.replace(/\.onus$/, '.expect.json');
  const got: ExpectedDiagnostic[] = actual.map((d) => ({ code: d.code, span: d.location.span }));
  if (process.env['UPDATE_FIXTURES'] === '1') {
    writeFileSync(expectPath, `${JSON.stringify({ diagnostics: got }, null, 2)}\n`);
    return null;
  }
  if (!existsSync(expectPath)) return `missing ${expectPath}; actual: ${JSON.stringify(got)}`;
  const parsed: unknown = JSON.parse(readFileSync(expectPath, 'utf8'));
  if (!isExpectation(parsed)) return `${expectPath} is not an expectation file`;
  const want = parsed.diagnostics;
  const same = want.length === got.length && want.every((w, i) => JSON.stringify(w) === JSON.stringify(got[i]));
  if (same) return null;
  return `expected ${JSON.stringify(want)}\n   actual ${JSON.stringify(got)}\n   (${actual.map((d) => d.context.join('; ')).join(' | ')})`;
}
