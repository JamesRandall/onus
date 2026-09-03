/**
 * The bundle the review tool renders (language spec §15): every module's
 * interface document and canonical source, every path report, the
 * diagnostics, and an interface diff against a previous document when one
 * is given. The page itself is rendered by `@onus/review`.
 */
import type { Context } from '../context.js';
import { interfaceDiff, type InterfaceDiff } from './diff.js';
import { toJson, type DiagnosticJson } from './diagnostic.js';
import { interfaceOf, type InterfaceDocument } from './interface.js';
import { pathReport, type PathReport } from './path.js';

export interface ReviewData {
  readonly generated: { readonly tool: string; readonly at: string };
  readonly entry: string;
  readonly modules: readonly InterfaceDocument[];
  readonly sources: Readonly<Record<string, string>>;
  readonly paths: readonly PathReport[];
  readonly diagnostics: readonly DiagnosticJson[];
  readonly diff: InterfaceDiff | null;
}

/**
 * Collects the review bundle after the pipeline ran to `paths`.
 * Preconditions: `ctx.files[0]` is the entry file. When diagnostics were
 * reported, only they are included: the reports of an invalid program
 * would describe a program that does not exist.
 * Effects: none.
 */
export function reviewData(ctx: Context, against: InterfaceDocument | null, now: string = new Date().toISOString()): ReviewData {
  const t = ctx.resolve;
  const entryFile = ctx.files[0];
  const entryModule = t.modules.find((m) => entryFile !== undefined && m.file === entryFile.id);
  const diagnostics = ctx.sink.all().map((d) => toJson(ctx, d));
  const generated = { tool: 'onus review', at: now };
  const entry = entryModule?.name ?? entryFile?.path ?? '';
  if (diagnostics.length > 0) return { generated, entry, modules: [], sources: {}, paths: [], diagnostics, diff: null };
  const userModules = t.modules.filter((m) => !m.isStd);
  const modules = userModules.map((m) => interfaceOf(ctx, m.id));
  const sources: Record<string, string> = {};
  for (const m of userModules) {
    const text = ctx.canonical.get(m.file);
    if (text !== undefined) sources[m.name] = text;
  }
  const paths = [...ctx.paths.analyses.values()].map((a) => pathReport(ctx, a));
  const current = entryModule === undefined ? undefined : modules.find((d) => d.module === entryModule.name);
  const diff = against !== null && current !== undefined ? interfaceDiff(against, current) : null;
  return { generated, entry, modules, sources, paths, diagnostics, diff };
}
