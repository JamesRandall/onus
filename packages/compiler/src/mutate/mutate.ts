/**
 * Contract mutation (language spec §20.4; impl spec M13): `onus test
 * --mutate` weakens contracts one at a time and reports which weakenings no
 * example, property or law detects. A weakening never changes a body, so a
 * test detects it by *meaning*, not by failing: an assertion the verifier
 * proved from the contracts that stops being provable without the clause
 * shows that the test pins what the clause promised. Negating a property's
 * guard is the one dynamic mutation: the property is re-run over the
 * complement of its domain.
 *
 * Mutations never touch bodies. Laws are not mutated: a law is itself the
 * only test of the interface clause it states (docs/CHANGES.md item 107).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../context.js';
import { emitAll } from '../codegen/build.js';
import { runJsExamples } from '../codegen/native-build.js';
import type { MutationRecord } from '../report/ledger.js';
import type { DefId } from '../resolve/defs.js';
import { printExpr } from '../syntax/printer.js';
import { isRefined, stripRefinements, typeToString } from '../types/type.js';
import { problemText } from '../verify/pass.js';
import { buildVCs, type Mutation } from '../verify/vc.js';
import { runZ3 } from '../verify/z3.js';

export type MutationPlan =
  | { readonly kind: 'drop-ensures' | 'widen-return' | 'widen-field'; readonly mutation: Mutation; readonly def: string; readonly text: string }
  | { readonly kind: 'negate-guard'; readonly property: DefId; readonly module: string; readonly name: string; readonly def: string; readonly text: string };

export interface MutateOptions {
  /** The solver, or null when static mutations cannot be assessed. */
  readonly z3: { readonly path: string; readonly version: string } | null;
  readonly budgetMs: number;
  /** Where the re-emitted programs for guard negation go. */
  readonly outDir: string;
}

/**
 * Every contract weakening §20.4 names, over the program's own modules:
 * each `ensures` clause dropped, each refined result or record field widened
 * to its base type, and each guarded property's guards negated.
 * Effects: none.
 */
export function enumerateMutations(ctx: Context): MutationPlan[] {
  const t = ctx.resolve;
  const out: MutationPlan[] = [];
  for (const d of t.defs) {
    const q = t.qualifiedName(d.id);
    if (q.startsWith('std.')) continue;
    if (d.kind === 'fn') {
      const sig = ctx.types.signatures.get(d.id);
      if (sig === undefined) continue;
      for (const c of sig.contracts) {
        if (c.clause !== 'ensures') continue;
        out.push({ kind: 'drop-ensures', mutation: { k: 'drop-ensures', fn: d.id, clause: c.id }, def: q, text: `drop \`ensures ${printExpr(c.expr)}\`` });
      }
      if (isRefined(sig.ret)) out.push({ kind: 'widen-return', mutation: { k: 'widen-return', fn: d.id }, def: q, text: `widen the result from \`${typeToString(sig.ret, t)}\` to \`${typeToString(stripRefinements(sig.ret), t)}\`` });
    } else if (d.kind === 'record') {
      for (const f of ctx.types.fields.get(d.id) ?? []) {
        if (!isRefined(f.type)) continue;
        out.push({ kind: 'widen-field', mutation: { k: 'widen-field', record: d.id, field: f.name }, def: q, text: `widen field \`${f.name}\` from \`${typeToString(f.type, t)}\` to \`${typeToString(stripRefinements(f.type), t)}\`` });
      }
    } else if (d.kind === 'property') {
      const node = t.node(d.node);
      if (node.kind !== 'PropertyDecl') continue;
      const guarded = node.params.some((p) => {
        const pd = t.defOf.get(p.id);
        const type = pd === undefined ? undefined : ctx.types.declTypes.get(pd);
        return type !== undefined && isRefined(type);
      });
      if (guarded) out.push({ kind: 'negate-guard', property: d.id, module: t.moduleOf(d.module).name, name: d.name, def: q, text: `negate the guards of \`property ${d.name}\`` });
    }
  }
  return out;
}

/**
 * Assesses each planned mutation. Static mutations are detected when a test
 * assertion the verifier proved becomes unprovable; guard negations when
 * the property fails over the complement of its domain. Static mutations
 * are skipped without z3.
 * Effects: runs z3; writes and runs programs under `opts.outDir/mutate`.
 */
export function runMutations(ctx: Context, plans: readonly MutationPlan[], opts: MutateOptions): MutationRecord[] {
  const t = ctx.resolve;
  const proved = ctx.contracts.obligations.filter((o) => o.kind === 'assertion' && o.status === 'proved');
  const out: MutationRecord[] = [];
  plans.forEach((plan, i) => {
    if (plan.kind === 'negate-guard') {
      const dir = join(opts.outDir, 'mutate', String(i));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      emitAll(ctx, { outDir: dir, ts: false, negateGuard: plan.property });
      const result = runJsExamples(dir, true).get(`${plan.module}.property ${plan.name}`);
      const detected = result === false;
      out.push({ kind: plan.kind, def: plan.def, text: plan.text, detected, by: result === undefined ? 'the property did not run' : detected ? 'the property fails over the complement of its domain' : 'the property still passes over the complement of its domain' });
      return;
    }
    if (opts.z3 === null) return;
    const vcs = buildVCs(ctx, plan.mutation);
    let by = 'no proved assertion of an example, property or law depends on it';
    let detected = false;
    for (const o of proved) {
      const vc = vcs.built.get(o.id);
      if (vc === undefined) continue;
      if (runZ3(opts.z3.path, problemText(vc, opts.budgetMs), opts.budgetMs).outcome === 'unsat') continue;
      detected = true;
      by = `\`${o.text}\` in ${t.qualifiedName(o.def)} no longer follows from the contracts`;
      break;
    }
    out.push({ kind: plan.kind, def: plan.def, text: plan.text, detected, by });
  });
  return out;
}
