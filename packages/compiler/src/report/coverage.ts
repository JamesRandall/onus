/**
 * Obligation coverage (language spec §20.5): the metric `onus test` reports
 * and the interface, path and review reports carry. Per module or path:
 * obligations proved; obligations checked, and how many of those a test run
 * reached; assumptions, how many are verifiable and how many currently
 * verified; and contract mutations detected against surviving. Line
 * coverage is not reported.
 */
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import { lineColOf } from '../source.js';
import type { CoverageTable, MutationRecord } from './ledger.js';

export interface CoverageJson {
  readonly proved: number;
  readonly checked: number;
  /** Checked obligations whose runtime check at least one example, property or law reached. */
  readonly checked_exercised: number;
  readonly assumptions: number;
  readonly assumptions_verifiable: number;
  readonly assumptions_verified: number;
  readonly mutations_detected: number;
  readonly mutations_surviving: number;
}

/** Obligations that are tests themselves, or that no runtime check carries. */
const NOT_A_CHECK = new Set(['property', 'law', 'assertion', 'representation']);

/**
 * The `file:line:col` the runtime check for `o` reports: a refinement on an
 * argument is checked once at the callee's parameter, anything else at its
 * own node. Effects: none.
 */
export function checkSite(ctx: Context, o: Obligation): string {
  const t = ctx.resolve;
  let node = o.at;
  if (o.callee !== null && o.param !== null) {
    const sig = ctx.types.signatures.get(o.callee);
    const i = sig === undefined ? -1 : sig.params.findIndex((p) => p.name === o.param);
    const pd = sig === undefined || i < 0 ? undefined : sig.paramDefs[i];
    if (pd !== undefined) node = t.def(pd).node;
  }
  const span = t.node(node).span;
  const f = ctx.fileOf(span);
  const p = lineColOf(f, span.start);
  return `${f.path}:${p.line}:${p.col}`;
}

/**
 * The coverage of a set of obligations and assumptions; `inScope` says which
 * recorded mutations belong to the module or path. Effects: none.
 */
export function coverageOf(
  ctx: Context,
  obligations: readonly Obligation[],
  assumes: readonly { readonly verifiable: boolean; readonly last_verified: { readonly result: string } | null }[],
  inScope: (def: string) => boolean,
  table: CoverageTable = ctx.options.coverage,
): CoverageJson {
  const checks = obligations.filter((o) => !NOT_A_CHECK.has(o.kind));
  const checked = checks.filter((o) => o.status === 'checked');
  const mutations: readonly MutationRecord[] = ctx.options.mutations.filter((m) => inScope(m.def));
  return {
    proved: checks.filter((o) => o.status === 'proved').length,
    checked: checked.length,
    checked_exercised: checked.filter((o) => (table[checkSite(ctx, o)] ?? 0) > 0).length,
    assumptions: assumes.length,
    assumptions_verifiable: assumes.filter((a) => a.verifiable).length,
    assumptions_verified: assumes.filter((a) => a.last_verified !== null && a.last_verified.result === 'passed').length,
    mutations_detected: mutations.filter((m) => m.detected).length,
    mutations_surviving: mutations.filter((m) => !m.detected).length,
  };
}

/** One line of coverage, for `onus test`, the path text and the review page. Effects: none. */
export function coverageText(c: CoverageJson): string {
  const parts = [`${c.proved} proved`, `${c.checked} checked (${c.checked_exercised} exercised by tests)`, `${c.assumptions} assumption${c.assumptions === 1 ? '' : 's'} (${c.assumptions_verifiable} verifiable, ${c.assumptions_verified} verified)`];
  if (c.mutations_detected + c.mutations_surviving > 0) parts.push(`mutations: ${c.mutations_detected} detected, ${c.mutations_surviving} surviving`);
  return parts.join(', ');
}
