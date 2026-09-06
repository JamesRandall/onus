/**
 * The capabilities pass (impl spec §4, pass 10; language spec §8, §8.3, §8.4).
 *
 * Typing of capabilities and attenuation lives in the types pass; this pass
 * checks the structural rules:
 *   - E0600: a module that is not a `test module` imports one;
 *   - E0601: a record field of capability type (capabilities are threaded, never stored);
 *   - E0604: `main` returns a type the runtime cannot report as an exit status (§8.3);
 *   - E0602: `main` receives a capability that is not a root (`std.io.*`), for
 *     which no source exists (§8.3).
 * `fake` outside a `test module` is a syntax error (E0012, §8.4); closure
 * capture of a capability is E0330 in the types pass.
 */
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Span } from '../source.js';
import { stripRefinements, typeToString, type Type } from '../types/type.js';
import type { ResolveTables } from '../resolve/defs.js';

/**
 * Pass 10: capabilities.
 * Preconditions: the claims pass ran without diagnostics.
 * Effects: reports E0600–E0602 and E0604.
 */
export function capabilitiesPass(ctx: Context): void {
  const t = ctx.resolve;
  const ty = ctx.types;
  let currentDef: string | null = null;
  const report = (code: Code, span: Span, detail: string): void => {
    ctx.sink.report(diagnostic({ code, span, def: currentDef, context: [detail] }));
  };
  for (const m of t.modules) {
    currentDef = null;
    if (!m.module.test) {
      for (const imp of m.imports) {
        const target = t.moduleOf(imp.module);
        if (target.module.test) report('E0600', t.node(imp.node).span, `\`${m.name}\` is not a test module but imports test module \`${target.name}\` (§8.4)`);
      }
    }
    for (const item of m.module.items) {
      currentDef = 'name' in item ? item.name.text : null;
      if (item.kind === 'RecordDecl') {
        const def = t.defOf.get(item.id);
        for (const f of def === undefined ? [] : (ty.fields.get(def) ?? [])) {
          if (!mentionsCapability(f.type)) continue;
          report('E0601', t.def(f.def).span, `field \`${f.name}\` of \`${item.name.text}\` holds a capability; capabilities are threaded through signatures, never stored (§8)`);
        }
      }
      if (item.kind === 'FnDecl' && item.name.text === 'main' && item.vis.pub) {
        const def = t.defOf.get(item.id);
        const sig = def === undefined ? undefined : ty.signatures.get(def);
        sig?.params.forEach((p, i) => {
          const s = stripRefinements(p.type);
          if (s.k !== 'capability' || t.qualifiedName(s.def).startsWith('std.io.')) return;
          report('E0602', item.params[i]?.span ?? item.name.span, `\`main\` receives \`${p.name}\` of capability type \`${t.qualifiedName(s.def)}\`, but the runtime supplies only root capabilities (\`io.Files\`, \`io.Env\`, \`io.Net\`, \`io.Clock\`; §8.3)`);
        });
        // The runtime reports `Ok(Unit)` as status 0 and `Ok(n)` as status n; nothing else is an exit status (§8.3).
        if (sig !== undefined && mainStatus(t, sig.ret) === null) report('E0604', item.ret.span, `\`main\` returns \`${typeToString(sig.ret, t)}\`; the runtime reports a \`Result[Unit, E]\` as status 0 or a \`Result[Int, E]\` as the status (§8.3)`);
      }
    }
  }
}

/**
 * How a `main` returning `ret` reports its status: false for `Result[Unit, E]` (always 0), true for
 * `Result[Int, E]` (the `Ok` value), null for a type the runtime cannot report (§8.3). Effects: none.
 */
export function mainStatus(t: ResolveTables, ret: Type): boolean | null {
  const s = stripRefinements(ret);
  const results = t.byName.get('std.results');
  const resultDef = results === undefined ? null : (t.membersOf(results).types.get('Result') ?? null);
  const a0 = s.k === 'union' ? s.args[0] : undefined;
  if (s.k !== 'union' || s.def !== resultDef || a0 === undefined || a0.k !== 'type') return null;
  const payload = stripRefinements(a0.type);
  if (payload.k !== 'prim') return null;
  if (payload.name === 'Unit') return false;
  if (payload.name === 'Int') return true;
  return null;
}

/** True iff a value of `t` contains a capability. Effects: none. */
export function mentionsCapability(t: Type): boolean {
  switch (t.k) {
    case 'capability':
      return true;
    case 'refined':
      return mentionsCapability(t.base);
    case 'record':
    case 'union':
    case 'opaque':
      return t.args.some((a) => a.k === 'type' && mentionsCapability(a.type));
    case 'fn':
      return t.params.some((p) => mentionsCapability(p.type)) || mentionsCapability(t.ret);
    default:
      return false;
  }
}
