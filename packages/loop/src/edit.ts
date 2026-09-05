/**
 * Editing bodies (docs/onus-loop-v0.md §1): the one kind of edit the loop
 * makes. Model output is parsed as Onus, the target's body is spliced in
 * under the target's own signature, and the file is put in canonical form
 * so that `E0001` never reaches the model (§4).
 */
import { Context, canonicalPass, legalTokensAt, parse, parsePass, printItem, b3, toJson, tokenName, type Diagnostic, type DiagnosticJson, type Repair, type SourceFile, type Span, type ast as A } from '@onus/compiler';

export interface Parsed {
  readonly file: SourceFile;
  readonly module: A.Module | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly json: readonly DiagnosticJson[];
}

/** Parses `text` as a module. Effects: none beyond a throwaway context. */
export function parseModule(path: string, text: string): Parsed {
  const ctx = new Context({ log: () => undefined });
  const file = ctx.addFile(path, text);
  const r = parse(file, ctx.sink);
  return { file, module: r.module, diagnostics: ctx.sink.all(), json: ctx.sink.all().map((d) => toJson(ctx, d)) };
}

/** The tokens the grammar admits at `offset` of `file`, by name (§14). Effects: none. */
export function legalTokenNames(file: SourceFile, offset: number): string[] {
  return [...legalTokensAt(file, offset)].map(tokenName).sort();
}

/** Canonical form of `text` (§2.2); `E0001` is applied, not reported. Effects: none beyond a throwaway context. */
export function canonical(path: string, text: string): { readonly text: string; readonly diagnostics: readonly Diagnostic[] } {
  const ctx = new Context({ log: () => undefined });
  const file = ctx.addFile(path, text);
  parsePass(ctx);
  canonicalPass(ctx);
  return { text: ctx.canonical.get(file.id) ?? text, diagnostics: ctx.sink.all().filter((d) => d.code !== 'E0001') };
}

/** The Onus in a model answer: the first fenced block, or the whole text. Effects: none. */
export function extractCode(answer: string): string {
  const m = /```(?:onus)?\s*\n([\s\S]*?)```/.exec(answer);
  return (m?.[1] ?? answer).trim();
}

/** Model output parsed as the items of a module fragment. Effects: none. */
export function parseFragment(text: string): Parsed {
  return parseModule('model-output.onus', `module model_output\n\n${text}\n`);
}

export function fnsOf(m: A.Module): A.FnDecl[] {
  return m.items.filter((i): i is A.FnDecl => i.kind === 'FnDecl');
}

/** `fn` with its body elided: the interface rendering of it (§11.1). Effects: none. */
export function elide(fn: A.FnDecl): A.FnDecl {
  if (fn.body === null) return fn;
  return { ...fn, body: { ...fn.body, stmts: [], elided: true } };
}

/** `fn` with `body` in place of its own. Effects: none. */
export function withBody(fn: A.FnDecl, body: A.Block): A.FnDecl {
  return { ...fn, body };
}

/** The signature line with contracts, effects and claims: what the model must not change. Effects: none. */
export function signatureText(fn: A.FnDecl): string {
  return printItem(elide(fn)).trim();
}

/** A hash of a body's canonical text, to notice the same body proposed twice (§4). Effects: none. */
export function bodyHash(fn: A.FnDecl): string {
  return b3(printItem(fn));
}

/** `text` with the item at `target`'s span replaced by `replacement`, printed canonically. Effects: none. */
export function spliceItem(text: string, target: A.Item, replacement: A.Item): string {
  return `${text.slice(0, target.span.start)}${printItem(replacement).trimEnd()}${text.slice(target.span.end)}`;
}

/**
 * Applies the repairs whose span `allowed` admits, latest offset first so
 * earlier offsets stay valid. Returns the text and how many were applied.
 * Effects: none.
 */
export function applyRepairs(text: string, repairs: readonly Repair[], allowed: (span: Span) => boolean): { readonly text: string; readonly applied: number } {
  const edits: { start: number; end: number; with: string }[] = [];
  for (const r of repairs) {
    if (r.kind === 'replace') {
      if (allowed(r.span)) edits.push({ start: r.span.start, end: r.span.end, with: r.with });
    } else if (allowed({ file: r.file, start: r.after, end: r.after })) edits.push({ start: r.after, end: r.after, with: r.text });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  let last = Number.POSITIVE_INFINITY;
  let applied = 0;
  for (const e of edits) {
    if (e.end > last) continue; // overlapping repairs: keep the first applied
    out = `${out.slice(0, e.start)}${e.with}${out.slice(e.end)}`;
    last = e.start;
    applied += 1;
  }
  return { text: out, applied };
}
