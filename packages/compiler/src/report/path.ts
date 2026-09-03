/**
 * Path reports (language spec §9.1). `pathReport` is the normative JSON;
 * `pathText` is its human-readable rendering with the same content.
 */
import type { Context } from '../context.js';
import type { DefId } from '../resolve/defs.js';
import { lineColOf, type Span } from '../source.js';
import type { PathAnalysis } from '../paths/tables.js';
import { effectName } from '../paths/pass.js';

export interface PathAssumeJson {
  readonly claim: string;
  readonly at: string;
  readonly justification: string;
  readonly permitted_by: 'scope' | 'except' | null;
}

export interface PathReport {
  readonly path: string;
  readonly entry: string;
  readonly reachable: readonly string[];
  readonly effects: { readonly bound: readonly string[] | null; readonly forbid: readonly string[]; readonly actual: readonly string[] };
  readonly claims: { readonly required: readonly string[]; readonly satisfied: boolean };
  readonly assumes: readonly PathAssumeJson[];
  readonly obligations: { readonly proved: number; readonly checked: number; readonly assumed: number; readonly failed: number; readonly checked_at: readonly string[] };
  readonly unresolvable_calls: readonly { readonly at: string; readonly reason: string }[];
  readonly capabilities: readonly { readonly type: string; readonly constructed_at: string; readonly assumes: readonly string[] }[];
  readonly ok: boolean;
}

/**
 * The report of an analysed path.
 * Preconditions: the paths pass ran and recorded `analysis`.
 * Effects: none.
 */
export function pathReport(ctx: Context, analysis: PathAnalysis): PathReport {
  const t = ctx.resolve;
  const reachable = new Set(analysis.reachable);
  const obligations = ctx.contracts.obligations.filter((o) => reachable.has(o.def));
  const counts = { proved: 0, checked: 0, assumed: 0, failed: 0 };
  const checkedAt: string[] = [];
  for (const o of obligations) {
    if (o.status === 'proved') counts.proved += 1;
    else if (o.status === 'assumed') counts.assumed += 1;
    else if (o.status === 'failed') counts.failed += 1;
    else {
      counts.checked += 1;
      checkedAt.push(`${t.qualifiedName(o.def)}:${lineCol(ctx, t.node(o.at).span)}`);
    }
  }
  const names = (set: { values(): { k: string }[] }): string[] => set.values().map((e) => effectName(ctx, e as Parameters<typeof effectName>[1])).sort();
  return {
    path: t.def(analysis.def).name,
    entry: t.qualifiedName(analysis.entry),
    reachable: analysis.reachable.map((d) => t.qualifiedName(d)),
    effects: { bound: analysis.bound === null ? null : names(analysis.bound), forbid: names(analysis.forbid), actual: names(analysis.actual) },
    claims: { required: analysis.required.map((c) => t.qualifiedName(c)), satisfied: analysis.satisfied },
    assumes: analysis.assumes.map((a) => ({ claim: t.qualifiedName(a.claim), at: t.qualifiedName(a.fn), justification: a.justification, permitted_by: a.permittedBy })),
    obligations: { ...counts, checked_at: checkedAt },
    unresolvable_calls: analysis.unresolvable.map((u) => ({ at: `${t.qualifiedName(u.fn)}:${lineCol(ctx, t.node(u.at).span)}`, reason: u.reason })),
    capabilities: analysis.capabilities.map((c) => ({ type: c.typeText, constructed_at: `${t.qualifiedName(c.fn)}:${lineCol(ctx, t.node(c.at).span)}`, assumes: [] })),
    ok: analysis.ok,
  };
}

/** The text rendering of a report. Effects: none. */
export function pathText(r: PathReport): string {
  const lines: string[] = [`path ${r.path} (${r.ok ? 'ok' : 'failed'})`, `  entry ${r.entry}`, `  reachable (${r.reachable.length}): ${r.reachable.join(', ')}`];
  lines.push(`  effects: { ${r.effects.actual.join(', ')} }${r.effects.bound === null ? '' : ` within { ${r.effects.bound.join(', ')} }`}${r.effects.forbid.length > 0 ? `, forbidding { ${r.effects.forbid.join(', ')} }` : ''}`);
  if (r.claims.required.length > 0) lines.push(`  claims: { ${r.claims.required.join(', ')} } ${r.claims.satisfied ? 'satisfied' : 'NOT satisfied'}`);
  lines.push(r.assumes.length === 0 ? '  assumes: none' : '  assumes:');
  for (const a of r.assumes) lines.push(`    ${a.at}: ${a.claim} "${a.justification}"${a.permitted_by === null ? '' : ` (permitted by ${a.permitted_by})`}`);
  const o = r.obligations;
  lines.push(`  obligations: ${o.proved} proved, ${o.checked} checked, ${o.assumed} assumed${o.failed > 0 ? `, ${o.failed} failed` : ''}`);
  for (const c of o.checked_at) lines.push(`    checked at ${c}`);
  lines.push(r.unresolvable_calls.length === 0 ? '  unresolvable calls: none' : '  unresolvable calls:');
  for (const u of r.unresolvable_calls) lines.push(`    ${u.at}: ${u.reason}`);
  lines.push(r.capabilities.length === 0 ? '  capabilities: none' : '  capabilities:');
  for (const c of r.capabilities) lines.push(`    ${c.type} at ${c.constructed_at}`);
  return `${lines.join('\n')}\n`;
}

function lineCol(ctx: Context, span: Span): string {
  const p = lineColOf(ctx.fileOf(span), span.start);
  return `${p.line}:${p.col}`;
}

export type { DefId };
