/**
 * Interface documents (language spec §11, §11.1; impl spec §3.6, M7).
 *
 * The interface of a module is what a reviewer reads instead of bodies: for
 * every item its signature, effects, claims, contracts with their obligation
 * status, examples and properties with their results, every `assume` and
 * `recover`, and the obligation ledger. `interfaceOf` is the normative JSON;
 * `interfaceText` renders the module in canonical syntax with every function
 * body elided to `{ ... }` (the one printer, with an option).
 */
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import type { Effect } from '../effects/set.js';
import type { ModuleId, ModuleRecord } from '../resolve/defs.js';
import { lineColOf, type Span } from '../source.js';
import type * as A from '../syntax/ast.js';
import { print, printExpr, printItem, printSignature, printType } from '../syntax/printer.js';
import { walk } from '../syntax/walk.js';
import type { JsonSpan } from './diagnostic.js';
import { b3 } from './hash.js';
import { verifiedOf, type VerifiedJson } from './path.js';

export type ItemKind = 'fn' | 'type' | 'const' | 'record' | 'union' | 'interface' | 'impl' | 'claim' | 'capability' | 'path' | 'policy' | 'example' | 'property';
export type ItemVisibility = 'pub' | 'private';
/** The state of a contract or property, aggregated over its obligations (§12.2). */
export type ContractStatus = 'proved' | 'checked' | 'assumed' | 'failed';
export type ExampleStatus = 'passed' | 'failed' | 'deferred' | 'not run';

export interface Location {
  readonly file: string;
  readonly span: JsonSpan;
}

export interface ContractEntry {
  readonly kind: 'requires' | 'ensures' | 'decreases' | 'invariant';
  readonly text: string;
  readonly pinned: boolean;
  readonly status: ContractStatus;
  /** Obligations generated from the clause (call sites for `requires`, returns for `ensures`). */
  readonly sites: number;
  /** Location of the first runtime check, when `status` is `checked`. */
  readonly checked_at?: string;
}

export interface ExampleEntry {
  readonly name: string;
  readonly status: ExampleStatus;
  readonly at: Location;
}

export interface PropertyEntry {
  readonly name: string;
  readonly status: ContractStatus;
  readonly at: Location;
}

export interface AssumeEntry {
  readonly def: string;
  readonly claim: string;
  readonly justification: string;
  readonly at: Location;
  /** Whether a `verify` block exists (§20.3). */
  readonly verifiable: boolean;
  /** The last `onus test --assumptions` record, or null. */
  readonly last_verified: VerifiedJson | null;
}

export interface RecoverEntry {
  readonly def: string;
  readonly at: Location;
}

export interface ObligationCounts {
  readonly proved: number;
  readonly checked: number;
  readonly assumed: number;
  readonly failed: number;
}

export interface LedgerEntry {
  readonly kind: string;
  readonly text: string;
  readonly def: string;
  readonly status: string;
  readonly by: string | null;
  readonly pinned: boolean;
  readonly at: Location;
}

export interface InterfaceItem {
  readonly kind: ItemKind;
  readonly name: string;
  readonly visibility: ItemVisibility;
  /** Canonical source text: a function's signature line, or the whole declaration with bodies elided. */
  readonly signature: string;
  readonly effects: readonly string[];
  readonly claims: readonly string[];
  readonly contracts: readonly ContractEntry[];
  readonly examples: readonly ExampleEntry[];
  readonly properties: readonly PropertyEntry[];
  readonly assumes: readonly AssumeEntry[];
  readonly recovers: readonly RecoverEntry[];
  readonly obligations: ObligationCounts;
  /** Where the item is declared, so a reviewer's tool can show its source on request (§15.1). */
  readonly at: Location;
}

export interface InterfaceDocument {
  readonly module: string;
  /** `b3:` hash of the module's canonical text (§2.2). */
  readonly hash: string;
  readonly imports: readonly string[];
  readonly items: readonly InterfaceItem[];
  readonly assumes: readonly AssumeEntry[];
  readonly recovers: readonly RecoverEntry[];
  readonly sealed_types: readonly string[];
  readonly test_module: boolean;
  readonly obligations: ObligationCounts;
  /** Every obligation of the module with its status and provenance (§11, §12.2). */
  readonly ledger: readonly LedgerEntry[];
}

/**
 * The interface document of a loaded module.
 * Preconditions: the pipeline ran to `verify` (statuses are final) without diagnostics.
 * Effects: none.
 */
export function interfaceOf(ctx: Context, module: ModuleId): InterfaceDocument {
  return new InterfaceBuilder(ctx, ctx.resolve.moduleOf(module)).build();
}

/**
 * The module in canonical syntax with every function body elided to `{ ... }`
 * (§11.1). Postconditions: the result parses, and parses to the same text.
 * Effects: none.
 */
export function interfaceText(ctx: Context, module: ModuleId): string {
  const rec = ctx.resolve.moduleOf(module);
  return print(rec.module, rec.comments, { elideBodies: true });
}

class InterfaceBuilder {
  private readonly file;
  private readonly obligations: readonly Obligation[];

  constructor(
    private readonly ctx: Context,
    private readonly rec: ModuleRecord,
  ) {
    this.file = ctx.fileOf(rec.module.span);
    this.obligations = ctx.contracts.obligations.filter((o) => ctx.resolve.node(o.at).span.file === this.file.id);
  }

  build(): InterfaceDocument {
    const m = this.rec.module;
    const examples = m.items.filter((i): i is A.ExampleDecl => i.kind === 'ExampleDecl');
    const properties = m.items.filter((i): i is A.PropertyDecl => i.kind === 'PropertyDecl');
    const fnNames = new Set(m.items.filter((i) => i.kind === 'FnDecl').map((i) => (i.kind === 'FnDecl' ? i.name.text : '')));
    const items: InterfaceItem[] = [];
    for (const item of m.items) {
      // Examples and properties named after a function are reported under it (§18.1).
      if ((item.kind === 'ExampleDecl' || item.kind === 'PropertyDecl') && fnNames.has(item.name.text)) continue;
      items.push(this.item(item, examples, properties));
    }
    const assumes = items.flatMap((i) => i.assumes);
    const recovers = items.flatMap((i) => i.recovers);
    return {
      module: this.rec.name,
      hash: b3(this.ctx.canonical.get(this.file.id) ?? this.file.text),
      imports: this.rec.imports.map((i) => this.ctx.resolve.moduleOf(i.module).name),
      items,
      assumes,
      recovers,
      sealed_types: m.items.filter((i) => 'vis' in i && i.vis.sealed).map((i) => ('name' in i ? i.name.text : '')),
      test_module: m.test,
      obligations: counts(this.obligations),
      ledger: this.obligations.map((o) => this.ledgerEntry(o)),
    };
  }

  private item(item: A.Item, examples: readonly A.ExampleDecl[], properties: readonly A.PropertyDecl[]): InterfaceItem {
    const own = this.obligations.filter((o) => within(this.ctx.resolve.def(o.def).span, item.span));
    const base = {
      effects: [] as string[],
      claims: [] as string[],
      contracts: [] as ContractEntry[],
      examples: [] as ExampleEntry[],
      properties: [] as PropertyEntry[],
      assumes: this.assumesIn(item),
      recovers: this.recoversIn(item),
      obligations: counts(own),
      at: this.location(item.span),
    };
    const elided = printItem(item, this.rec.comments, { elideBodies: true });
    switch (item.kind) {
      case 'FnDecl': {
        const name = item.name.text;
        return {
          ...base,
          kind: 'fn',
          name,
          visibility: visibility(item.vis),
          signature: printSignature(item),
          effects: this.effectsOf(item),
          claims: item.claims.map((c) => c.segments.map((s) => s.text).join('.')),
          contracts: this.contractsOf(item),
          examples: examples.filter((e) => e.name.text === name).map((e) => this.example(e)),
          properties: properties.filter((p) => p.name.text === name).map((p) => this.property(p)),
        };
      }
      case 'TypeAlias':
      case 'IntrinsicType':
        return { ...base, kind: 'type', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'ConstDecl':
        return { ...base, kind: 'const', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'RecordDecl':
        return { ...base, kind: 'record', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'UnionDecl':
        return { ...base, kind: 'union', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'InterfaceDecl':
        return { ...base, kind: 'interface', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'ImplDecl':
        return {
          ...base,
          kind: 'impl',
          name: `${item.iface.text}[${printType(item.target)}]`,
          visibility: 'pub',
          signature: elided,
          contracts: item.fns.flatMap((f) => this.contractsOf(f)),
          effects: unique(item.fns.flatMap((f) => this.effectsOf(f))),
        };
      case 'ClaimDecl':
        return { ...base, kind: 'claim', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'CapabilityDecl':
        return { ...base, kind: 'capability', name: item.name.text, visibility: visibility(item.vis), signature: elided };
      case 'PathDecl':
        return { ...base, kind: 'path', name: item.name.text, visibility: 'private', signature: elided };
      case 'PolicyDecl':
        return { ...base, kind: 'policy', name: item.name.text, visibility: 'private', signature: elided };
      case 'ExampleDecl':
        return { ...base, kind: 'example', name: item.name.text, visibility: 'private', signature: elided, examples: [this.example(item)] };
      case 'PropertyDecl':
        return { ...base, kind: 'property', name: item.name.text, visibility: 'private', signature: elided, properties: [this.property(item)] };
    }
  }

  private effectsOf(f: A.FnDecl): string[] {
    const def = this.ctx.resolve.defOf.get(f.id);
    const sig = def === undefined ? undefined : this.ctx.types.signatures.get(def);
    if (sig === undefined) return f.effects.map((e) => e.name.segments.map((s) => s.text).join('.'));
    return sig.effects.values().map((e) => this.effectName(e));
  }

  private effectName(e: Effect): string {
    switch (e.k) {
      case 'prim':
      case 'resource':
        return e.name;
      case 'param':
        return this.ctx.resolve.def(e.def).name;
    }
  }

  /** Header contracts and loop clauses, each with the status of the obligations it generated. */
  private contractsOf(f: A.FnDecl): ContractEntry[] {
    const out: ContractEntry[] = [];
    for (const c of f.contracts) out.push(this.contractEntry(c.clause, c.expr, c.proved, c.id));
    if (f.body !== null) {
      walk(f.body, (n) => {
        if (n.kind === 'VerifyBlock') return false;
        if (n.kind === 'LoopClause') out.push(this.contractEntry(n.clause, n.expr, false, n.id));
        return true;
      });
    }
    return out;
  }

  private contractEntry(kind: ContractEntry['kind'], expr: A.Expr, pinned: boolean, source: A.NodeId): ContractEntry {
    // `requires` obligations live at call sites in other definitions, so search every obligation.
    const obs = this.ctx.contracts.obligations.filter((o) => o.source === source);
    const status = statusOf(obs);
    const checked = obs.find((o) => o.status === 'checked');
    const entry: ContractEntry = { kind, text: printExpr(expr), pinned, status, sites: obs.length };
    return checked === undefined ? entry : { ...entry, checked_at: this.locationText(this.ctx.resolve.node(checked.at).span) };
  }

  private example(e: A.ExampleDecl): ExampleEntry {
    const def = this.ctx.resolve.defOf.get(e.id);
    const status = def === undefined ? undefined : this.ctx.consteval.examples.get(def);
    return { name: e.name.text, status: status ?? 'not run', at: this.location(e.span) };
  }

  private property(p: A.PropertyDecl): PropertyEntry {
    const o = this.ctx.contracts.find(p.id, 'property');
    return { name: p.name.text, status: o === null ? 'checked' : statusOf([o]), at: this.location(p.span) };
  }

  private assumesIn(item: A.Item): AssumeEntry[] {
    const out: AssumeEntry[] = [];
    walk(item, (n) => {
      if (n.kind === 'VerifyBlock') return false;
      if (n.kind === 'Assume') {
        const site = this.ctx.claims.assumes.find((a) => a.node === n.id);
        out.push({
          def: this.defNameAt(n.span),
          claim: n.claim.segments.map((s) => s.text).join('.'),
          justification: n.justification,
          at: this.location(n.span),
          verifiable: n.verify !== null,
          last_verified: site === undefined ? null : verifiedOf(this.ctx, site.key),
        });
      }
      return true;
    });
    return out;
  }

  private recoversIn(item: A.Item): RecoverEntry[] {
    const out: RecoverEntry[] = [];
    walk(item, (n) => {
      if (n.kind === 'VerifyBlock') return false;
      if (n.kind === 'Recover') out.push({ def: this.defNameAt(n.span), at: this.location(n.span) });
      return true;
    });
    return out;
  }

  /** The innermost function, example or property containing `span`. */
  private defNameAt(span: Span): string {
    let best: { name: string; size: number } | null = null;
    for (const d of this.ctx.resolve.defs) {
      if (d.kind !== 'fn' && d.kind !== 'example' && d.kind !== 'property') continue;
      // A def's own span is its name; the declaration's extent is its node's.
      const extent = this.ctx.resolve.node(d.node).span;
      if (!within(span, extent)) continue;
      const size = extent.end - extent.start;
      if (best === null || size < best.size) best = { name: d.name, size };
    }
    return best?.name ?? '';
  }

  private ledgerEntry(o: Obligation): LedgerEntry {
    return {
      kind: o.kind,
      text: o.text,
      def: this.ctx.resolve.def(o.def).name,
      status: o.status,
      by: o.by,
      pinned: o.pinned !== null,
      at: this.location(this.ctx.resolve.node(o.at).span),
    };
  }

  private location(span: Span): Location {
    const f = this.ctx.fileOf(span);
    const a = lineColOf(f, span.start);
    const b = lineColOf(f, span.end);
    return { file: f.path, span: [[a.line, a.col], [b.line, b.col]] };
  }

  private locationText(span: Span): string {
    const f = this.ctx.fileOf(span);
    const p = lineColOf(f, span.start);
    return `${f.path}:${p.line}:${p.col}`;
  }
}

function visibility(v: A.Visibility): ItemVisibility {
  return v.pub ? 'pub' : 'private';
}

function within(inner: Span, outer: Span): boolean {
  return inner.file === outer.file && inner.start >= outer.start && inner.end <= outer.end;
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** The aggregate state: any failure fails it, any runtime check makes it checked, else assumed, else proved. */
function statusOf(obs: readonly Obligation[]): ContractStatus {
  if (obs.some((o) => o.status === 'failed')) return 'failed';
  if (obs.some((o) => o.status === 'checked' || o.status === 'pending')) return 'checked';
  if (obs.some((o) => o.status === 'assumed')) return 'assumed';
  return 'proved';
}

function counts(obs: readonly Obligation[]): ObligationCounts {
  const c = { proved: 0, checked: 0, assumed: 0, failed: 0 };
  for (const o of obs) {
    if (o.status === 'proved') c.proved += 1;
    else if (o.status === 'assumed') c.assumed += 1;
    else if (o.status === 'failed') c.failed += 1;
    else c.checked += 1;
  }
  return c;
}
