/**
 * Polymorphic recursion (spec §3.6; docs/CHANGES.md item 171): a generic
 * function calling itself, directly or through other generic functions, at
 * an instantiation that places one of its own type parameters inside a type
 * constructor. The set of instantiations such a program needs is unbounded,
 * which a target that specialises generic code (impl spec §6.1) cannot
 * compile, so it is an error on every target.
 *
 * Over the instantiation graph — a node per (generic function, type
 * parameter); for a call in `f` to a generic `g` passing `t` for `g`'s
 * parameter `Q`, an edge from `(f, P)` to `(g, Q)` for each type parameter
 * `P` of `f` occurring in `t`, expansive when `t` is not `P` itself — an
 * expansive edge whose target reaches its source lies on a cycle and is
 * E0345, reported once per call, in definition order.
 */
import type { Context } from '../context.js';
import type { DefId } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { walk } from '../syntax/walk.js';
import { diagnostic } from '../report/diagnostic.js';
import { typeToString, type Type, type TypeArg } from './type.js';

interface Expansive {
  readonly from: string;
  readonly to: string;
  readonly call: A.Call;
  readonly caller: DefId;
  readonly callee: DefId;
  readonly arg: Type;
  readonly param: DefId;
}

/**
 * Reports E0345 for every polymorphically recursive call.
 * Preconditions: every module's items are checked, so every call to a generic function has its instantiation recorded.
 * Effects: reports E0345.
 */
export function checkPolymorphicRecursion(ctx: Context): void {
  const t = ctx.resolve;
  const ty = ctx.types;
  const typeParamsOf = (def: DefId): DefId[] => (ty.typeParams.get(def) ?? []).flatMap((p) => (p.k === 'type' ? [p.def] : []));
  const adjacency = new Map<string, string[]>();
  const expansive: Expansive[] = [];
  const addEdge = (from: string, to: string): void => {
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  };
  for (const f of t.defs) {
    if (f.kind !== 'fn') continue;
    const params = typeParamsOf(f.id);
    if (params.length === 0) continue;
    const node = t.node(f.node);
    if (node.kind !== 'FnDecl' || node.body === null) continue;
    walk(node.body, (n) => {
      if (n.kind !== 'Call') return true;
      const r = t.refs.get(n.callee.id);
      if (r === undefined || r.k !== 'def') return true;
      const g = r.def;
      const inst = ty.instantiations.get(n.id);
      if (inst === undefined) return true;
      (ty.typeParams.get(g) ?? []).forEach((q, i) => {
        const a = inst[i];
        if (q.k !== 'type' || a === undefined || a.k !== 'type') return;
        for (const p of params) {
          if (!occurs(a.type, p)) continue;
          const from = `${f.id}:${p}`;
          const to = `${g}:${q.def}`;
          addEdge(from, to);
          if (!(a.type.k === 'param' && a.type.def === p)) expansive.push({ from, to, call: n, caller: f.id, callee: g, arg: a.type, param: p });
        }
      });
      return true;
    });
  }
  const reported = new Set<A.NodeId>();
  for (const e of expansive) {
    if (reported.has(e.call.id) || !reaches(adjacency, e.to, e.from)) continue;
    reported.add(e.call.id);
    const caller = t.def(e.caller).name;
    ctx.sink.report(
      diagnostic({
        code: 'E0345',
        span: e.call.span,
        def: caller,
        context: [`\`${caller}\` calls \`${t.def(e.callee).name}\` at \`${typeToString(e.arg, t)}\`, which wraps its type parameter \`${t.def(e.param).name}\`, on a cycle back to itself: polymorphic recursion needs an unbounded set of instantiations (§3.6)`],
      }),
    );
  }
}

/** Whether the type parameter `p` occurs in `t`. Effects: none. */
function occurs(t: Type, p: DefId): boolean {
  switch (t.k) {
    case 'param':
      return t.def === p;
    case 'refined':
      return occurs(t.base, p);
    case 'record':
    case 'union':
    case 'opaque':
    case 'capability':
      return t.args.some((a) => occursArg(a, p));
    case 'fn':
      return t.params.some((x) => occurs(x.type, p)) || occurs(t.ret, p);
    case 'prim':
    case 'typeinfo':
    case 'spec':
    case 'error':
      return false;
  }
}

function occursArg(a: TypeArg, p: DefId): boolean {
  return a.k === 'type' && occurs(a.type, p);
}

/** Whether `target` is reachable from `start` over the edges (trivially when they are the same node). Effects: none. */
function reaches(adjacency: ReadonlyMap<string, readonly string[]>, start: string, target: string): boolean {
  if (start === target) return true;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (cur === undefined) break;
    for (const next of adjacency.get(cur) ?? []) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}
