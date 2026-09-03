/**
 * The paths pass (impl spec §4, pass 12; language spec §9).
 *
 * For every `path`: the set of functions reachable from `entry` (calls in
 * bodies, closures included; interface calls resolved on concrete receivers;
 * calls through function values and dispatch on type parameters are
 * unresolvable and fail closed, E0410); the union of their effects against
 * `effects <=` (E0412) and `forbid` (E0413), which must be consistent with
 * each other (E0411); required claims (E0414): an asserted claim must be
 * carried by every reachable function with observable effects that is not
 * under an `assume` of it, a derived one by every reachable function; and the
 * policy (E0415) over every `assume` in the reachable set. The analysis is
 * recorded for the path report (§9.1) whether or not it passed.
 */
import { calleeEffects, calleeOf, effectsOfFn } from '../claims/calls.js';
import { observable } from '../claims/pass.js';
import type { Context } from '../context.js';
import { EffectSet, type Effect } from '../effects/set.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { DefId, ModuleRecord } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { walk } from '../syntax/walk.js';
import { stripRefinements, typeToString, type Type } from '../types/type.js';
import type { CallEdge, CapabilitySite, Gate, PathAssume, RecoverSite, UnresolvableCall } from './tables.js';

/**
 * Pass 12: paths.
 * Preconditions: the verify pass ran (statuses are final) without diagnostics.
 * Effects: fills `ctx.paths`; reports E0410–E0415.
 */
export function pathsPass(ctx: Context): void {
  for (const m of ctx.resolve.modules) {
    for (const item of m.module.items) {
      if (item.kind === 'PathDecl') new PathChecker(ctx, m, item).run();
    }
  }
}

class PathChecker {
  private errors = 0;

  constructor(
    private readonly ctx: Context,
    private readonly m: ModuleRecord,
    private readonly path: A.PathDecl,
  ) {}

  private report(code: Code, span: Span, detail: string, def: string | null = this.path.name.text): void {
    this.errors += 1;
    this.ctx.sink.report(diagnostic({ code, span, def, context: [detail] }));
  }

  run(): void {
    const t = this.ctx.resolve;
    const pathDef = t.defOf.get(this.path.id);
    const entryRes = t.refs.get(this.path.id);
    if (pathDef === undefined || entryRes === undefined || entryRes.k !== 'def') return;
    const entry = entryRes.def;
    let bound: EffectSet | null = null;
    let forbid = EffectSet.empty();
    const required: DefId[] = [];
    let policy: { def: DefId; except: readonly string[]; span: Span } | null = null;
    const spans = { bound: this.path.span, forbid: this.path.span, require: this.path.span };
    for (const c of this.path.clauses) {
      switch (c.kind) {
        case 'PathEffects':
          if (bound === null) spans.bound = c.span;
          bound = (bound ?? EffectSet.empty()).union(this.effectsOf(c.effects));
          break;
        case 'PathForbid':
          if (forbid.size === 0) spans.forbid = c.span;
          forbid = forbid.union(this.effectsOf(c.effects));
          break;
        case 'PathRequire':
          if (required.length === 0) spans.require = c.span;
          required.push(...(t.claimLists.get(c.id) ?? []));
          break;
        case 'PathPolicy': {
          const res = t.refs.get(c.id);
          if (res !== undefined && res.k === 'def') policy = { def: res.def, except: c.except.map((q) => q.segments.map((s) => s.text).join('.')), span: c.span };
          break;
        }
      }
    }
    if (bound !== null) {
      for (const e of forbid.values()) {
        if (bound.has(e)) this.report('E0411', this.path.span, `\`${effectName(this.ctx, e)}\` is allowed by \`effects <=\` and listed under \`forbid\``);
      }
    }
    const { reachable, unresolvable, capabilities, edges, recovers } = this.reach(entry);
    for (const u of unresolvable) {
      this.report('E0410', t.node(u.at).span, `on path \`${this.path.name.text}\`: ${u.reason}, so the reachable set cannot be closed`, t.def(u.fn).name);
    }
    let actual = EffectSet.empty();
    for (const fn of reachable) {
      const effects = EffectSet.of(effectsOfFn(this.ctx, fn).values().filter((e) => e.k !== 'param'));
      actual = actual.union(effects);
      const outside = bound === null ? [] : effects.values().filter((e) => !bound.has(e));
      if (outside.length > 0) {
        this.report('E0412', spans.bound, `\`${t.qualifiedName(fn)}\` is reachable and has effect${outside.length === 1 ? '' : 's'} { ${outside.map((e) => effectName(this.ctx, e)).join(', ')} } outside the bound`);
      }
      const forbidden = effects.values().filter((e) => forbid.has(e));
      if (forbidden.length > 0) {
        this.report('E0413', spans.forbid, `\`${t.qualifiedName(fn)}\` is reachable and has forbidden effect${forbidden.length === 1 ? '' : 's'} { ${forbidden.map((e) => effectName(this.ctx, e)).join(', ')} }`);
      }
    }
    let satisfied = true;
    for (const claim of required) {
      const asserted = this.ctx.claims.tiers.get(claim) === 'asserted';
      for (const fn of asserted ? this.uncovered(entry, claim) : reachable) {
        if (asserted && !observable(effectsOfFn(this.ctx, fn))) continue;
        if (this.ctx.claims.carries(fn, claim)) continue;
        satisfied = false;
        this.report('E0414', spans.require, `\`${t.qualifiedName(fn)}\` is reachable${asserted ? ' with observable effects' : ''} and does not carry required claim \`${t.def(claim).name}\``);
      }
    }
    const assumes: PathAssume[] = [];
    for (const fn of reachable) {
      for (const a of this.ctx.claims.assumesOf(fn)) {
        const owner = t.def(fn);
        let permittedBy: PathAssume['permittedBy'] = null;
        if (policy !== null) {
          if (this.inPolicyScope(policy.def, owner.module)) permittedBy = 'scope';
          else if (policy.except.includes(t.qualifiedName(fn))) permittedBy = 'except';
          else this.report('E0415', policy.span, `\`${t.qualifiedName(fn)}\` assumes \`${t.def(a.claim).name}\` ("${a.justification}") outside the policy's scope and is not listed under \`except\``);
        }
        assumes.push({ claim: a.claim, fn, justification: a.justification, node: a.node, permittedBy });
      }
    }
    this.ctx.paths.analyses.set(pathDef, {
      def: pathDef,
      module: this.m.id,
      entry,
      reachable,
      bound,
      forbid,
      actual,
      required,
      satisfied,
      policy: policy === null ? null : policy.def,
      assumes,
      unresolvable,
      capabilities,
      edges,
      gates: this.gates(reachable),
      recovers,
      ok: this.errors === 0,
    });
  }

  /** `sql.Db[ReadOnly]`: the capability's module alias and its type (§9.1). */
  private capabilityText(type: Type): string {
    const t = this.ctx.resolve;
    const text = typeToString(type, t);
    if (type.k !== 'capability') return text;
    const alias = t.moduleOf(t.def(type.def).module).name.split('.').pop() ?? '';
    return `${alias}.${text}`;
  }

  private effectsOf(refs: readonly A.EffectRef[]): EffectSet {
    const out: Effect[] = [];
    for (const r of refs) {
      const res = this.ctx.resolve.refs.get(r.id);
      if (res !== undefined && res.k === 'effect') out.push(res.effect);
    }
    return EffectSet.of(out);
  }

  /** Breadth-first reachability from `entry` over resolvable calls. */
  private reach(entry: DefId): { reachable: DefId[]; unresolvable: UnresolvableCall[]; capabilities: CapabilitySite[]; edges: CallEdge[]; recovers: RecoverSite[] } {
    const t = this.ctx.resolve;
    const reachable: DefId[] = [];
    const seen = new Set<DefId>();
    const unresolvable: UnresolvableCall[] = [];
    const capabilities: CapabilitySite[] = [];
    const edges: CallEdge[] = [];
    const recovers: RecoverSite[] = [];
    const queue: DefId[] = [entry];
    while (queue.length > 0) {
      const fn = queue.shift();
      if (fn === undefined || seen.has(fn)) continue;
      seen.add(fn);
      reachable.push(fn);
      const node = t.node(t.def(fn).node);
      if (node.kind !== 'FnDecl' || node.body === null) continue;
      walk(node.body, (n) => {
        if (n.kind === 'Recover') recovers.push({ fn, at: n.id });
        if (n.kind !== 'Call') return true;
        const callee = calleeOf(this.ctx, n);
        switch (callee.k) {
          case 'fn':
          case 'impl': {
            queue.push(callee.def);
            edges.push({ from: fn, to: callee.def, at: n.id, effects: calleeEffects(this.ctx, n, callee.def) });
            const produced = capabilityIn(this.ctx.types.exprTypes.get(n.id) ?? null);
            if (produced !== null) capabilities.push({ fn, at: n.id, typeText: this.capabilityText(produced) });
            return true;
          }
          case 'dispatch':
            unresolvable.push({ fn, at: n.id, reason: `\`${t.def(callee.fn).name}\` is dispatched on a type parameter` });
            return true;
          case 'value':
            unresolvable.push({ fn, at: n.id, reason: 'this call goes through a function value whose provenance is not tracked in v0' });
            return true;
          case 'ctor':
            return true;
        }
      });
    }
    return { reachable, unresolvable, capabilities, edges, recovers };
  }

  /** Sealed record types that some reachable function returns and others demand as a parameter (§3.10). */
  private gates(reachable: readonly DefId[]): Gate[] {
    const t = this.ctx.resolve;
    const producers = new Map<DefId, DefId[]>();
    const guarded = new Map<DefId, DefId[]>();
    for (const fn of reachable) {
      const sig = this.ctx.types.signatures.get(fn);
      if (sig === undefined) continue;
      for (const p of sig.params) for (const e of sealedRecordsIn(p.type, t)) guarded.set(e, [...(guarded.get(e) ?? []), fn]);
      for (const e of sealedRecordsIn(sig.ret, t)) producers.set(e, [...(producers.get(e) ?? []), fn]);
    }
    const out: Gate[] = [];
    for (const [evidence, ps] of producers) {
      const gs = (guarded.get(evidence) ?? []).filter((g) => !ps.includes(g));
      if (gs.length > 0) out.push({ evidence, producers: ps, guarded: gs });
    }
    return out;
  }

  /** Reachable functions not under an `assume` of `claim`: an assumption covers everything beneath it. */
  private uncovered(entry: DefId, claim: DefId): DefId[] {
    const t = this.ctx.resolve;
    const out: DefId[] = [];
    const seen = new Set<DefId>();
    const queue: DefId[] = [entry];
    while (queue.length > 0) {
      const fn = queue.shift();
      if (fn === undefined || seen.has(fn)) continue;
      seen.add(fn);
      out.push(fn);
      if (this.ctx.claims.assumesOf(fn).some((a) => a.claim === claim)) continue;
      const node = t.node(t.def(fn).node);
      if (node.kind !== 'FnDecl' || node.body === null) continue;
      walk(node.body, (n) => {
        if (n.kind !== 'Call') return true;
        const callee = calleeOf(this.ctx, n);
        if (callee.k === 'fn' || callee.k === 'impl') queue.push(callee.def);
        return true;
      });
    }
    return out;
  }

  /** `forbid assume outside { self, std.* }`: whether `module` is inside the policy's scope. */
  private inPolicyScope(policyDef: DefId, module: ModuleRecord['id']): boolean {
    const t = this.ctx.resolve;
    const node = t.node(t.def(policyDef).node);
    if (node.kind !== 'PolicyDecl') return false;
    const name = t.moduleOf(module).name;
    return node.outside.some((scope) => {
      if (scope.name === null) return module === this.m.id;
      const prefix = scope.name.segments.map((s) => s.text).join('.');
      return scope.glob ? name === prefix || name.startsWith(`${prefix}.`) : name === prefix;
    });
  }
}

/** The sealed record types mentioned in `t`. Effects: none. */
function sealedRecordsIn(t: Type, tables: Context['resolve'], out = new Set<DefId>()): Set<DefId> {
  switch (t.k) {
    case 'refined':
      return sealedRecordsIn(t.base, tables, out);
    case 'record':
      if (tables.def(t.def).sealed) out.add(t.def);
      for (const a of t.args) if (a.k === 'type') sealedRecordsIn(a.type, tables, out);
      return out;
    case 'union':
    case 'opaque':
    case 'capability':
      for (const a of t.args) if (a.k === 'type') sealedRecordsIn(a.type, tables, out);
      return out;
    case 'fn':
      for (const p of t.params) sealedRecordsIn(p.type, tables, out);
      return sealedRecordsIn(t.ret, tables, out);
    default:
      return out;
  }
}

/** The capability a call result carries: directly, or as the success payload of a union such as `Result`. */
function capabilityIn(t: Type | null): Type | null {
  if (t === null) return null;
  const s = stripRefinements(t);
  if (s.k === 'capability') return s;
  if (s.k === 'union') {
    for (const a of s.args) {
      if (a.k === 'type' && stripRefinements(a.type).k === 'capability') return stripRefinements(a.type);
    }
  }
  return null;
}

/** Source spelling of an effect. Effects: none. */
export function effectName(ctx: Context, e: Effect): string {
  return e.k === 'param' ? ctx.resolve.def(e.def).name : e.name;
}
