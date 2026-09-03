/**
 * The capabilities pass (impl spec §4, pass 10; language spec §8, §8.3, §8.4).
 *
 * Typing of capabilities and attenuation lives in the types pass; this pass
 * checks the structural rules:
 *   - E0600: a module that is not a `test module` imports one;
 *   - E0601: a record field of capability type (capabilities are threaded, never stored);
 *   - E0602: `main` receives a capability that is not a root (`std.io.*`), for
 *     which no source exists (§8.3).
 * `fake` outside a `test module` is a syntax error (E0012, §8.4); closure
 * capture of a capability is E0330 in the types pass.
 */
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Code } from '../report/codes.js';
import type { Span } from '../source.js';
import { stripRefinements, type Type } from '../types/type.js';

/**
 * Pass 10: capabilities.
 * Preconditions: the claims pass ran without diagnostics.
 * Effects: reports E0600–E0602.
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
      }
    }
  }
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
