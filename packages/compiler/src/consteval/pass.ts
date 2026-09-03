/**
 * The const-evaluation pass (impl spec §4, pass 5; language spec §3.8, §5.2).
 *
 *   - every `const` definition is evaluated (E0701 when it is not constant);
 *   - at every call whose arguments are constant, the callee's `requires
 *     proved` clauses are evaluated: a clause that is false is E0700, with a
 *     `ConstError` mapped into the text literal it indexes;
 *   - `example` blocks whose statements are evaluable run at check time: a
 *     false assertion is E0702, and an example that needs the runtime is
 *     deferred to the generated tests;
 *   - a contract failing inside evaluation is E0701; exceeding the step
 *     budget is E0501, naming the function that spent it.
 */
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Def, DefId } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import { walk } from '../syntax/walk.js';
import { stripRefinements } from '../types/type.js';
import { BudgetExceeded, EvalPanic, Evaluator, NotConst, type Env } from './eval.js';
import { graphemeSpan } from './offsets.js';
import { ofConst, type Value } from './values.js';

/**
 * Pass 5: evaluate constants, check-time contracts and pure examples.
 * Preconditions: `typesPass` has run without diagnostics.
 * Effects: writes `ctx.consteval`; reports E0501, E0700, E0701, E0702.
 */
export function constevalPass(ctx: Context): void {
  new ConstPass(ctx).run();
}

class ConstPass {
  private readonly ev: Evaluator;
  private readonly busy = new Set<DefId>();
  private currentDef: string | null = null;

  constructor(private readonly ctx: Context) {
    this.ev = new Evaluator(ctx, { constOf: (d) => this.constOf(d) });
  }

  private report(code: Code, span: Span, detail: string, extra: Partial<Parameters<typeof diagnostic>[0]> = {}): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail], ...extra }));
  }

  run(): void {
    const t = this.ctx.resolve;
    for (const m of t.modules) {
      for (const item of m.module.items) {
        this.currentDef = 'name' in item ? item.name.text : item.iface.text;
        if (item.kind === 'ConstDecl') this.constDecl(item);
        else if (item.kind === 'ExampleDecl') this.example(item);
        this.callsIn(item);
        this.currentDef = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  /** The value of a `const`, memoised; null (after a report) when it cannot be evaluated. */
  constOf(def: DefId): Value | null {
    const tables = this.ctx.consteval;
    const memo = tables.constValues.get(def);
    if (memo !== undefined) return memo;
    if (this.busy.has(def)) return null;
    this.busy.add(def);
    const d = this.ctx.resolve.def(def);
    const node = this.ctx.resolve.node(d.node);
    let value: Value | null = null;
    if (node.kind === 'ConstDecl') {
      const saved = this.currentDef;
      this.currentDef = d.name;
      value = this.evaluate(() => this.ev.evalExpr(node.value, new Map()), node.value.span, `\`${d.name}\``);
      this.currentDef = saved;
    }
    this.busy.delete(def);
    if (value !== null) tables.constValues.set(def, value);
    return value;
  }

  private constDecl(item: A.ConstDecl): void {
    const def = this.ctx.resolve.defOf.get(item.id);
    if (def !== undefined) this.constOf(def);
  }

  /**
   * Runs `f` as one check-time evaluation. Reports NotConst as E0701 (a
   * constant must be evaluable), EvalPanic as E0701 and BudgetExceeded as
   * E0501; returns null after a report.
   */
  private evaluate<T>(f: () => T, span: Span, what: string): T | null {
    this.ev.reset();
    try {
      return f();
    } catch (err) {
      if (err instanceof NotConst) {
        this.report('E0701', err.span ?? span, `${what} is not a constant expression: ${err.reason}`);
        return null;
      }
      if (err instanceof EvalPanic) {
        this.report('E0701', err.span ?? span, `${what}: ${err.detail}`);
        return null;
      }
      if (err instanceof BudgetExceeded) {
        this.report('E0501', span, `evaluating ${what} exceeded the check-time step budget in \`${err.fn}\``);
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // `requires proved` at call sites
  // -------------------------------------------------------------------------

  private callsIn(item: A.Item): void {
    walk(item, (n) => {
      if (n.kind === 'Call') this.checkCall(n);
      return true;
    });
  }

  private checkCall(call: A.Call): void {
    const t = this.ctx.resolve;
    const ty = this.ctx.types;
    const res = t.refs.get(call.callee.id);
    if (res === undefined || !(res.k === 'def' || res.k === 'companion')) return;
    const fnDef = t.def(res.k === 'def' ? res.def : res.fn);
    if (fnDef.kind !== 'fn') return;
    const sig = ty.signatures.get(fnDef.id);
    if (sig === undefined) return;
    const clauses = sig.contracts.filter((c) => c.clause === 'requires' && c.proved);
    if (clauses.length === 0) return;
    // Bind every parameter to a constant, or give up silently: the verifier owns the rest.
    const env: Env = new Map();
    const targs = ty.instantiations.get(call.id) ?? [];
    for (let i = 0; i < sig.tparams.length; i++) {
      const p = sig.tparams[i];
      const a = targs[i];
      if (p === undefined || p.k !== 'const') continue;
      const v = a !== undefined && a.k === 'const' ? ofConst(a.value) : null;
      if (v === null) return;
      env.set(p.def, v);
    }
    // Bind the parameters whose arguments are constant; a clause that needs another one is left to the verifier.
    for (let i = 0; i < sig.params.length; i++) {
      const p = sig.params[i];
      const pd = sig.paramDefs[i];
      const a = call.args.find((x) => x.name.text === p?.name);
      if (p === undefined || pd === undefined || a === undefined) return;
      try {
        this.ev.reset();
        env.set(pd, this.ev.evalExpr(a.value, new Map()));
      } catch (err) {
        if (err instanceof NotConst || err instanceof EvalPanic || err instanceof BudgetExceeded) continue;
        throw err;
      }
    }
    for (const clause of clauses) {
      this.ev.reset();
      let ok: Value;
      try {
        ok = this.ev.evalExpr(clause.expr, new Map(env));
      } catch (err) {
        if (err instanceof NotConst) continue;
        if (err instanceof EvalPanic) {
          this.report('E0701', call.span, `evaluating \`requires proved ${printExpr(clause.expr)}\` of \`${fnDef.name}\`: ${err.detail}`);
          continue;
        }
        if (err instanceof BudgetExceeded) {
          this.report('E0501', call.span, `evaluating \`requires proved ${printExpr(clause.expr)}\` of \`${fnDef.name}\` exceeded the check-time step budget in \`${err.fn}\``);
          continue;
        }
        throw err;
      }
      if (ok.k === 'bool' && ok.v) {
        let set = this.ctx.consteval.provedAtCheckTime.get(call.id);
        if (set === undefined) {
          set = new Set();
          this.ctx.consteval.provedAtCheckTime.set(call.id, set);
        }
        set.add(clause.id);
        continue;
      }
      this.libraryCheckFailed(call, fnDef, clause, this.ev.lastConstError);
      // One failed precondition invalidates the call; later clauses would only repeat it.
      return;
    }
  }

  private libraryCheckFailed(call: A.Call, fnDef: Def, clause: A.Contract, error: Value | null): void {
    const t = this.ctx.resolve;
    let span: Span = call.span;
    let message = `\`requires proved ${printExpr(clause.expr)}\` of \`${fnDef.name}\` is false`;
    if (error !== null && error.k === 'record') {
      const offset = error.fields.get('offset');
      const msg = error.fields.get('message');
      if (msg !== undefined && msg.k === 'text') message = msg.v;
      const literal = this.constTextLiteral(call, fnDef);
      if (offset !== undefined && offset.k === 'int' && literal !== null) span = graphemeSpan(this.ctx.fileOf(literal), literal, offset.v);
    }
    this.report('E0700', span, message, {
      obligation: { kind: 'requires', text: printExpr(clause.expr), status: 'failed', counterexample: null },
      context: [message, `in the \`requires proved\` clause of \`${t.qualifiedName(fnDef.id)}\``],
    });
  }

  /** The literal passed for the callee's first `const` Text parameter, if it is one. */
  private constTextLiteral(call: A.Call, fnDef: Def): Span | null {
    const sigParams = this.ctx.types.typeParams.get(fnDef.id) ?? [];
    const index = sigParams.findIndex((p) => {
      if (p.k !== 'const') return false;
      const st = stripRefinements(p.type);
      return st.k === 'prim' && st.name === 'Text';
    });
    if (index < 0 || call.targs === null) return null;
    const param = sigParams[index];
    if (param === undefined) return null;
    const name = this.ctx.resolve.def(param.def).name;
    let positional = 0;
    for (const a of call.targs) {
      const matches = a.label !== null ? a.label.text === name : positional === index;
      if (a.label === null) positional += 1;
      if (!matches) continue;
      return a.kind === 'TypeArgConst' && a.expr.kind === 'TextLit' ? a.expr.span : null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Examples (§5.2)
  // -------------------------------------------------------------------------

  private example(item: A.ExampleDecl): void {
    const def = this.ctx.resolve.defOf.get(item.id);
    if (def === undefined) return;
    const tables = this.ctx.consteval;
    const env: Env = new Map();
    this.ev.reset();
    try {
      for (const s of item.body.stmts) {
        if (s.kind === 'ExprStmt') {
          const v = this.ev.evalExpr(s.expr, env);
          if (v.k !== 'bool' || !v.v) {
            this.report('E0702', s.span, `\`${printExpr(s.expr)}\` is false`);
            tables.examples.set(def, 'failed');
            return;
          }
        } else {
          this.ev.execStmt(s, env);
        }
      }
      tables.examples.set(def, 'passed');
    } catch (err) {
      if (err instanceof NotConst) {
        tables.examples.set(def, 'deferred');
        return;
      }
      if (err instanceof EvalPanic) {
        this.report('E0701', err.span ?? item.name.span, `example \`${item.name.text}\`: ${err.detail}`);
        tables.examples.set(def, 'failed');
        return;
      }
      if (err instanceof BudgetExceeded) {
        this.report('E0501', item.name.span, `example \`${item.name.text}\` exceeded the check-time step budget in \`${err.fn}\``);
        tables.examples.set(def, 'failed');
        return;
      }
      throw err;
    }
  }
}
