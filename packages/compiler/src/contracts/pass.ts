/**
 * The contracts pass (impl spec §4, pass 8; language spec §12.1): creates an
 * obligation object for every site that must hold:
 *
 *   - `requires` of the callee at every call;
 *   - `ensures` of the function at every `return`, and the return type's
 *     refinement;
 *   - every flow of a value into a refined type (bindings, assignments,
 *     fields, arguments, loop elements);
 *   - `invariant` at loop entry and after each iteration; `decreases`;
 *   - integer arithmetic (`overflow`);
 *   - every `law` on every `impl`; every `property`.
 *
 * Milestone 5: every obligation is `checked`, except `requires proved`
 * clauses the const evaluator discharged, which are `proved`. The verifier
 * of milestone 6 revises statuses; codegen inserts a runtime check iff
 * `checked`.
 */
import type { Context } from '../context.js';
import type { Def, DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { printExpr } from '../syntax/printer.js';
import { walk } from '../syntax/walk.js';
import { stripRefinements, type Type } from '../types/type.js';
import type { RefinementSite } from './obligations.js';

/**
 * Pass 8: create obligations.
 * Preconditions: types, consteval and effects passes ran without diagnostics.
 * Effects: writes `ctx.contracts`.
 */
export function contractsPass(ctx: Context): void {
  new ContractsPass(ctx).run();
}

class ContractsPass {
  constructor(private readonly ctx: Context) {}

  run(): void {
    const t = this.ctx.resolve;
    for (const m of t.modules) {
      for (const item of m.module.items) {
        switch (item.kind) {
          case 'FnDecl':
            this.fn(item, this.defOf(item));
            break;
          case 'ImplDecl': {
            for (const f of item.fns) this.fn(f, this.defOf(f));
            this.laws(item);
            break;
          }
          case 'PropertyDecl':
            this.ctx.contracts.add({ kind: 'property', at: item.id, def: this.defOf(item).id, text: item.name.text, source: item.body.id, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: 'milestone 5: run under generated inputs' });
            this.body(item.body, this.defOf(item), null);
            this.assertions(item.body, this.defOf(item));
            break;
          case 'ExampleDecl':
            this.body(item.body, this.defOf(item), null);
            this.assertions(item.body, this.defOf(item));
            break;
          case 'ConstDecl':
            this.exprs(item.value, this.defOf(item), null);
            break;
          default:
            break;
        }
      }
    }
  }

  private defOf(node: A.NodeBase): Def {
    const d = this.ctx.resolve.defOf.get(node.id);
    if (d === undefined) throw new Error(`no definition for node ${node.id}`);
    return this.ctx.resolve.def(d);
  }

  private fn(f: A.FnDecl, def: Def): void {
    if (f.body === null) return;
    const sig = this.ctx.types.signatures.get(def.id);
    sig?.params.forEach((p, i) => {
      const pd = sig.paramDefs[i];
      if (pd !== undefined) this.representation(this.ctx.resolve.def(pd).node, p.name, p.type, def);
    });
    this.body(f.body, def, f);
  }

  /** §19.3: an `Int` binding's values must fit ±2^53 - 1 for the JavaScript backend's number representation. */
  private representation(at: A.NodeId, name: string, type: Type, def: Def): void {
    const s = stripRefinements(type);
    if (s.k !== 'prim' || (s.name !== 'Int' && s.name !== 'Duration')) return;
    this.ctx.contracts.add({ kind: 'representation', at, def: def.id, text: `${name} within ±2^53 - 1`, source: null, site: 'binding', pinned: null, callee: null, param: null, status: 'checked', by: null });
  }

  /** Walks a body: statements and their expressions, closures included (their returns check their own contracts). */
  private body(b: A.Block, def: Def, fn: A.FnDecl | null): void {
    walk(b, (n) => {
      if (n.kind === 'VerifyBlock') {
        // A verify block is a function of its own (§20.2): its obligations belong to its definition.
        const vd = this.ctx.resolve.defOf.get(n.id);
        if (vd !== undefined) this.body(n.body, this.ctx.resolve.def(vd), null);
        return false;
      }
      switch (n.kind) {
        case 'Return':
          if (fn !== null) this.returnSite(n, fn, def);
          break;
        case 'Loop':
          for (const c of n.clauses) {
            if (c.clause === 'invariant') {
              this.ctx.contracts.add({ kind: 'invariant-entry', at: n.id, def: def.id, text: printExpr(c.expr), source: c.id, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: null });
              this.ctx.contracts.add({ kind: 'invariant-step', at: n.id, def: def.id, text: printExpr(c.expr), source: c.id, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: null });
            } else {
              this.ctx.contracts.add({ kind: 'decreases', at: n.id, def: def.id, text: printExpr(c.expr), source: c.id, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: null });
            }
          }
          break;
        case 'Let':
        case 'Var': {
          this.flow(n.value, def, 'binding');
          const d = this.ctx.resolve.defOf.get(n.id);
          const type = d === undefined ? undefined : this.ctx.types.declTypes.get(d);
          if (type !== undefined) this.representation(n.id, n.name.text, type, def);
          break;
        }
        case 'Assign':
          this.flow(n.value, def, 'assignment');
          break;
        case 'For':
          this.flow(n.domain.kind === 'InDomain' ? n.domain.expr : n.domain.lo, def, 'element');
          break;
        case 'Closure':
          // A closure's returns check the closure's own return type; its body is walked here too.
          break;
        case 'Call':
          this.call(n, def);
          break;
        case 'Binary':
          this.arith(n, def);
          break;
        case 'Ctor':
          for (const a of n.args ?? []) this.flow(a.value, def, 'field');
          for (const f of n.fields ?? []) this.flow(f.value, def, 'field');
          break;
        case 'RecordUpdate':
          for (const f of n.fields) this.flow(f.value, def, 'field');
          break;
        default:
          break;
      }
      return true;
    });
  }

  /** Obligations inside an expression outside a body (a constant's initialiser). */
  private exprs(e: A.Expr, def: Def, fn: A.FnDecl | null): void {
    void fn;
    walk(e, (n) => {
      if (n.kind === 'Call') this.call(n, def);
      if (n.kind === 'Binary') this.arith(n, def);
      return true;
    });
  }

  private returnSite(r: A.Return, fn: A.FnDecl, def: Def): void {
    for (const c of fn.contracts) {
      if (c.clause !== 'ensures') continue;
      this.ctx.contracts.add({ kind: 'ensures', at: r.id, def: def.id, text: printExpr(c.expr), source: c.id, site: 'return', pinned: c.proved ? 'proved' : null, callee: null, param: null, status: 'checked', by: null });
    }
    this.flow(r.value, def, 'return');
  }

  /** A refinement obligation for the flow recorded at expression `e`, if any. */
  private flow(e: A.Expr, def: Def, site: RefinementSite, callee: DefId | null = null, param: string | null = null): void {
    const flow = this.ctx.types.refinementFlows.find((f) => f.at === e.id);
    if (flow === undefined) return;
    this.ctx.contracts.add({ kind: 'refinement', at: e.id, def: def.id, text: this.refinementText(flow.to), source: refinementSource(flow.to), site, pinned: null, callee, param, status: 'checked', by: null });
  }

  private refinementText(t: Type): string {
    const preds: string[] = [];
    let cur = t;
    while (cur.k === 'refined') {
      const node = this.ctx.resolve.node(cur.pred);
      preds.push(isExpr(node) ? printExpr(node) : '…');
      cur = cur.base;
    }
    return preds.join(' and ');
  }

  private call(call: A.Call, def: Def): void {
    const t = this.ctx.resolve;
    const res = t.refs.get(call.callee.id);
    if (res === undefined || !(res.k === 'def' || res.k === 'companion' || res.k === 'iface-fn')) return;
    const fnDef = t.def(res.k === 'def' ? res.def : res.fn);
    const sig = this.ctx.types.signatures.get(fnDef.id);
    if (sig === undefined) return;
    const provedHere = this.ctx.consteval.provedAtCheckTime.get(call.id);
    for (const c of sig.contracts) {
      if (c.clause !== 'requires') continue;
      const proved = provedHere?.has(c.id) ?? false;
      this.ctx.contracts.add({
        kind: 'requires',
        at: call.id,
        def: def.id,
        text: printExpr(c.expr),
        source: c.id,
        site: 'other',
        pinned: c.proved ? 'proved' : null,
        callee: fnDef.id,
        param: null,
        status: proved ? 'proved' : 'checked',
        by: proved ? 'const evaluator' : null,
      });
    }
    for (const a of call.args) this.flow(a.value, def, 'argument', fnDef.id, a.name.text);
  }

  private arith(b: A.Binary, def: Def): void {
    if (b.op !== '+' && b.op !== '-' && b.op !== '*' && b.op !== '/' && b.op !== '%') return;
    const lt = this.ctx.types.exprTypes.get(b.left.id);
    const s = lt === undefined ? undefined : stripRefinements(lt);
    if (s === undefined || s.k !== 'prim' || (s.name !== 'Int' && s.name !== 'Duration')) return;
    const text = b.op === '/' || b.op === '%' ? `${printExpr(b.right)} != 0` : `${printExpr(b)} within Int`;
    this.ctx.contracts.add({ kind: 'overflow', at: b.id, def: def.id, text, source: null, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: null });
  }

  /** The bare Bool statements of an assertion block (§5.2), each an obligation the verifier may prove from the contracts. */
  private assertions(b: A.Block, def: Def): void {
    for (const s of b.stmts) {
      if (s.kind !== 'ExprStmt') continue;
      this.ctx.contracts.add({ kind: 'assertion', at: s.expr.id, def: def.id, text: printExpr(s.expr), source: null, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: 'run as a test' });
    }
  }

  private laws(impl: A.ImplDecl): void {
    const ifaceRes = this.ctx.resolve.refs.get(impl.id);
    if (ifaceRes === undefined || ifaceRes.k !== 'def') return;
    const implDef = this.defOf(impl);
    for (const law of this.ctx.resolve.defs.filter((d) => d.parent === ifaceRes.def && d.kind === 'law')) {
      this.ctx.contracts.add({ kind: 'law', at: impl.id, def: implDef.id, text: law.name, source: law.node, site: 'other', pinned: null, callee: null, param: null, status: 'checked', by: 'milestone 5: run under generated inputs' });
      const lawNode = this.ctx.resolve.node(law.node);
      if (lawNode.kind === 'Law') this.assertions(lawNode.body, law);
    }
  }
}

function refinementSource(t: Type): A.NodeId | null {
  return t.k === 'refined' ? t.pred : null;
}

function isExpr(n: A.Node): n is A.Expr {
  switch (n.kind) {
    case 'IntLit':
    case 'FloatLit':
    case 'TextLit':
    case 'BoolLit':
    case 'DurationLit':
    case 'Name':
    case 'It':
    case 'ResultRef':
    case 'Ctor':
    case 'RecordUpdate':
    case 'ListLit':
    case 'Try':
    case 'Recover':
    case 'Old':
    case 'Quantifier':
    case 'Closure':
    case 'Fake':
    case 'Hole':
    case 'FieldAccess':
    case 'Call':
    case 'Unary':
    case 'Binary':
    case 'And':
    case 'Or':
    case 'Is':
      return true;
    default:
      return false;
  }
}

