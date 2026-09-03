/**
 * The claims pass (impl spec §4, pass 9; language spec §6.3, §7).
 *
 * Tiers: a derived claim is a predicate over effects and other claims and
 * holds wherever the predicate holds; an asserted claim is carried by a
 * function that declares it, and is sound relative to its `assume` leaves.
 *
 * Propagation (§7.1): a function declaring an asserted claim either assumes
 * it in its body or every callee that participates carries it. A callee
 * participates when it has an observable effect: `io.file`, `io.net` or a
 * resource effect. The quiet effects — `alloc`, `mutate`, `panic`, `diverge`,
 * `nondet`, `io.env`, `io.clock`, `io.rand` — change nothing an observer
 * could see twice, so they never participate (docs/CHANGES.md item 76).
 *
 * Rules: E0203 (declared derived claim does not hold), E0204 (asserted claim
 * not propagated), E0205 (`assume` of a derived claim), E0206 (`assume` of a
 * claim the function does not declare).
 */
import type { Context } from '../context.js';
import { EffectSet } from '../effects/set.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Def, DefId } from '../resolve/defs.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { walk } from '../syntax/walk.js';
import { calleeEffects, calleeOf, effectsOfFn, valueEffects } from './calls.js';

export const QUIET_EFFECTS: ReadonlySet<string> = new Set(['alloc', 'mutate', 'panic', 'diverge', 'nondet', 'io.env', 'io.clock', 'io.rand']);

/** True iff `effects` contains an observable effect: `io.file`, `io.net` or a resource effect. Effects: none. */
export function observable(effects: EffectSet): boolean {
  return effects.values().some((e) => e.k === 'resource' || (e.k === 'prim' && !QUIET_EFFECTS.has(e.name)));
}

/**
 * Pass 9: claims.
 * Preconditions: the contracts pass ran without diagnostics.
 * Effects: fills `ctx.claims`; reports E0203–E0206.
 */
export function claimsPass(ctx: Context): void {
  new ClaimChecker(ctx).run();
}

class ClaimChecker {
  private currentDef: string | null = null;

  constructor(private readonly ctx: Context) {}

  private report(code: Code, span: Span, detail: string): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail] }));
  }

  run(): void {
    const t = this.ctx.resolve;
    const cl = this.ctx.claims;
    for (const m of t.modules) {
      for (const item of m.module.items) {
        if (item.kind !== 'ClaimDecl') continue;
        const d = t.defOf.get(item.id);
        if (d !== undefined) cl.tiers.set(d, item.body.kind === 'Derived' ? 'derived' : 'asserted');
      }
    }
    const fns = t.defs.filter((d) => d.kind === 'fn').map((d) => ({ def: d, node: t.node(d.node) })).filter((x): x is { def: Def; node: A.FnDecl } => x.node.kind === 'FnDecl');
    for (const { def, node } of fns) {
      cl.carried.set(def.id, new Set(t.claimLists.get(node.id) ?? []));
      if (node.body === null) continue;
      walk(node.body, (n) => {
        if (n.kind === 'Assume') {
          const res = t.refs.get(n.id);
          if (res !== undefined && res.k === 'def') cl.assumes.push({ fn: def.id, claim: res.def, justification: n.justification, node: n.id });
        }
        return true;
      });
    }
    // Derived claims hold wherever their predicate holds (§7), for every function with a signature.
    const derived = [...cl.tiers].filter(([, tier]) => tier === 'derived').map(([d]) => d);
    for (const d of t.defs) {
      if (d.kind !== 'fn' || !this.ctx.types.signatures.has(d.id)) continue;
      const set = new Set(cl.carried.get(d.id) ?? []);
      const effects = effectsOfFn(this.ctx, d.id);
      for (const c of derived) if (this.holds(c, effects, set, new Set())) set.add(c);
      cl.carried.set(d.id, set);
    }
    for (const { def, node } of fns) {
      this.currentDef = def.name;
      const declared = t.claimLists.get(node.id) ?? [];
      for (const a of cl.assumesOf(def.id)) {
        const site = t.node(a.node).span;
        const name = t.qualifiedName(a.claim);
        if (cl.tiers.get(a.claim) === 'derived') this.report('E0205', site, `\`${name}\` is a derived claim; it holds or fails by its predicate and cannot be assumed`);
        else if (!declared.includes(a.claim)) this.report('E0206', site, `\`${def.name}\` assumes \`${name}\` but does not declare \`claims ${t.def(a.claim).name}\``);
      }
      const effects = effectsOfFn(this.ctx, def.id);
      declared.forEach((c, i) => {
        const span = node.claims[i]?.span ?? node.name.span;
        if (cl.tiers.get(c) === 'derived') {
          if (!this.holds(c, effects, cl.carried.get(def.id) ?? new Set(), new Set())) {
            this.report('E0203', span, `\`${def.name}\` claims \`${t.def(c).name}\` but its effects { ${this.effectText(effects)} } do not satisfy the predicate`);
          }
        } else if (!cl.assumesOf(def.id).some((a) => a.claim === c)) {
          this.propagation(node, c);
        }
      });
    }
  }

  private effectText(effects: EffectSet): string {
    return effects
      .values()
      .map((e) => (e.k === 'param' ? this.ctx.resolve.def(e.def).name : e.name))
      .join(', ');
  }

  /** Whether `claim` holds for a function with `effects` that carries `carried`. */
  private holds(claim: DefId, effects: EffectSet, carried: ReadonlySet<DefId>, visiting: Set<DefId>): boolean {
    const t = this.ctx.resolve;
    const node = t.node(t.def(claim).node);
    if (node.kind !== 'ClaimDecl') return false;
    if (node.body.kind === 'Asserted') return carried.has(claim);
    if (visiting.has(claim)) return false;
    visiting.add(claim);
    try {
      return this.pred(node.body.pred, effects, carried, visiting);
    } finally {
      visiting.delete(claim);
    }
  }

  private pred(p: A.ClaimPred, effects: EffectSet, carried: ReadonlySet<DefId>, visiting: Set<DefId>): boolean {
    const t = this.ctx.resolve;
    switch (p.kind) {
      case 'ClaimAtom': {
        const res = t.refs.get(p.id);
        if (res !== undefined && res.k === 'effect') return effects.has(res.effect);
        if (res !== undefined && res.k === 'def') return this.holds(res.def, effects, carried, visiting);
        return false;
      }
      case 'ClaimEffectsEq': {
        const listed = p.effects.map((r) => t.refs.get(r.id)).flatMap((r) => (r !== undefined && r.k === 'effect' ? [r.effect] : []));
        return effects.equals(EffectSet.of(listed));
      }
      case 'ClaimNot':
        return !this.pred(p.operand, effects, carried, visiting);
      case 'ClaimAnd':
        return p.operands.every((o) => this.pred(o, effects, carried, visiting));
      case 'ClaimOr':
        return p.operands.some((o) => this.pred(o, effects, carried, visiting));
    }
  }

  /** §7.1: every participating callee of a function declaring asserted `claim` must carry it. */
  private propagation(f: A.FnDecl, claim: DefId): void {
    if (f.body === null) return; // an intrinsic's claims are trusted, like its contracts (§3.12)
    const t = this.ctx.resolve;
    const name = t.def(claim).name;
    walk(f.body, (n) => {
      if (n.kind !== 'Call') return true;
      const callee = calleeOf(this.ctx, n);
      switch (callee.k) {
        case 'ctor':
          return true;
        case 'fn':
        case 'impl':
          if (observable(calleeEffects(this.ctx, n, callee.def)) && !this.ctx.claims.carries(callee.def, claim)) {
            this.report('E0204', n.span, `\`${t.qualifiedName(callee.def)}\` has observable effects but does not claim \`${name}\`; \`${f.name.text}\` must not claim it without an \`assume\``);
          }
          return true;
        case 'dispatch':
          if (observable(calleeEffects(this.ctx, n, callee.fn))) {
            this.report('E0204', n.span, `\`${t.def(callee.fn).name}\` is dispatched on a type parameter, so it cannot be shown to claim \`${name}\``);
          }
          return true;
        case 'value':
          if (observable(valueEffects(callee.type))) {
            this.report('E0204', n.span, `a call through a function value cannot be shown to claim \`${name}\``);
          }
          return true;
      }
    });
  }
}
