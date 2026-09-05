/**
 * The verification pass (impl spec §4, pass 11; language spec §12).
 *
 * For every `checked` obligation with a condition, asks z3 whether the
 * facts entail the goal:
 *   - `unsat` → `proved`;
 *   - `sat` → `checked`, or `failed` with a counterexample when the clause
 *     was pinned `proved` (E0302 for `ensures`, E0342 for `requires`);
 *   - `unknown`/timeout → `checked` for an unpinned nonlinear obligation,
 *     otherwise E0501.
 * Then the panic rule (§6.1): a function without `panic` may not carry a
 * `checked` obligation (E0343), overflow excepted in v0 (impl spec §12.1);
 * and a `const fn` must have every obligation proved (E0703).
 *
 * Without z3 on PATH every obligation stays `checked` and one line goes to
 * stderr; the program is still valid.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import { diagnostic, type ObligationInfo } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Def, DefId } from '../resolve/defs.js';
import type { Span } from '../source.js';
import { isNonlinear, smt, sortText, type Formula } from './formula.js';
import { buildVCs, type VC } from './vc.js';
import { constDischarge } from './constant.js';
import { findZ3, ProofCache, runZ3, type SolverResult } from './z3.js';

export const DEFAULT_BUDGET_MS = 500;

/**
 * Pass 11: verify obligations.
 * Preconditions: the contracts pass ran without diagnostics.
 * Effects: updates obligation statuses; reports E0302, E0342, E0343, E0501, E0703; may spawn z3 and write the cache.
 */
export function verifyPass(ctx: Context): void {
  new Verifier(ctx).run();
}

class Verifier {
  private currentDef: string | null = null;

  constructor(private readonly ctx: Context) {}

  private report(code: Code, span: Span, detail: string, obligation?: ObligationInfo): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail], ...(obligation ? { obligation } : {}) }));
  }

  run(): void {
    const opts = this.ctx.options.verify;
    const z3 = findZ3(opts.z3Path);
    const vcs = buildVCs(this.ctx);
    this.equalMeasureCalls();
    if (z3 === null) {
      this.ctx.log('onus: z3 not found on PATH; every obligation is checked at runtime');
      for (const o of this.ctx.contracts.obligations) if (o.status === 'checked') o.by = 'z3 not available';
    } else {
      const cache = new ProofCache(opts.cacheDir);
      for (const o of this.ctx.contracts.obligations) {
        if (o.status !== 'checked' || o.kind === 'law' || o.kind === 'property') continue;
        const vc = vcs.built.get(o.id);
        if (vc === undefined) {
          // No solver condition (floats, closures): a closed predicate over constants can still be evaluated.
          const verdict = constDischarge(this.ctx, o);
          if (verdict === true) {
            o.status = 'proved';
            o.by = 'constant evaluation';
          } else {
            o.by = vcs.skipped.get(o.id) ?? 'no condition';
          }
          continue;
        }
        this.discharge(o, vc, z3.path, z3.version, cache, opts.budgetMs);
        // A closed predicate over constants the solver could not settle (floats are opaque to it) may still evaluate.
        if (o.status === 'checked' && o.pinned === null && constDischarge(this.ctx, o) === true) {
          o.status = 'proved';
          o.by = 'constant evaluation';
        }
      }
    }
    this.rules();
  }

  /**
   * Settles the `decreases` obligations of calls that pass a structural measure on unchanged (§5.1).
   * Sound when every cycle of the call graph takes a proper part somewhere, i.e. the calls passing the
   * measure unchanged form no cycle of their own; a call on such a cycle is E0344.
   * Preconditions: `buildVCs` has classified every structural `decreases` obligation.
   * Effects: updates obligation statuses; reports E0344.
   */
  private equalMeasureCalls(): void {
    const pending = this.ctx.contracts.obligations.filter((o) => o.kind === 'decreases' && o.status === 'checked' && o.by === 'equal argument' && o.callee !== null);
    const edges = new Map<DefId, Set<DefId>>();
    for (const o of pending) {
      if (o.callee === null) continue;
      let out = edges.get(o.def);
      if (out === undefined) {
        out = new Set();
        edges.set(o.def, out);
      }
      out.add(o.callee);
    }
    const reaches = (from: DefId, to: DefId): boolean => {
      const seen = new Set<DefId>();
      const stack = [from];
      while (stack.length > 0) {
        const v = stack.pop();
        if (v === undefined) break;
        if (v === to) return true;
        if (seen.has(v)) continue;
        seen.add(v);
        for (const w of edges.get(v) ?? []) stack.push(w);
      }
      return false;
    };
    for (const o of pending) {
      if (o.callee === null) continue;
      if (reaches(o.callee, o.def)) {
        o.status = 'failed';
        o.by = 'the calls passing the measure unchanged form a cycle';
        this.currentDef = this.ctx.resolve.def(o.def).name;
        const measure = o.text.replace(/ at the call to .*$/, '');
        this.report('E0344', this.ctx.resolve.node(o.at).span, `this call passes the measure \`${measure}\` on unchanged, and the calls that do so form a cycle; one of them must pass a proper part (§5.1)`, { kind: o.kind, text: o.text, status: 'unprovable', counterexample: null });
      } else {
        o.status = 'proved';
        o.by = 'structural order (passed on unchanged here; every cycle takes a proper part)';
      }
    }
  }

  private discharge(o: Obligation, vc: VC, z3Path: string, version: string, cache: ProofCache, budgetMs: number): void {
    const problem = problemText(vc, budgetMs);
    const dump = process.env['ONUS_DUMP_SMT'];
    if (dump !== undefined && dump !== '') {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${o.id}_${this.ctx.resolve.def(o.def).name}_${o.kind}.smt2`), problem);
    }
    const key = cache.key(problem, version, budgetMs);
    let result = cache.get(key);
    if (result === null) {
      result = runZ3(z3Path, problem, budgetMs);
      cache.set(key, result);
    }
    this.currentDef = this.ctx.resolve.def(o.def).name;
    const site = this.ctx.resolve.node(o.at).span;
    switch (result.outcome) {
      case 'unsat':
        o.status = 'proved';
        o.by = 'z3';
        return;
      case 'sat':
        if (o.pinned === 'proved') {
          o.status = 'failed';
          o.by = 'z3: counterexample';
          this.report(o.kind === 'ensures' ? 'E0302' : 'E0342', site, `\`${o.kind} proved ${o.text}\` does not hold on every path`, {
            kind: o.kind,
            text: o.text,
            status: 'unprovable',
            counterexample: counterexample(result, vc),
          });
        } else {
          o.by = o.kind === 'assertion' ? 'run as a test' : 'z3: not provable';
        }
        return;
      case 'timeout':
      case 'unknown': {
        const nonlinear = isNonlinear(vc.goal) || vc.facts.some(isNonlinear);
        if (nonlinear && o.pinned === null) {
          o.by = 'z3: nonlinear, budget exceeded';
          return;
        }
        this.report('E0501', site, `z3 gave up on \`${o.kind} ${o.text}\` within ${budgetMs} ms${nonlinear ? ' (nonlinear arithmetic)' : ''}; raise the budget or simplify the contract`, {
          kind: o.kind,
          text: o.text,
          status: 'unprovable',
          counterexample: null,
        });
        if (o.pinned === 'proved') o.status = 'failed';
        o.by = 'z3: budget exceeded';
        return;
      }
      case 'error':
        this.report('E0999', site, `z3 rejected the problem for \`${o.kind} ${o.text}\`: ${result.detail}`);
        o.by = 'z3: error';
        return;
    }
  }

  /** The panic rule (§6.1) and the const fn rule (§3.8.1). */
  private rules(): void {
    const t = this.ctx.resolve;
    const byDef = new Map<Def['id'], Obligation[]>();
    for (const o of this.ctx.contracts.obligations) {
      const list = byDef.get(o.def) ?? [];
      list.push(o);
      byDef.set(o.def, list);
    }
    for (const [defId, obligations] of byDef) {
      const def = t.def(defId);
      if (def.kind !== 'fn' && def.kind !== 'verify') continue;
      const node = t.node(def.node);
      const effects = node.kind === 'VerifyBlock' ? this.ctx.types.verifies.get(node.id)?.effects : this.ctx.types.signatures.get(defId)?.effects;
      if (effects === undefined) continue;
      if (node.kind === 'FnDecl' && node.body === null) continue;
      const sig = { constFn: node.kind === 'FnDecl' && node.constFn };
      const hasPanic = effects.values().some((e) => e.k === 'prim' && e.name === 'panic');
      this.currentDef = def.name;
      for (const o of obligations) {
        if (o.status !== 'checked' || o.kind === 'law' || o.kind === 'property') continue;
        const site = t.node(o.at).span;
        const info: ObligationInfo = { kind: o.kind, text: o.text, status: 'checked', counterexample: null };
        if (o.kind === 'representation') continue; // §19.3: reported in the ledger; the JavaScript number range is the runtime's assumption
        if (sig.constFn && o.kind !== 'overflow') {
          this.report('E0703', site, `\`${def.name}\` is a \`const fn\`, so \`${o.kind} ${o.text}\` must be proved; ${o.by ?? 'it was not'}`, info);
        } else if (!hasPanic && o.kind !== 'overflow') {
          this.report('E0343', site, `\`${o.kind} ${o.text}\` is checked at runtime (${o.by ?? 'not proved'}), so \`${def.name}\` must declare \`panic\` or the obligation must be proved`, info);
        }
      }
    }
  }
}

/** The SMT-LIB problem for a condition: declarations, axioms, facts, and the negated goal. Effects: none. */
export function problemText(vc: VC, budgetMs: number): string {
  const lines: string[] = ['(set-logic ALL)', `(set-option :timeout ${budgetMs})`, '(set-option :produce-models true)'];
  for (const s of vc.lowerer.sorts) lines.push(`(declare-sort ${s} 0)`);
  for (const [name, decl] of vc.lowerer.fns) lines.push(`(declare-fun ${name} (${decl.args.map(sortText).join(' ')}) ${sortText(decl.ret)})`);
  const distinct = vc.lowerer.textDistinctness();
  if (distinct !== null) lines.push(`(assert ${smt(distinct)})`);
  for (const a of vc.lowerer.axioms) lines.push(`(assert ${smt(a)})`);
  for (const f of vc.facts) lines.push(`(assert ${smt(f)})`);
  lines.push(`(assert ${smt(negate(vc.goal))})`, '(check-sat)', '(get-model)');
  return `${lines.join('\n')}\n`;
}

function negate(f: Formula): Formula {
  return { k: 'app', fn: 'not', args: [f], sort: { k: 'Bool' } };
}

/** The model restricted to source-named constants, with source names. Effects: none. */
function counterexample(result: SolverResult, vc: VC): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [smtName, value] of Object.entries(result.model)) {
    const source = vc.names.get(smtName);
    if (source === undefined) continue;
    const n = Number(value);
    out[source] = Number.isNaN(n) ? value : n;
  }
  return out;
}
