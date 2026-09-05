/**
 * The bundle the review tool renders (language spec §15): every module's
 * interface document and canonical source, every path report, the
 * diagnostics, and an interface diff against a previous document when one
 * is given. The page itself is rendered by `@onus/review`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  /** Changes and blocked reports the regeneration loop wrote (docs/onus-loop-v0.md §6). */
  readonly changes: readonly LoopChangeJson[];
}

/**
 * Collects the review bundle after the pipeline ran to `paths`.
 * Preconditions: `ctx.files[0]` is the entry file. When diagnostics were
 * reported, only they are included: the reports of an invalid program
 * would describe a program that does not exist.
 * Effects: none.
 */
/** A change or blocked report the regeneration loop wrote under `.onus/changes/<task>/` (docs/onus-loop-v0.md §5, §6), as the page shows it. */
export interface LoopChangeJson {
  readonly task: { readonly id: string; readonly kind: string; readonly scope: readonly string[]; readonly target: { readonly def: string } | null };
  readonly status: 'opened' | 'blocked';
  readonly cause: string | null;
  readonly generated: { readonly at: string; readonly model: string };
  readonly interface_diff: readonly InterfaceDiff[];
  readonly ledger_delta: readonly { readonly def: string; readonly kind: string; readonly text: string; readonly before: string | null; readonly after: string | null }[];
  readonly body_diff: readonly { readonly file: string; readonly module: string; readonly before: string; readonly after: string }[];
  readonly trace: readonly { readonly iteration: number; readonly classification: string; readonly diagnostics_before: number; readonly diagnostics_after: number; readonly mechanical_repairs: number; readonly tokens: number; readonly ms: number; readonly escalation: string | null }[];
  readonly metrics: { readonly iterations: number; readonly mechanical_repairs: number; readonly escalation_steps: number; readonly proposals: number; readonly tokens: number };
  readonly proposals: readonly { readonly kind: string; readonly def: string; readonly current: string | null; readonly proposed: string | null; readonly rationale: string; readonly counterexample: Readonly<Record<string, unknown>> | null }[];
  readonly audit: readonly { readonly finding: string; readonly detail: string }[];
}

function rec(x: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[k] = v;
  return out;
}
const str = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : fallback);
const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
const arr = (x: unknown): Readonly<Record<string, unknown>>[] => (Array.isArray(x) ? x.map(rec).filter((r): r is Readonly<Record<string, unknown>> => r !== null) : []);

/** Narrows a parsed `change.json`; null when it lacks the essentials. Effects: none. */
export function loopChangeOf(json: unknown): LoopChangeJson | null {
  const r = rec(json);
  const task = r === null ? null : rec(r['task']);
  if (r === null || task === null || typeof task['id'] !== 'string' || (r['status'] !== 'opened' && r['status'] !== 'blocked')) return null;
  const target = rec(task['target']);
  const generated = rec(r['generated']) ?? {};
  const metrics = rec(r['metrics']) ?? {};
  const scopeRaw = task['scope'];
  return {
    task: { id: task['id'], kind: str(task['kind']), scope: Array.isArray(scopeRaw) ? scopeRaw.filter((s): s is string => typeof s === 'string') : [], target: target === null ? null : { def: str(target['def']) } },
    status: r['status'],
    cause: strOrNull(r['cause']),
    generated: { at: str(generated['at']), model: str(generated['model']) },
    interface_diff: Array.isArray(r['interface_diff']) ? r['interface_diff'].filter((d): d is InterfaceDiff => rec(d) !== null) : [],
    ledger_delta: arr(r['ledger_delta']).map((x) => ({ def: str(x['def']), kind: str(x['kind']), text: str(x['text']), before: strOrNull(x['before']), after: strOrNull(x['after']) })),
    body_diff: arr(r['body_diff']).map((x) => ({ file: str(x['file']), module: str(x['module']), before: str(x['before']), after: str(x['after']) })),
    trace: arr(r['trace']).map((x) => ({ iteration: num(x['iteration']), classification: str(x['classification']), diagnostics_before: num(x['diagnostics_before']), diagnostics_after: num(x['diagnostics_after']), mechanical_repairs: num(x['mechanical_repairs']), tokens: num(x['tokens']), ms: num(x['ms']), escalation: strOrNull(x['escalation']) })),
    metrics: { iterations: num(metrics['iterations']), mechanical_repairs: num(metrics['mechanical_repairs']), escalation_steps: num(metrics['escalation_steps']), proposals: num(metrics['proposals']), tokens: num(metrics['tokens']) },
    proposals: arr(r['proposals']).map((x) => ({ kind: str(x['kind']), def: str(x['def']), current: strOrNull(x['current']), proposed: strOrNull(x['proposed']), rationale: str(x['rationale']), counterexample: rec(rec(x['evidence'])?.['counterexample'] ?? null) })),
    audit: arr(r['audit']).map((x) => ({ finding: str(x['finding']), detail: str(x['detail']) })),
  };
}

/** Every change under `<root>/.onus/changes/`, newest first. Effects: reads the file system. */
export function readChanges(root: string): LoopChangeJson[] {
  const dir = join(root, '.onus', 'changes');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoopChangeJson[] = [];
  for (const name of names) {
    try {
      const c = loopChangeOf(JSON.parse(readFileSync(join(dir, name, 'change.json'), 'utf8')));
      if (c !== null) out.push(c);
    } catch {
      // not a change
    }
  }
  return out.sort((a, b) => (a.generated.at < b.generated.at ? 1 : -1));
}

export function reviewData(ctx: Context, against: InterfaceDocument | null, now: string = new Date().toISOString(), changes: readonly LoopChangeJson[] = []): ReviewData {
  const t = ctx.resolve;
  const entryFile = ctx.files[0];
  const entryModule = t.modules.find((m) => entryFile !== undefined && m.file === entryFile.id);
  const diagnostics = ctx.sink.all().map((d) => toJson(ctx, d));
  const generated = { tool: 'onus review', at: now };
  const entry = entryModule?.name ?? entryFile?.path ?? '';
  if (diagnostics.length > 0) return { generated, entry, modules: [], sources: {}, paths: [], diagnostics, diff: null, changes };
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
  return { generated, entry, modules, sources, paths, diagnostics, diff, changes };
}
