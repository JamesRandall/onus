/**
 * The project as the loop sees it (docs/onus-loop-v0.md §3, §4): the
 * modules in scope as in-memory texts over the working tree, checked
 * through the compiler library. The loop never reads an import's source
 * for the model; it reads the compiler's interface documents.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, defaultStdlibRoot, emitAll, interfaceOf, runJsExamples, runPipeline, toJson, type Diagnostic, type DiagnosticJson, type InterfaceDocument } from '@onus/compiler';

export interface ProjectFiles {
  readonly root: string;
  readonly stdlib: string;
  readonly scope: readonly string[];
  /** Module name → path of its file. */
  readonly paths: ReadonlyMap<string, string>;
  /** Path → text as found in the working tree (the baseline). */
  readonly texts: ReadonlyMap<string, string>;
}

export interface LedgerRow {
  readonly def: string;
  readonly kind: string;
  readonly text: string;
  readonly status: string;
}

export interface CheckResult {
  readonly ctx: Context;
  readonly diagnostics: readonly Diagnostic[];
  readonly json: readonly DiagnosticJson[];
  /** An `E0999` was reported: a compiler bug, filed against the compiler, not the task (§9). */
  readonly internalError: boolean;
  readonly interfaces: ReadonlyMap<string, InterfaceDocument>;
  readonly ledger: readonly LedgerRow[];
  /** Example, property and law outcomes by qualified name; null when the program did not check. */
  readonly tests: ReadonlyMap<string, boolean> | null;
}

export interface CheckOptions {
  readonly runTests: boolean;
  readonly outDir: string;
  readonly budgetMs: number;
  readonly cacheDir: string | null;
}

/** `a.b.c` → `<root>/a/b/c.onus` (impl spec, loader). Effects: none. */
export function modulePath(root: string, name: string): string {
  return `${join(root, ...name.split('.'))}.onus`;
}

/** The standard library shipped with the compiler package this loop resolves. Effects: resolves the package. */
export function stdlibRoot(): string {
  const entry = fileURLToPath(import.meta.resolve('@onus/compiler'));
  return defaultStdlibRoot(dirname(dirname(entry)));
}

/** Reads the scope modules from the working tree. Effects: reads files. */
export function loadProject(root: string, scope: readonly string[]): ProjectFiles | { readonly error: string } {
  const paths = new Map<string, string>();
  const texts = new Map<string, string>();
  for (const name of scope) {
    const path = modulePath(root, name);
    try {
      texts.set(path, readFileSync(path, 'utf8'));
    } catch (e) {
      return { error: `cannot read module ${name} at ${path}: ${e instanceof Error ? e.message : String(e)}` };
    }
    paths.set(name, path);
  }
  return { root, stdlib: stdlibRoot(), scope, paths, texts };
}

/**
 * Checks the scope modules with `texts` overlaid on the working tree, and
 * runs the examples, properties and laws when the program checks and
 * `runTests` is set. Effects: runs the compiler; writes and runs a build
 * under `outDir` when tests run.
 */
export function checkProject(files: ProjectFiles, texts: ReadonlyMap<string, string>, opts: CheckOptions): CheckResult {
  const ctx = new Context({
    root: files.root,
    stdlib: files.stdlib,
    readFile: (path) => {
      const overlaid = texts.get(path);
      if (overlaid !== undefined) return overlaid;
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    verify: { budgetMs: opts.budgetMs, cacheDir: opts.cacheDir, z3Path: null },
    log: () => undefined,
  });
  for (const name of files.scope) {
    const path = files.paths.get(name);
    if (path === undefined) continue;
    ctx.addFile(path, texts.get(path) ?? files.texts.get(path) ?? '');
  }
  runPipeline(ctx, 'paths');
  const diagnostics = ctx.sink.all();
  const json = diagnostics.map((d) => toJson(ctx, d));
  const internalError = diagnostics.some((d) => d.code === 'E0999');
  const interfaces = new Map<string, InterfaceDocument>();
  const ledger: LedgerRow[] = [];
  if (!ctx.sink.hasErrors()) {
    for (const m of ctx.resolve.modules) {
      if (m.isStd) continue;
      const doc = interfaceOf(ctx, m.id);
      interfaces.set(m.name, doc);
      for (const l of doc.ledger) ledger.push({ def: `${m.name}.${l.def}`, kind: l.kind, text: l.text, status: l.status });
    }
  }
  let tests: Map<string, boolean> | null = null;
  if (!ctx.sink.hasErrors() && opts.runTests) {
    const built = emitAll(ctx, { outDir: opts.outDir, ts: false });
    tests = built.emitted.some((m) => m.tests !== null) ? runJsExamples(opts.outDir, true) : new Map();
  }
  return { ctx, diagnostics, json, internalError, interfaces, ledger, tests };
}
