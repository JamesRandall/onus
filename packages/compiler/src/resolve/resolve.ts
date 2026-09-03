/**
 * Name resolution (impl spec §4, pass 3, second half).
 *
 * Builds the definition table for every loaded module, then binds every
 * use site to what it denotes. Rules (language spec §3.10, §11, and
 * docs/CHANGES.md):
 *
 *   - a bare value name resolves through local scopes, then the module's
 *     functions and constants;
 *   - a dotted name whose head is an imported module alias denotes that
 *     module's public member, even if a local has the same name (§18.3
 *     passes `auth: auth.Service`);
 *   - `Type.f` denotes function `f` of the module that declares `Type`; for
 *     a primitive that module is `std.<name>`;
 *   - a bare variant resolves in this module's unions, then the prelude's,
 *     then the imports'; more than one candidate is ambiguous;
 *   - a type name resolves through type parameters, this module's types, the
 *     prelude's public types, then the primitives;
 *   - locals may not shadow another local or parameter;
 *   - `sealed` types are constructed only in their module (or a test module);
 *   - `it` is legal only in a `where` clause, `result` and `old` only in
 *     `ensures`; `old` takes an `inout` parameter;
 *   - a closure may not refer to a `var` or an `inout` parameter of an
 *     enclosing frame.
 */
import type { Context } from '../context.js';
import { isPrimEffect, type Effect } from '../effects/set.js';
import { diagnostic } from '../report/diagnostic.js';
import type { Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import {
  companionModuleOf,
  defId,
  isPrimName,
  type Def,
  type DefId,
  type DefKind,
  type ModuleId,
  type ModuleRecord,
  type Resolution,
  type TypeOwner,
} from './defs.js';

type ResolveCode = 'E0105' | 'E0106' | 'E0107' | 'E0108' | 'E0109' | 'E0110' | 'E0111' | 'E0113' | 'E0114' | 'E0202' | 'E0330';

interface Scope {
  readonly parent: Scope | null;
  readonly values: Map<string, DefId>;
  readonly types: Map<string, TypeOwner>;
  readonly effects: Map<string, DefId>;
  readonly frame: number;
}

interface Flags {
  readonly inWhere: boolean;
  readonly inEnsures: boolean;
  readonly inoutParams: ReadonlySet<string>;
}

const NO_FLAGS: Flags = { inWhere: false, inEnsures: false, inoutParams: new Set() };

/**
 * Pass 3b: resolve every module in `ctx.resolve.modules`.
 * Preconditions: `loadPass` has run.
 * Effects: writes `ctx.resolve.defs`, `defOf`, `refs`, `members`; reports E0105–E0114 and E0330.
 */
export function resolvePass(ctx: Context): void {
  const collector = new Collector(ctx);
  for (const m of ctx.resolve.modules) collector.collect(m);
  for (const m of ctx.resolve.modules) new ModuleResolver(ctx, m).run();
}

// ---------------------------------------------------------------------------
// Definition collection
// ---------------------------------------------------------------------------

class Collector {
  constructor(private readonly ctx: Context) {}

  private add(m: ModuleRecord, kind: DefKind, name: A.Ident, node: A.NodeBase, opts: { pub?: boolean; sealed?: boolean; intrinsic?: boolean; parent?: DefId | null } = {}): DefId {
    const t = this.ctx.resolve;
    const id = defId(t.defs.length);
    const def: Def = {
      id,
      kind,
      name: name.text,
      module: m.id,
      node: node.id,
      span: name.span,
      pub: opts.pub ?? false,
      sealed: opts.sealed ?? false,
      intrinsic: opts.intrinsic ?? false,
      parent: opts.parent ?? null,
      frame: -1,
      inout: false,
    };
    t.defs.push(def);
    t.defOf.set(node.id, id);
    return id;
  }

  private declare(map: Map<string, DefId>, id: DefId, what: string): void {
    const t = this.ctx.resolve;
    const d = t.def(id);
    const prev = map.get(d.name);
    if (prev !== undefined) {
      this.ctx.sink.report(
        diagnostic({ code: 'E0107', span: d.span, def: d.name, context: [`${what} \`${d.name}\` is already defined in this module`] }),
      );
      return;
    }
    map.set(d.name, id);
  }

  collect(m: ModuleRecord): void {
    const t = this.ctx.resolve;
    const members = t.membersOf(m.id);
    for (const item of m.module.items) {
      switch (item.kind) {
        case 'FnDecl': {
          const id = this.add(m, 'fn', item.name, item, { pub: item.vis.pub, sealed: item.vis.sealed, intrinsic: item.intrinsic });
          this.declare(members.values, id, 'function');
          break;
        }
        case 'ConstDecl': {
          const id = this.add(m, 'const', item.name, item, { pub: item.vis.pub });
          this.declare(members.values, id, 'constant');
          break;
        }
        case 'TypeAlias': {
          const id = this.add(m, 'alias', item.name, item, { pub: item.vis.pub, sealed: item.vis.sealed });
          this.declareType(members.types, id);
          break;
        }
        case 'IntrinsicType': {
          const id = this.add(m, 'intrinsic-type', item.name, item, { pub: item.vis.pub, intrinsic: true });
          this.declareType(members.types, id);
          break;
        }
        case 'RecordDecl': {
          const id = this.add(m, 'record', item.name, item, { pub: item.vis.pub, sealed: item.vis.sealed });
          this.declareType(members.types, id);
          const seen = new Set<string>();
          for (const f of item.fields) {
            if (seen.has(f.name.text)) this.ctx.sink.report(diagnostic({ code: 'E0107', span: f.name.span, def: item.name.text, context: [`field \`${f.name.text}\` is declared twice`] }));
            seen.add(f.name.text);
            this.add(m, 'field', f.name, f, { pub: item.vis.pub, parent: id });
          }
          break;
        }
        case 'UnionDecl': {
          const id = this.add(m, 'union', item.name, item, { pub: item.vis.pub, sealed: item.vis.sealed });
          this.declareType(members.types, id);
          for (const v of item.variants) {
            const vid = this.add(m, 'variant', v.name, v, { pub: item.vis.pub, sealed: item.vis.sealed, parent: id });
            this.declare(members.variants, vid, 'variant');
            const seen = new Set<string>();
            for (const f of v.fields) {
              if (seen.has(f.name.text)) this.ctx.sink.report(diagnostic({ code: 'E0107', span: f.name.span, def: item.name.text, context: [`field \`${f.name.text}\` is declared twice`] }));
              seen.add(f.name.text);
              this.add(m, 'field', f.name, f, { pub: item.vis.pub, parent: vid });
            }
          }
          break;
        }
        case 'InterfaceDecl': {
          const id = this.add(m, 'interface', item.name, item, { pub: item.vis.pub });
          this.declare(members.interfaces, id, 'interface');
          const seen = new Set<string>();
          for (const it of item.items) {
            if (seen.has(it.name.text)) this.ctx.sink.report(diagnostic({ code: 'E0107', span: it.name.span, def: item.name.text, context: [`\`${it.name.text}\` is declared twice in this interface`] }));
            seen.add(it.name.text);
            this.add(m, it.kind === 'IfaceFn' ? 'iface-fn' : 'law', it.name, it, { pub: item.vis.pub, parent: id });
          }
          break;
        }
        case 'ImplDecl': {
          const id = this.add(m, 'impl', item.iface, item);
          const seen = new Set<string>();
          for (const f of item.fns) {
            if (seen.has(f.name.text)) this.ctx.sink.report(diagnostic({ code: 'E0107', span: f.name.span, def: item.iface.text, context: [`\`${f.name.text}\` is declared twice in this impl`] }));
            seen.add(f.name.text);
            this.add(m, 'fn', f.name, f, { pub: true, parent: id, intrinsic: f.intrinsic });
          }
          break;
        }
        case 'ClaimDecl': {
          const id = this.add(m, 'claim', item.name, item, { pub: item.vis.pub });
          this.declare(members.claims, id, 'claim');
          break;
        }
        case 'CapabilityDecl': {
          const id = this.add(m, 'capability', item.name, item, { pub: item.vis.pub });
          this.declareType(members.types, id);
          const own = m.name.split('.').pop() ?? m.name;
          for (const g of item.grants) {
            const name = g.effect.name.segments.map((s) => s.text).join('.');
            if (isPrimEffect(name)) continue;
            const segs = g.effect.name.segments;
            if (segs.length !== 2 || segs[0]?.text !== own) {
              this.ctx.sink.report(
                diagnostic({ code: 'E0202', span: g.effect.span, def: item.name.text, context: [`a capability in module \`${m.name}\` may grant a primitive effect or a resource effect named \`${own}.<name>\``] }),
              );
              continue;
            }
            let set = t.granted.get(m.id);
            if (set === undefined) {
              set = new Set();
              t.granted.set(m.id, set);
            }
            set.add(name);
          }
          break;
        }
        case 'PathDecl':
          this.declare(members.paths, this.add(m, 'path', item.name, item), 'path');
          break;
        case 'PolicyDecl':
          this.declare(members.policies, this.add(m, 'policy', item.name, item), 'policy');
          break;
        case 'ExampleDecl':
          this.declare(members.tests, this.add(m, 'example', item.name, item), 'example');
          break;
        case 'PropertyDecl':
          this.declare(members.tests, this.add(m, 'property', item.name, item), 'property');
          break;
      }
    }
  }

  private declareType(map: Map<string, DefId>, id: DefId): void {
    const d = this.ctx.resolve.def(id);
    if (isPrimName(d.name)) {
      this.ctx.sink.report(diagnostic({ code: 'E0107', span: d.span, def: d.name, context: [`\`${d.name}\` is a primitive type`] }));
      return;
    }
    this.declare(map, id, 'type');
  }
}

// ---------------------------------------------------------------------------
// Per-module resolution
// ---------------------------------------------------------------------------

class ModuleResolver {
  private readonly t;
  private readonly moduleScope: Scope;
  private currentDef: string | null = null;
  private flags: Flags = NO_FLAGS;
  private readonly aliases = new Map<string, ModuleId>();

  constructor(
    private readonly ctx: Context,
    private readonly m: ModuleRecord,
  ) {
    this.t = ctx.resolve;
    this.moduleScope = { parent: null, values: new Map(), types: new Map(), effects: new Map(), frame: -1 };
    this.buildModuleScope();
  }

  // -- diagnostics ---------------------------------------------------------

  private report(code: ResolveCode, span: Span, detail: string): void {
    this.ctx.sink.report(diagnostic({ code, span, def: this.currentDef, context: [detail] }));
  }

  // -- scopes --------------------------------------------------------------

  private buildModuleScope(): void {
    const s = this.moduleScope;
    // Prelude types and variants have the lowest priority; this module's override them.
    for (const pre of this.m.implicit) {
      const mem = this.t.membersOf(pre);
      for (const [name, id] of mem.types) if (this.t.def(id).pub) s.types.set(name, { k: 'def', def: id });
      for (const [name, id] of mem.interfaces) if (this.t.def(id).pub) s.types.set(name, { k: 'def', def: id });
    }
    const mem = this.t.membersOf(this.m.id);
    for (const [name, id] of mem.types) s.types.set(name, { k: 'def', def: id });
    for (const [name, id] of mem.interfaces) s.types.set(name, { k: 'def', def: id });
    for (const [name, id] of mem.values) {
      const k = this.t.def(id).kind;
      if (k === 'fn' || k === 'const') s.values.set(name, id);
    }
    for (const imp of this.m.imports) {
      if (this.aliases.has(imp.alias)) {
        const node = this.m.module.imports.find((i) => i.id === imp.node);
        this.report('E0107', node?.span ?? this.m.module.name.span, `two imports end in \`${imp.alias}\`; the alias must be unique`);
        continue;
      }
      this.aliases.set(imp.alias, imp.module);
    }
  }

  private child(parent: Scope, frame = parent.frame): Scope {
    return { parent, values: new Map(), types: new Map(), effects: new Map(), frame };
  }

  private lookupValue(scope: Scope, name: string): DefId | null {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const d = s.values.get(name);
      if (d !== undefined) return d;
    }
    return null;
  }

  private lookupType(scope: Scope, name: string): TypeOwner | null {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const d = s.types.get(name);
      if (d !== undefined) return d;
    }
    return isPrimName(name) ? { k: 'prim', name } : null;
  }

  private lookupEffectParam(scope: Scope, name: string): DefId | null {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      const d = s.effects.get(name);
      if (d !== undefined) return d;
    }
    return null;
  }

  /**
   * Resolves an effect list: a primitive effect, an effect parameter in
   * scope, or a resource effect `a.b` granted by a capability of the module
   * aliased `a` (or of this module, when its name ends in `a`). `allowRecover`
   * admits `recover` in a path's `forbid` clause (§10.2).
   */
  private effects(refs: readonly A.EffectRef[], scope: Scope, allowRecover = false): void {
    for (const e of refs) {
      const effect = this.effectOf(e, scope, allowRecover);
      if (effect !== null) this.t.refs.set(e.id, { k: 'effect', effect });
    }
  }

  private effectOf(e: A.EffectRef, scope: Scope, allowRecover: boolean): Effect | null {
    const name = e.name.segments.map((s) => s.text).join('.');
    if (isPrimEffect(name)) return { k: 'prim', name };
    const segs = e.name.segments;
    const head = segs[0];
    if (head === undefined) return null;
    if (segs.length === 1) {
      if (name === 'recover' && allowRecover) return null;
      const d = this.lookupEffectParam(scope, head.text);
      if (d !== null) return { k: 'param', def: d };
      this.report('E0202', e.span, `\`${name}\` is neither a primitive effect nor an effect parameter in scope`);
      return null;
    }
    if (segs.length === 2) {
      const own = this.m.name.split('.').pop();
      const mod = head.text === own ? this.m.id : this.aliases.get(head.text);
      if (mod !== undefined && this.t.granted.get(mod)?.has(name)) return { k: 'resource', module: mod, name };
      if (mod === undefined) this.report('E0202', e.span, `\`${head.text}\` is not an imported module alias, so \`${name}\` names no effect`);
      else this.report('E0202', e.span, `no capability of module \`${this.t.moduleOf(mod).name}\` grants \`${name}\``);
      return null;
    }
    this.report('E0202', e.span, `\`${name}\` is not an effect`);
    return null;
  }

  /** Bare variant lookup: this module, then the prelude, then imports. Null when unknown; reports E0108 when ambiguous. */
  private lookupVariant(name: string, at: Span): DefId | null {
    const own = this.t.membersOf(this.m.id).variants.get(name);
    if (own !== undefined) return own;
    const found: DefId[] = [];
    for (const pre of this.m.implicit) {
      const v = this.t.membersOf(pre).variants.get(name);
      if (v !== undefined && this.t.def(v).pub) found.push(v);
    }
    if (found.length === 1) return found[0] ?? null;
    for (const imp of this.m.imports) {
      const v = this.t.membersOf(imp.module).variants.get(name);
      if (v !== undefined && this.t.def(v).pub) found.push(v);
    }
    if (found.length === 0) return null;
    if (found.length > 1) {
      this.report('E0108', at, `\`${name}\` is a variant of ${found.map((v) => this.t.qualifiedName(this.t.def(v).parent ?? v)).join(' and ')}; qualify it with the module alias`);
    }
    return found[0] ?? null;
  }

  /**
   * Adds a local value binding, rejecting shadowing of another local or
   * parameter. Module-level functions and constants may be shadowed: a
   * parameter is a label callers read (`select(..., statement: stmt)` next to
   * `sql.statement`).
   */
  private bindValue(scope: Scope, kind: DefKind, name: A.Ident, node: A.NodeBase, inout = false): DefId {
    const existing = this.lookupValue(scope, name.text);
    if (existing !== null && this.t.def(existing).frame >= 0) {
      const prev = this.t.def(existing);
      this.report('E0113', name.span, `\`${name.text}\` is already bound (${prev.kind} at ${this.where(prev.span)}); choose another name`);
    }
    const id = defId(this.t.defs.length);
    const def: Def = {
      id,
      kind,
      name: name.text,
      module: this.m.id,
      node: node.id,
      span: name.span,
      pub: false,
      sealed: false,
      intrinsic: false,
      parent: null,
      frame: scope.frame,
      inout,
    };
    this.t.defs.push(def);
    this.t.defOf.set(node.id, id);
    scope.values.set(name.text, id);
    return id;
  }

  private where(span: Span): string {
    const f = this.ctx.fileOf(span);
    let line = 1;
    for (let i = 0; i < span.start && i < f.text.length; i++) if (f.text.charCodeAt(i) === 10) line += 1;
    return `line ${line}`;
  }

  private visible(def: Def, at: Span, what: string): boolean {
    if (def.pub || def.module === this.m.id) return true;
    this.report('E0110', at, `${what} \`${this.t.qualifiedName(def.id)}\` is private to module \`${this.t.moduleOf(def.module).name}\``);
    return false;
  }

  private checkSealed(def: Def, at: Span): void {
    const owner = def.kind === 'variant' && def.parent !== null ? this.t.def(def.parent) : def;
    if (owner.sealed && owner.module !== this.m.id && !this.m.module.test) {
      this.report('E0111', at, `\`${this.t.qualifiedName(owner.id)}\` is sealed; only module \`${this.t.moduleOf(owner.module).name}\` may construct it`);
    }
  }

  // -- entry ---------------------------------------------------------------

  run(): void {
    for (const item of this.m.module.items) {
      this.currentDef = 'name' in item ? item.name.text : item.iface.text;
      this.item(item);
      this.currentDef = null;
    }
  }

  private withFlags<T>(flags: Partial<Flags>, f: () => T): T {
    const saved = this.flags;
    this.flags = { ...saved, ...flags };
    try {
      return f();
    } finally {
      this.flags = saved;
    }
  }

  // -- items ---------------------------------------------------------------

  private item(item: A.Item): void {
    switch (item.kind) {
      case 'FnDecl':
        this.fnDecl(item, this.moduleScope);
        break;
      case 'TypeAlias':
        this.type(item.type, this.moduleScope);
        break;
      case 'IntrinsicType':
        this.tparams(item.tparams, this.child(this.moduleScope));
        break;
      case 'ConstDecl':
        this.type(item.type, this.moduleScope);
        this.expr(item.value, this.moduleScope);
        break;
      case 'RecordDecl': {
        const scope = this.child(this.moduleScope);
        this.tparams(item.tparams, scope);
        this.fields(item.fields, scope);
        break;
      }
      case 'UnionDecl': {
        const scope = this.child(this.moduleScope);
        this.tparams(item.tparams, scope);
        for (const v of item.variants) this.fields(v.fields, this.child(scope));
        break;
      }
      case 'InterfaceDecl':
        this.interfaceDecl(item);
        break;
      case 'ImplDecl':
        this.implDecl(item);
        break;
      case 'ClaimDecl':
        if (item.body.kind === 'Derived') this.claimPred(item.body.pred);
        break;
      case 'CapabilityDecl': {
        const scope = this.child(this.moduleScope);
        this.tparams(item.tparams, scope);
        // Grant names were validated when the definitions were collected.
        for (const g of item.grants) if (g.when) this.expr(g.when, scope);
        break;
      }
      case 'PathDecl':
        this.pathDecl(item);
        break;
      case 'PolicyDecl':
        break;
      case 'ExampleDecl':
        this.block(item.body, this.child(this.moduleScope, 0));
        break;
      case 'PropertyDecl': {
        const scope = this.child(this.moduleScope, 0);
        this.params(item.params, scope, true);
        this.block(item.body, this.child(scope));
        break;
      }
    }
  }

  private fnDecl(f: A.FnDecl, outer: Scope): void {
    const scope = this.child(outer, 0);
    this.tparams(f.tparams, scope);
    const inout = new Set<string>();
    for (const p of f.params) if (p.inout) inout.add(p.name.text);
    this.params(f.params, scope, true);
    this.effects(f.effects, scope);
    this.withFlags({ inoutParams: inout }, () => {
      this.type(f.ret, scope);
      for (const c of f.contracts) {
        this.withFlags({ inEnsures: c.clause === 'ensures' }, () => this.expr(c.expr, scope));
      }
      for (const cl of f.claims) this.claimRef(cl);
      if (f.body) this.block(f.body, this.child(scope));
    });
  }

  private fields(fields: readonly A.Field[], scope: Scope): void {
    // A field's refinement may reference earlier fields (§3.3).
    for (const f of fields) {
      this.type(f.type, scope);
      const id = this.t.defOf.get(f.id);
      if (id !== undefined) scope.values.set(f.name.text, id);
    }
  }

  private interfaceDecl(it: A.InterfaceDecl): void {
    const scope = this.child(this.moduleScope, 0);
    const tp = this.bindTypeParam(scope, it.tparam, it);
    void tp;
    for (const m of it.items) {
      const id = this.t.defOf.get(m.id);
      if (id !== undefined) scope.values.set(m.name.text, id);
    }
    for (const m of it.items) {
      this.currentDef = `${it.name.text}.${m.name.text}`;
      const inner = this.child(scope);
      if (m.kind === 'IfaceFn') {
        const inout = new Set<string>();
        for (const p of m.params) if (p.inout) inout.add(p.name.text);
        this.params(m.params, inner, true);
        this.effects(m.effects, inner);
        this.withFlags({ inoutParams: inout }, () => {
          this.type(m.ret, inner);
          for (const c of m.contracts) this.withFlags({ inEnsures: c.clause === 'ensures' }, () => this.expr(c.expr, inner));
        });
      } else {
        this.params(m.params, inner, true);
        this.block(m.body, this.child(inner));
      }
    }
  }

  private implDecl(it: A.ImplDecl): void {
    const iface = this.lookupType(this.moduleScope, it.iface.text);
    if (iface === null || iface.k !== 'def' || this.t.def(iface.def).kind !== 'interface') {
      this.report('E0106', it.iface.span, `\`${it.iface.text}\` is not an interface in scope`);
    } else {
      this.t.refs.set(it.id, { k: 'def', def: iface.def });
    }
    this.type(it.target, this.moduleScope);
    const scope = this.child(this.moduleScope, 0);
    for (const f of it.fns) {
      const id = this.t.defOf.get(f.id);
      if (id !== undefined) scope.values.set(f.name.text, id);
    }
    for (const f of it.fns) {
      this.currentDef = `${it.iface.text}.${f.name.text}`;
      this.fnDecl(f, scope);
    }
  }

  private pathDecl(p: A.PathDecl): void {
    const entry = this.t.membersOf(this.m.id).values.get(p.entry.text);
    if (entry === undefined || this.t.def(entry).kind !== 'fn') this.report('E0105', p.entry.span, `no function \`${p.entry.text}\` in this module`);
    else this.t.refs.set(p.id, { k: 'def', def: entry });
    for (const c of p.clauses) {
      if (c.kind === 'PathEffects') this.effects(c.effects, this.moduleScope);
      if (c.kind === 'PathForbid') this.effects(c.effects, this.moduleScope, true);
      if (c.kind === 'PathRequire') for (const cl of c.claims) this.claimRef(cl);
      if (c.kind === 'PathPolicy') {
        const pol = this.t.membersOf(this.m.id).policies.get(c.name.text);
        if (pol === undefined || this.t.def(pol).kind !== 'policy') this.report('E0105', c.name.span, `no policy \`${c.name.text}\` in this module`);
        else this.t.refs.set(c.id, { k: 'def', def: pol });
      }
    }
  }

  private claimPred(p: A.ClaimPred): void {
    switch (p.kind) {
      case 'ClaimAtom':
        if (p.name.segments[p.name.segments.length - 1]?.text.match(/^[A-Z]/)) this.claimRef(p.name, p.id);
        else {
          const effect = this.effectOf({ id: p.id, kind: 'EffectRef', span: p.span, name: p.name }, this.moduleScope, false);
          if (effect !== null) this.t.refs.set(p.id, { k: 'effect', effect });
        }
        break;
      case 'ClaimEffectsEq':
        this.effects(p.effects, this.moduleScope);
        break;
      case 'ClaimNot':
        this.claimPred(p.operand);
        break;
      case 'ClaimAnd':
      case 'ClaimOr':
        for (const o of p.operands) this.claimPred(o);
        break;
    }
  }

  /** Resolves a claim name (`Idempotent` or `payments.Idempotent`). */
  private claimRef(q: A.QName, at?: A.NodeId): void {
    const last = q.segments[q.segments.length - 1];
    if (last === undefined) return;
    let found: DefId | undefined;
    if (q.segments.length === 1) {
      found = this.t.membersOf(this.m.id).claims.get(last.text);
      if (found === undefined) {
        for (const imp of this.m.imports) {
          const c = this.t.membersOf(imp.module).claims.get(last.text);
          if (c !== undefined && this.t.def(c).pub) found = c;
        }
      }
    } else {
      const mod = this.moduleOfPath(q.segments.slice(0, -1));
      if (mod === null) return;
      found = this.t.membersOf(mod).claims.get(last.text);
      if (found !== undefined && !this.visible(this.t.def(found), q.span, 'claim')) return;
    }
    if (found === undefined) {
      this.report('E0105', q.span, `unknown claim \`${q.segments.map((s) => s.text).join('.')}\``);
      return;
    }
    if (at !== undefined) this.t.refs.set(at, { k: 'def', def: found });
  }

  private moduleOfPath(segments: readonly A.Ident[]): ModuleId | null {
    const head = segments[0];
    if (head === undefined || segments.length !== 1) {
      const text = segments.map((s) => s.text).join('.');
      const byName = this.t.byName.get(text);
      if (byName !== undefined && (this.m.imports.some((i) => i.module === byName) || byName === this.m.id)) return byName;
      this.report('E0105', head?.span ?? this.m.module.span, `\`${text}\` is not an imported module`);
      return null;
    }
    const mod = this.aliases.get(head.text);
    if (mod === undefined) {
      this.report('E0105', head.span, `\`${head.text}\` is not an imported module alias`);
      return null;
    }
    return mod;
  }

  // -- signatures ----------------------------------------------------------

  private bindTypeParam(scope: Scope, name: A.Ident, node: A.NodeBase): DefId {
    const id = defId(this.t.defs.length);
    const def: Def = {
      id,
      kind: 'type-param',
      name: name.text,
      module: this.m.id,
      node: node.id,
      span: name.span,
      pub: false,
      sealed: false,
      intrinsic: false,
      parent: null,
      frame: scope.frame,
      inout: false,
    };
    this.t.defs.push(def);
    if (scope.types.has(name.text)) this.report('E0107', name.span, `type parameter \`${name.text}\` is declared twice`);
    scope.types.set(name.text, { k: 'def', def: id });
    return id;
  }

  private tparams(ps: readonly A.TParam[], scope: Scope): void {
    for (const p of ps) {
      switch (p.kind) {
        case 'TypeParam': {
          const id = this.bindTypeParam(scope, p.name, p);
          this.t.defOf.set(p.id, id);
          if (p.bound) {
            const b = this.lookupType(scope, p.bound.text);
            if (b === null || b.k !== 'def' || this.t.def(b.def).kind !== 'interface') this.report('E0106', p.bound.span, `\`${p.bound.text}\` is not an interface in scope`);
            else this.t.refs.set(p.id, { k: 'def', def: b.def });
          }
          break;
        }
        case 'ConstParam':
          this.type(p.type, scope);
          this.bindValue(scope, 'const-param', p.name, p);
          break;
        case 'EffectParam': {
          const id = defId(this.t.defs.length);
          this.t.defs.push({ id, kind: 'effect-param', name: p.name.text, module: this.m.id, node: p.id, span: p.name.span, pub: false, sealed: false, intrinsic: false, parent: null, frame: scope.frame, inout: false });
          this.t.defOf.set(p.id, id);
          if (scope.effects.has(p.name.text)) this.report('E0107', p.name.span, `effect parameter \`${p.name.text}\` is declared twice`);
          scope.effects.set(p.name.text, id);
          break;
        }
      }
    }
  }

  /**
   * Binds parameters as values when `bind` is true (function types only
   * resolve the types). A parameter's refinement may reference earlier
   * parameters, as a record field's may reference earlier fields (§3.3).
   */
  private params(ps: readonly A.Param[], scope: Scope, bind: boolean): void {
    const seen = new Set<string>();
    for (const p of ps) {
      this.type(p.type, scope);
      if (seen.has(p.name.text)) {
        this.report('E0107', p.name.span, `parameter \`${p.name.text}\` is declared twice`);
        continue;
      }
      seen.add(p.name.text);
      if (bind) this.bindValue(scope, 'param', p.name, p, p.inout);
    }
  }

  // -- types ---------------------------------------------------------------

  /**
   * Resolves a type. In argument position (`asArg`) an uppercase name that is
   * not a type may be a nullary variant used as a constant index
   * (`Db[ReadOnly]`); the type checker then reads it as a const argument.
   */
  private type(t: A.Type, scope: Scope, asArg = false): void {
    if (t.kind === 'FnType') {
      this.params(t.params, scope, false);
      this.type(t.ret, scope);
      this.effects(t.effects, scope);
      return;
    }
    const owner = this.typeName(t.name, scope, asArg && t.args.length === 0 && t.where === null);
    if (owner !== null) this.t.refs.set(t.id, owner.k === 'prim' ? { k: 'prim', name: owner.name } : { k: 'def', def: owner.def });
    for (const a of t.args) {
      if (a.kind === 'TypeArgType') this.type(a.type, scope, true);
      else this.expr(a.expr, scope);
    }
    if (t.where) this.withFlags({ inWhere: true }, () => this.expr(t.where as A.Expr, scope));
  }

  private typeName(q: A.QName, scope: Scope, allowVariant = false): TypeOwner | null {
    const last = q.segments[q.segments.length - 1];
    if (last === undefined) return null;
    if (q.segments.length === 1) {
      const found = this.lookupType(scope, last.text);
      if (found === null) {
        if (allowVariant) {
          const v = this.lookupVariant(last.text, last.span);
          if (v !== null) return { k: 'def', def: v };
        }
        this.report('E0106', last.span, `no type \`${last.text}\` in scope`);
        return null;
      }
      return found;
    }
    const mod = this.moduleOfPath(q.segments.slice(0, -1));
    if (mod === null) return null;
    const mem = this.t.membersOf(mod);
    const d = mem.types.get(last.text) ?? mem.interfaces.get(last.text) ?? (allowVariant ? mem.variants.get(last.text) : undefined);
    if (d === undefined) {
      this.report('E0106', last.span, `module \`${this.t.moduleOf(mod).name}\` has no type \`${last.text}\``);
      return null;
    }
    if (!this.visible(this.t.def(d), last.span, 'type')) return null;
    return { k: 'def', def: d };
  }

  // -- statements ----------------------------------------------------------

  private block(b: A.Block, scope: Scope): void {
    for (const s of b.stmts) this.stmt(s, scope);
  }

  private stmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case 'Let':
      case 'Var':
        this.type(s.type, scope);
        this.expr(s.value, scope);
        this.bindValue(scope, s.kind === 'Let' ? 'let' : 'var', s.name, s);
        break;
      case 'Assign': {
        const d = this.lookupValue(scope, s.name.text);
        if (d === null) this.report('E0105', s.name.span, `no binding \`${s.name.text}\` in scope`);
        else this.t.refs.set(s.id, { k: 'def', def: d });
        this.expr(s.value, scope);
        break;
      }
      case 'Return':
        this.expr(s.value, scope);
        break;
      case 'If':
        this.expr(s.cond, scope);
        this.block(s.then, this.child(scope));
        if (s.else) this.block(s.else, this.child(scope));
        break;
      case 'Match':
        this.expr(s.scrutinee, scope);
        for (const a of s.arms) {
          const armScope = this.child(scope);
          this.pattern(a.pattern, armScope);
          if (a.guard) this.expr(a.guard, armScope);
          if (a.body.kind === 'Block') this.block(a.body, this.child(armScope));
          else this.stmt(a.body, armScope);
        }
        break;
      case 'Loop':
        this.expr(s.cond, scope);
        for (const c of s.clauses) this.expr(c.expr, scope);
        this.block(s.body, this.child(scope));
        break;
      case 'For': {
        this.type(s.type, scope);
        this.domain(s.domain, scope);
        const inner = this.child(scope);
        this.bindValue(inner, 'for', s.name, s);
        this.block(s.body, this.child(inner));
        break;
      }
      case 'Assume':
        this.claimRef(s.claim, s.id);
        break;
      case 'ExprStmt':
        this.expr(s.expr, scope);
        break;
    }
  }

  private domain(d: A.Domain, scope: Scope): void {
    if (d.kind === 'RangeDomain') {
      this.expr(d.lo, scope);
      this.expr(d.hi, scope);
    } else {
      this.expr(d.expr, scope);
    }
  }

  // -- expressions ---------------------------------------------------------

  private expr(e: A.Expr, scope: Scope): void {
    switch (e.kind) {
      case 'IntLit':
      case 'FloatLit':
      case 'TextLit':
      case 'BoolLit':
      case 'DurationLit':
        return;
      case 'Name':
        this.nameRef(e, scope);
        return;
      case 'It':
        if (!this.flags.inWhere) this.report('E0114', e.span, '`it` names the refined value and is legal only in a `where` clause');
        return;
      case 'ResultRef':
        if (!this.flags.inEnsures) this.report('E0114', e.span, '`result` is legal only in an `ensures` clause');
        return;
      case 'Old': {
        if (!this.flags.inEnsures) this.report('E0114', e.span, '`old(...)` is legal only in an `ensures` clause');
        const d = this.lookupValue(scope, e.name.text);
        if (d === null) this.report('E0105', e.name.span, `no binding \`${e.name.text}\` in scope`);
        else if (!this.flags.inoutParams.has(e.name.text)) this.report('E0114', e.name.span, `\`old(${e.name.text})\` requires an \`inout\` parameter`);
        else this.t.refs.set(e.id, { k: 'def', def: d });
        return;
      }
      case 'Ctor':
        this.ctor(e, scope);
        return;
      case 'RecordUpdate':
        this.expr(e.base, scope);
        for (const f of e.fields) this.expr(f.value, scope);
        this.dupFields(e.fields);
        return;
      case 'ListLit':
        for (const x of e.elems) this.expr(x, scope);
        return;
      case 'Try':
        this.expr(e.expr, scope);
        if (e.else) {
          const inner = this.child(scope);
          this.bindValue(inner, 'try-else', e.else.name, e.else);
          this.expr(e.else.expr, inner);
        }
        return;
      case 'Recover':
        this.block(e.body, this.child(scope));
        return;
      case 'Quantifier': {
        this.type(e.type, scope);
        if (e.domain) this.domain(e.domain, scope);
        const inner = this.child(scope);
        this.bindValue(inner, 'binder', e.name, e);
        if (e.where) this.expr(e.where, inner);
        this.expr(e.body, inner);
        return;
      }
      case 'Closure': {
        const inner = this.child(scope, scope.frame + 1);
        this.params(e.params, inner, true);
        this.effects(e.effects, inner);
        this.withFlags({ inoutParams: new Set(), inEnsures: false, inWhere: false }, () => {
          this.type(e.ret, inner);
          this.block(e.body, this.child(inner));
        });
        return;
      }
      case 'Fake': {
        const owner = this.typeName(e.capability, scope);
        if (owner !== null && owner.k === 'def') this.t.refs.set(e.id, { k: 'def', def: owner.def });
        for (const f of e.fields) this.expr(f.value, scope);
        return;
      }
      case 'FieldAccess':
        this.fieldAccess(e, scope);
        return;
      case 'Call':
        this.expr(e.callee, scope);
        if (e.targs) {
          for (const a of e.targs) {
            if (a.kind === 'TypeArgType') this.type(a.type, scope);
            else this.expr(a.expr, scope);
          }
        }
        this.dupArgs(e.args);
        for (const a of e.args) this.expr(a.value, scope);
        return;
      case 'Unary':
        this.expr(e.operand, scope);
        return;
      case 'Binary':
        this.expr(e.left, scope);
        this.expr(e.right, scope);
        return;
      case 'And':
      case 'Or':
        for (const o of e.operands) this.expr(o, scope);
        return;
      case 'Is':
        this.expr(e.expr, scope);
        this.pattern(e.pattern, this.child(scope));
        return;
    }
  }

  private dupFields(fields: readonly A.FieldInit[]): void {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name.text)) this.report('E0107', f.name.span, `field \`${f.name.text}\` is given twice`);
      seen.add(f.name.text);
    }
  }

  private dupArgs(args: readonly A.Arg[]): void {
    const seen = new Set<string>();
    for (const a of args) {
      if (seen.has(a.name.text)) this.report('E0107', a.name.span, `argument \`${a.name.text}\` is given twice`);
      seen.add(a.name.text);
    }
  }

  private nameRef(e: A.Name, scope: Scope): void {
    const d = this.lookupValue(scope, e.name.text);
    if (d === null) {
      const hint = this.aliases.has(e.name.text) ? `; \`${e.name.text}\` is a module alias, not a value` : '';
      this.report('E0105', e.span, `no binding \`${e.name.text}\` in scope${hint}`);
      return;
    }
    const def = this.t.def(d);
    if (def.frame >= 0 && def.frame < scope.frame && (def.kind === 'var' || (def.kind === 'param' && def.inout))) {
      this.report('E0330', e.span, `\`${e.name.text}\` is ${def.kind === 'var' ? 'a var' : 'an inout parameter'} of an enclosing function; closures capture only let bindings and parameters by value`);
    }
    this.t.refs.set(e.id, { k: 'def', def: d });
  }

  /** `QTNAME [args] [{ fields }]` — a variant, record, `Unit`, or a type name used as a value. */
  private ctor(e: A.Ctor, scope: Scope): void {
    const res = this.ctorName(e.name, scope, e.args !== null, e.fields !== null);
    if (res !== null) {
      this.t.refs.set(e.id, res);
      if (res.k === 'def') this.checkSealed(this.t.def(res.def), e.name.span);
    }
    if (e.args) {
      this.dupArgs(e.args);
      for (const a of e.args) this.expr(a.value, scope);
    }
    if (e.fields) {
      this.dupFields(e.fields);
      for (const f of e.fields) this.expr(f.value, scope);
    }
  }

  private ctorName(q: A.QName, scope: Scope, hasArgs: boolean, hasFields: boolean): Resolution | null {
    const last = q.segments[q.segments.length - 1];
    if (last === undefined) return null;
    const wantRecord = hasFields;
    if (q.segments.length === 1) {
      const name = last.text;
      if (name === 'Unit' && this.lookupVariant(name, last.span) === null && !hasArgs && !hasFields) return { k: 'unit' };
      const variant = this.lookupVariant(name, last.span);
      if (variant !== null && !wantRecord) return { k: 'def', def: variant };
      const ty = this.lookupType(scope, name);
      if (ty !== null) {
        if (hasArgs || hasFields) {
          if (ty.k === 'def' && this.t.def(ty.def).kind === 'record') return { k: 'def', def: ty.def };
          this.report('E0105', last.span, `\`${name}\` is not a ${hasFields ? 'record' : 'variant'}`);
          return null;
        }
        return { k: 'type-value', type: ty };
      }
      if (variant !== null) return { k: 'def', def: variant };
      this.report('E0105', last.span, `no variant, record or type \`${name}\` in scope`);
      return null;
    }
    const mod = this.moduleOfPath(q.segments.slice(0, -1));
    if (mod === null) return null;
    const mem = this.t.membersOf(mod);
    const variant = mem.variants.get(last.text);
    if (variant !== undefined && !wantRecord) {
      if (!this.visible(this.t.def(variant), last.span, 'variant')) return null;
      return { k: 'def', def: variant };
    }
    const ty = mem.types.get(last.text) ?? mem.interfaces.get(last.text);
    if (ty !== undefined) {
      if (!this.visible(this.t.def(ty), last.span, 'type')) return null;
      if (hasArgs || hasFields) {
        if (this.t.def(ty).kind === 'record') return { k: 'def', def: ty };
        this.report('E0105', last.span, `\`${this.t.qualifiedName(ty)}\` is not a ${hasFields ? 'record' : 'variant'}`);
        return null;
      }
      return { k: 'type-value', type: { k: 'def', def: ty } };
    }
    this.report('E0109', last.span, `module \`${this.t.moduleOf(mod).name}\` has no variant or type \`${last.text}\``);
    return null;
  }

  /**
   * `a.b`: a module member (`io.create`), a companion function (`Grid.filled`,
   * `Float.of`), an interface function (`Ord.compare`), or a field access on
   * a value (left to the type checker).
   */
  private fieldAccess(e: A.FieldAccess, scope: Scope): void {
    const obj = e.object;
    if (obj.kind === 'Name') {
      const mod = this.aliases.get(obj.name.text);
      if (mod !== undefined) {
        this.t.refs.set(obj.id, { k: 'module', module: mod });
        const mem = this.t.membersOf(mod);
        const d = mem.values.get(e.name.text);
        if (d === undefined || (this.t.def(d).kind !== 'fn' && this.t.def(d).kind !== 'const')) {
          this.report('E0109', e.name.span, `module \`${this.t.moduleOf(mod).name}\` has no function or constant \`${e.name.text}\``);
          return;
        }
        if (!this.visible(this.t.def(d), e.name.span, 'function')) return;
        this.t.refs.set(e.id, { k: 'def', def: d });
        return;
      }
      this.expr(obj, scope);
      return;
    }
    if (obj.kind === 'Ctor' && obj.args === null && obj.fields === null) {
      const owner = this.ctorOwner(obj.name, scope);
      if (owner === null) {
        this.expr(obj, scope);
        return;
      }
      if (owner.k === 'def' && this.t.def(owner.def).kind === 'interface') {
        const fn = this.t.defs.find((d) => d.parent === owner.def && d.kind === 'iface-fn' && d.name === e.name.text);
        if (fn === undefined) {
          this.report('E0109', e.name.span, `interface \`${this.t.def(owner.def).name}\` has no function \`${e.name.text}\``);
          return;
        }
        this.t.refs.set(obj.id, { k: 'type-value', type: owner });
        this.t.refs.set(e.id, { k: 'iface-fn', iface: owner.def, fn: fn.id });
        return;
      }
      const fn = this.companion(owner, e.name);
      this.t.refs.set(obj.id, { k: 'type-value', type: owner });
      if (fn !== null) this.t.refs.set(e.id, { k: 'companion', owner, fn });
      return;
    }
    this.expr(obj, scope);
  }

  /** The type a bare or qualified type name denotes, without reporting; null if it is not a type. */
  private ctorOwner(q: A.QName, scope: Scope): TypeOwner | null {
    const last = q.segments[q.segments.length - 1];
    if (last === undefined) return null;
    if (q.segments.length === 1) {
      if (this.t.membersOf(this.m.id).variants.has(last.text)) return null;
      return this.lookupType(scope, last.text);
    }
    const head = q.segments[0];
    const mod = head !== undefined && q.segments.length === 2 ? this.aliases.get(head.text) : undefined;
    if (mod === undefined) return null;
    const mem = this.t.membersOf(mod);
    const d = mem.types.get(last.text) ?? mem.interfaces.get(last.text);
    return d !== undefined ? { k: 'def', def: d } : null;
  }

  /** Function `name` of the module that declares `owner`. */
  private companion(owner: TypeOwner, name: A.Ident): DefId | null {
    let mod: ModuleId | null;
    let typeName: string;
    if (owner.k === 'prim') {
      const modName = companionModuleOf(owner.name);
      mod = this.t.byName.get(modName) ?? null;
      typeName = owner.name;
      if (mod === null) {
        this.report('E0109', name.span, `the standard library module \`${modName}\` is not loaded, so \`${owner.name}.${name.text}\` cannot be resolved`);
        return null;
      }
    } else {
      mod = this.t.def(owner.def).module;
      typeName = this.t.def(owner.def).name;
    }
    const d = this.t.membersOf(mod).values.get(name.text);
    if (d === undefined || this.t.def(d).kind !== 'fn') {
      this.report('E0109', name.span, `\`${typeName}\` has no function \`${name.text}\` (module \`${this.t.moduleOf(mod).name}\`)`);
      return null;
    }
    if (!this.visible(this.t.def(d), name.span, 'function')) return null;
    return d;
  }

  // -- patterns ------------------------------------------------------------

  private pattern(p: A.Pattern, scope: Scope): void {
    switch (p.kind) {
      case 'WildcardPat':
      case 'LitPat':
        return;
      case 'BindPat':
        this.bindValue(scope, 'pattern', p.name, p);
        return;
      case 'VariantPat': {
        const res = this.ctorName(p.name, scope, true, false);
        if (res !== null) {
          if (res.k === 'def' && this.t.def(res.def).kind === 'variant') this.t.refs.set(p.id, res);
          else this.report('E0105', p.name.span, `\`${p.name.segments.map((s) => s.text).join('.')}\` is not a variant`);
        }
        if (p.fields) {
          for (const f of p.fields) if (f.kind === 'PatFieldName') this.bindValue(scope, 'pattern', f.name, f);
        }
        return;
      }
    }
  }
}
