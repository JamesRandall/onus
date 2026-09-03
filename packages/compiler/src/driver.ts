/**
 * Pass runners for the front end (impl spec §4, passes 1 and 2).
 */
import type { Context } from './context.js';
import { diagnostic } from './report/diagnostic.js';
import { span, type SourceFile } from './source.js';
import { parse } from './syntax/parser.js';
import { print } from './syntax/printer.js';

/**
 * Pass 1: lex and parse every file in `ctx`.
 * Postconditions: `ctx.parsed` has an entry per file.
 * Effects: writes `ctx.parsed`; reports syntax diagnostics.
 */
export function parsePass(ctx: Context): void {
  for (const f of ctx.files) {
    if (!ctx.parsed.has(f.id)) ctx.parsed.set(f.id, parse(f, ctx.sink));
  }
}

/**
 * Pass 2: canonical form. For every file that parsed without syntax errors,
 * compares the source with its canonical printing and reports E0001 with the
 * canonical text as the repair when they differ.
 * Preconditions: `parsePass` has run.
 * Effects: writes `ctx.canonical`; reports E0001.
 */
export function canonicalPass(ctx: Context): void {
  const syntaxErrorFiles = new Set(ctx.sink.all().map((d) => d.span.file));
  for (const f of ctx.files) {
    const parsed = ctx.parsed.get(f.id);
    if (parsed === undefined || parsed.module === null || syntaxErrorFiles.has(f.id)) continue;
    const canonical = print(parsed.module, parsed.comments);
    ctx.canonical.set(f.id, canonical);
    if (canonical !== f.text) ctx.sink.report(nonCanonical(f, canonical));
  }
}

function nonCanonical(f: SourceFile, canonical: string) {
  let i = 0;
  const n = Math.min(f.text.length, canonical.length);
  while (i < n && f.text.charCodeAt(i) === canonical.charCodeAt(i)) i += 1;
  return diagnostic({
    code: 'E0001',
    span: span(f.id, i, Math.min(i + 1, f.text.length)),
    context: ['the source differs from its canonical form at this position; `onus fmt` rewrites it'],
    repairs: [{ kind: 'replace', span: span(f.id, 0, f.text.length), with: canonical, confidence: 'high' }],
  });
}

/**
 * Runs the front end (passes 1–2) over `ctx`.
 * Effects: those of `parsePass` and `canonicalPass`.
 */
export function runFrontEnd(ctx: Context): void {
  parsePass(ctx);
  canonicalPass(ctx);
}
