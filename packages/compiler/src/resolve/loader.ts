/**
 * Module loading (impl spec §4, pass 3, first half).
 *
 * Maps module names to files, parses what the entry files transitively
 * import (plus the implicit prelude), checks that every file declares the
 * module its path says it is, reserves `std.*` for the standard library
 * root, and rejects import cycles.
 *
 *   `a.b.c` → `<root>/a/b/c.onus`, or `<stdlib>/std/…` for `std.*`
 *
 * When no root is configured it is inferred from the first entry file and
 * its module name. This is the only pass that touches the file system, and
 * it does so through `ctx.options.readFile`.
 *
 * Implicit prelude imports make only public types and variants visible, so
 * they are not edges for cycle detection: the prelude modules may reference
 * each other's types freely.
 */
import { dirname, join, resolve, sep } from 'node:path';
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import type { SourceFile, Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { parse } from '../syntax/parser.js';
import { walk } from '../syntax/walk.js';
import { moduleId, type ImportRecord, type ModuleId, type ModuleRecord } from './defs.js';

/** Modules whose public types and variants every module sees unqualified (§16). */
export const PRELUDE_MODULES = [
  'std.results',
  'std.option',
  'std.list',
  'std.grid',
  'std.map',
  'std.int',
  'std.float',
  'std.text',
  'std.bool',
  'std.bytes',
  'std.duration',
  'std.check',
  'std.typeinfo',
] as const;

function nameOf(m: A.Module): string {
  return m.name.segments.map((s) => s.text).join('.');
}

function pathFor(root: string, name: string): string {
  return join(root, ...name.split('.')) + '.onus';
}

interface Pending {
  readonly file: SourceFile;
  readonly module: A.Module;
  readonly isStd: boolean;
}

interface Edge {
  readonly alias: string;
  readonly node: A.NodeId;
  readonly to: ModuleId;
  readonly implicit: boolean;
}

/**
 * Loads every module reachable from the files already in `ctx` and records
 * the module graph in `ctx.resolve.modules`.
 * Preconditions: `parsePass` has run over the entry files.
 * Effects: reads files via `ctx.options.readFile`; appends to `ctx.files`,
 * `ctx.parsed`, `ctx.resolve.modules`; reports E0101, E0103, E0104, E0112.
 */
export function loadPass(ctx: Context): void {
  const tables = ctx.resolve;
  const stdlib = ctx.options.stdlib;
  let root = ctx.options.root;

  const isUnderStdlib = (path: string): boolean => stdlib !== null && resolve(path).startsWith(resolve(stdlib) + sep);

  // Entry files: infer the project root from the first non-stdlib one.
  const entries: Pending[] = [];
  for (const f of ctx.files) {
    const parsed = ctx.parsed.get(f.id);
    if (parsed === undefined || parsed.module === null) continue;
    const name = nameOf(parsed.module);
    const isStd = isUnderStdlib(f.path);
    if (!isStd) {
      const suffix = sep + name.split('.').join(sep) + '.onus';
      const abs = resolve(f.path);
      const mismatch = root === null ? !abs.endsWith(suffix) : abs !== resolve(root) + suffix;
      if (mismatch) {
        ctx.sink.report(
          diagnostic({
            code: 'E0104',
            span: parsed.module.name.span,
            context: [`module \`${name}\` must live at \`${name.split('.').join('/')}.onus\` under the project root; this file is \`${f.path}\``],
          }),
        );
        continue;
      }
      if (root === null) root = abs.slice(0, abs.length - suffix.length);
    }
    entries.push({ file: f, module: parsed.module, isStd });
  }

  const records: ModuleRecord[] = [];
  const pendingImports: { from: ModuleId; node: A.NodeId; name: string; span: Span; implicit: boolean }[] = [];

  const register = (p: Pending): ModuleId | null => {
    const name = nameOf(p.module);
    const existing = tables.byName.get(name);
    if (existing !== undefined) return existing;
    if (name.split('.')[0] === 'std' && !p.isStd) {
      ctx.sink.report(diagnostic({ code: 'E0112', span: p.module.name.span, context: ['`std.…` names belong to the standard library'] }));
      return null;
    }
    const id = moduleId(records.length);
    tables.byName.set(name, id);
    walk(p.module, (n) => {
      tables.nodes.set(n.id, n);
    });
    const parsed = ctx.parsed.get(p.file.id);
    records.push({ id, name, file: p.file.id, module: p.module, comments: parsed?.comments ?? new Map(), isStd: p.isStd, imports: [], implicit: [] });
    for (const imp of p.module.imports) {
      pendingImports.push({ from: id, node: imp.id, name: imp.name.segments.map((s) => s.text).join('.'), span: imp.span, implicit: false });
    }
    if (stdlib !== null) {
      for (const pre of PRELUDE_MODULES) {
        if (pre !== name) pendingImports.push({ from: id, node: p.module.id, name: pre, span: p.module.name.span, implicit: true });
      }
    }
    return id;
  };

  const failed = new Set<string>();
  const load = (name: string, at: Span): ModuleId | null => {
    const known = tables.byName.get(name);
    if (known !== undefined) return known;
    if (failed.has(name)) return null;
    failed.add(name);
    const isStd = name.split('.')[0] === 'std';
    const base = isStd ? stdlib : root;
    if (base === null) {
      ctx.sink.report(diagnostic({ code: 'E0103', span: at, context: [isStd ? 'no standard library is configured' : 'no project root is known'] }));
      return null;
    }
    const path = pathFor(base, name);
    const text = ctx.options.readFile(path);
    if (text === null) {
      ctx.sink.report(diagnostic({ code: 'E0103', span: at, context: [`expected \`${name}\` at \`${path}\``] }));
      return null;
    }
    const file = ctx.addFile(path, text);
    const parsed = parse(file, ctx.sink, ctx.nextNodeId);
    ctx.nextNodeId = parsed.nextId;
    ctx.parsed.set(file.id, parsed);
    if (parsed.module === null) return null;
    const declared = nameOf(parsed.module);
    if (declared !== name) {
      ctx.sink.report(
        diagnostic({ code: 'E0104', span: parsed.module.name.span, context: [`file \`${path}\` declares \`module ${declared}\` but is imported as \`${name}\``] }),
      );
      return null;
    }
    const id = register({ file, module: parsed.module, isStd });
    if (id !== null) failed.delete(name);
    return id;
  };

  for (const p of entries) register(p);

  // Breadth-first over imports; `pendingImports` grows as modules register.
  const edges = new Map<ModuleId, Edge[]>();
  for (let i = 0; i < pendingImports.length; i++) {
    const imp = pendingImports[i];
    if (imp === undefined) break;
    const to = load(imp.name, imp.span);
    if (to === null) continue;
    const list = edges.get(imp.from) ?? [];
    list.push({ alias: imp.name.split('.').pop() ?? imp.name, node: imp.node, to, implicit: imp.implicit });
    edges.set(imp.from, list);
  }

  for (const r of records) {
    const list = edges.get(r.id) ?? [];
    const imports: ImportRecord[] = list.filter((e) => !e.implicit).map((e) => ({ alias: e.alias, module: e.to, node: e.node }));
    const implicit = list.filter((e) => e.implicit).map((e) => e.to);
    tables.modules.push({ ...r, imports, implicit });
  }

  // Cycle detection over explicit imports.
  const state = new Map<ModuleId, 'visiting' | 'done'>();
  const stack: ModuleId[] = [];
  const visit = (m: ModuleId): void => {
    state.set(m, 'visiting');
    stack.push(m);
    for (const e of edges.get(m) ?? []) {
      if (e.implicit) continue;
      const s = state.get(e.to);
      if (s === 'done') continue;
      if (s === 'visiting') {
        const cycle = stack.slice(stack.indexOf(e.to)).map((x) => tables.moduleOf(x).name);
        const rec = tables.moduleOf(m);
        const impNode = rec.module.imports.find((i) => i.id === e.node);
        ctx.sink.report(
          diagnostic({
            code: 'E0101',
            span: impNode?.span ?? rec.module.name.span,
            context: [[...cycle, tables.moduleOf(e.to).name].join(' -> ')],
          }),
        );
        continue;
      }
      visit(e.to);
    }
    stack.pop();
    state.set(m, 'done');
  };
  for (const r of tables.modules) if (state.get(r.id) === undefined) visit(r.id);
}

/** The default standard library root, relative to the compiler package directory. Effects: none. */
export function defaultStdlibRoot(compilerPackageDir: string): string {
  return join(dirname(compilerPackageDir), 'stdlib');
}
