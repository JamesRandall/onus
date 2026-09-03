/**
 * Pass runners (impl spec §4). `runPipeline(ctx, to)` runs passes in order
 * up to and including `to`; a later pass never runs when an earlier one
 * reported diagnostics in a file it depends on.
 */
import type { Context } from './context.js';
import { diagnostic } from './report/diagnostic.js';
import { loadPass } from './resolve/loader.js';
import { resolvePass } from './resolve/resolve.js';
import { fileId, span, type SourceFile } from './source.js';
import { parse } from './syntax/parser.js';
import { print } from './syntax/printer.js';
import { typesPass } from './types/check.js';
import { effectsPass } from './effects/check.js';

export const PASSES = ['parse', 'canonical', 'resolve', 'types', 'effects'] as const;
export type PassName = (typeof PASSES)[number];

/**
 * Pass 1: lex and parse every file in `ctx`.
 * Postconditions: `ctx.parsed` has an entry per file.
 * Effects: writes `ctx.parsed`; reports syntax diagnostics.
 */
export function parsePass(ctx: Context): void {
  for (const f of ctx.files) {
    if (ctx.parsed.has(f.id)) continue;
    const r = parse(f, ctx.sink, ctx.nextNodeId);
    ctx.nextNodeId = r.nextId;
    ctx.parsed.set(f.id, r);
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
    if (parsed === undefined || parsed.module === null || syntaxErrorFiles.has(f.id) || ctx.canonical.has(f.id)) continue;
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

/**
 * Runs `pass` over `ctx`. An exception escaping a pass is a compiler bug: it
 * becomes an E0999 diagnostic carrying the stack, never a crash.
 * Effects: those of `pass`; reports E0999 on an exception.
 */
export function guarded(ctx: Context, name: string, pass: (ctx: Context) => void): void {
  try {
    pass(ctx);
  } catch (e) {
    const first = ctx.files[0];
    const stack = e instanceof Error ? (e.stack ?? e.message) : String(e);
    ctx.sink.report(
      diagnostic({
        code: 'E0999',
        span: span(first?.id ?? fileId(0), 0, 0),
        context: [`the ${name} pass threw; this is a compiler bug, please report it`, ...stack.split('\n')],
      }),
    );
  }
}

/**
 * Runs passes 1..`to`. Loading may add files; the canonical check then covers
 * them too. Resolution and typing are skipped when any syntax error exists.
 * Effects: those of the passes run.
 */
export function runPipeline(ctx: Context, to: PassName = 'types', passes: Partial<Record<PassName, (ctx: Context) => void>> = {}): void {
  const upTo = PASSES.indexOf(to);
  const clean = (): boolean => !ctx.sink.all().some((d) => d.code !== 'E0001');
  guarded(ctx, 'parse', passes.parse ?? parsePass);
  if (upTo >= PASSES.indexOf('canonical')) guarded(ctx, 'canonical', passes.canonical ?? canonicalPass);
  if (upTo < PASSES.indexOf('resolve') || !clean()) return;
  guarded(ctx, 'load', loadPass);
  if (upTo >= PASSES.indexOf('canonical')) guarded(ctx, 'canonical', canonicalPass);
  if (!clean()) return;
  guarded(ctx, 'resolve', passes.resolve ?? resolvePass);
  if (upTo < PASSES.indexOf('types') || !clean()) return;
  guarded(ctx, 'types', passes.types ?? typesPass);
  if (upTo < PASSES.indexOf('effects') || !clean()) return;
  guarded(ctx, 'effects', passes.effects ?? effectsPass);
}
