/**
 * The JSON reports the review tool renders (language spec §9.1, §11.1, §13).
 * These mirror the documents the compiler emits and validates against the
 * schemas in `packages/compiler/src/report/schema/`; the review package
 * depends on nothing, so the shapes are restated here.
 */

export type JsonPos = readonly [number, number];
export type JsonSpan = readonly [JsonPos, JsonPos];

export interface Location {
  readonly file: string;
  readonly span: JsonSpan;
}

export interface ObligationCounts {
  readonly proved: number;
  readonly checked: number;
  readonly assumed: number;
  readonly failed: number;
}

export interface ContractEntry {
  readonly kind: string;
  readonly text: string;
  readonly pinned: boolean;
  readonly status: string;
  readonly sites: number;
  readonly checked_at?: string;
}

export interface Verified {
  readonly at: string;
  readonly target: string;
  readonly result: 'passed' | 'failed';
}

export interface AssumeEntry {
  readonly def: string;
  readonly claim: string;
  readonly justification: string;
  readonly at: Location;
  readonly verifiable: boolean;
  readonly verify: string | null;
  readonly last_verified: Verified | null;
}

export interface RecoverEntry {
  readonly def: string;
  readonly at: Location;
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
  readonly kind: string;
  readonly name: string;
  readonly visibility: string;
  readonly signature: string;
  readonly effects: readonly string[];
  readonly claims: readonly string[];
  readonly contracts: readonly ContractEntry[];
  readonly examples: readonly { readonly name: string; readonly status: string; readonly at: Location }[];
  readonly properties: readonly { readonly name: string; readonly status: string; readonly at: Location }[];
  readonly assumes: readonly AssumeEntry[];
  readonly recovers: readonly RecoverEntry[];
  readonly obligations: ObligationCounts;
  readonly at: Location;
}

/** Obligation coverage (§20.5), per module or path. */
export interface Coverage {
  readonly proved: number;
  readonly checked: number;
  readonly checked_exercised: number;
  readonly assumptions: number;
  readonly assumptions_verifiable: number;
  readonly assumptions_verified: number;
  readonly mutations_detected: number;
  readonly mutations_surviving: number;
}

export interface InterfaceDocument {
  readonly module: string;
  readonly hash: string;
  readonly imports: readonly string[];
  readonly items: readonly InterfaceItem[];
  readonly assumes: readonly AssumeEntry[];
  readonly recovers: readonly RecoverEntry[];
  readonly sealed_types: readonly string[];
  readonly test_module: boolean;
  readonly obligations: ObligationCounts;
  readonly ledger: readonly LedgerEntry[];
  /** Absent in reports written before milestone 13. */
  readonly obligation_coverage?: Coverage;
}

export interface GraphNode {
  readonly id: string;
  readonly module: string;
  readonly kind: 'entry' | 'fn' | 'intrinsic';
  readonly effects: readonly string[];
  readonly claims: readonly string[];
  readonly obligations: ObligationCounts;
  readonly assumes: number;
  readonly recovers: number;
  readonly unresolvable: number;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly effects: readonly string[];
  readonly at: string;
}

export interface Gate {
  readonly evidence: string;
  readonly producers: readonly string[];
  readonly guarded: readonly string[];
}

export interface PathLedgerEntry {
  readonly kind: string;
  readonly text: string;
  readonly def: string;
  readonly status: string;
  readonly by: string | null;
  readonly pinned: boolean;
  readonly at: string;
}

export interface PathReport {
  readonly path: string;
  readonly entry: string;
  readonly reachable: readonly string[];
  readonly effects: { readonly bound: readonly string[] | null; readonly forbid: readonly string[]; readonly actual: readonly string[] };
  readonly claims: { readonly required: readonly string[]; readonly satisfied: boolean };
  readonly assumes: readonly { readonly claim: string; readonly at: string; readonly justification: string; readonly permitted_by: string | null; readonly verifiable: boolean; readonly verify: string | null; readonly last_verified: Verified | null }[];
  readonly obligations: ObligationCounts & { readonly checked_at: readonly string[] };
  readonly unresolvable_calls: readonly { readonly at: string; readonly reason: string }[];
  readonly capabilities: readonly { readonly type: string; readonly constructed_at: string; readonly assumes: readonly string[] }[];
  readonly graph: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] };
  readonly gates: readonly Gate[];
  readonly recovers: readonly { readonly def: string; readonly at: string }[];
  readonly ledger: readonly PathLedgerEntry[];
  /** Absent in reports written before milestone 13. */
  readonly obligation_coverage?: Coverage;
  readonly ok: boolean;
}

export interface DiagnosticJson {
  readonly code: string;
  readonly title: string;
  readonly location: { readonly file: string; readonly def: string | null; readonly span: JsonSpan };
  readonly obligation?: { readonly kind: string; readonly text: string; readonly status: string; readonly counterexample: Readonly<Record<string, unknown>> | null };
  readonly context: readonly string[];
  readonly repairs: readonly unknown[];
  readonly canonical_hash?: string;
}

export interface ContractChange {
  readonly kind: string;
  readonly text: string;
  readonly change: 'added' | 'removed';
  readonly compatibility: 'compatible' | 'breaking';
}

export interface ItemChange {
  readonly name: string;
  readonly kind: string;
  readonly visibility: string;
  readonly signature: { readonly old: string; readonly new: string } | null;
  readonly effects: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly contracts: readonly ContractChange[];
  readonly assumes: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly recovers: { readonly added: number; readonly removed: number };
  readonly obligations: readonly { readonly kind: string; readonly text: string; readonly from: string; readonly to: string }[];
  readonly breaking: boolean;
}

export interface InterfaceDiff {
  readonly module: string;
  readonly old_hash: string;
  readonly new_hash: string;
  readonly added: readonly { readonly name: string; readonly kind: string; readonly visibility: string }[];
  readonly removed: readonly { readonly name: string; readonly kind: string; readonly visibility: string }[];
  readonly changed: readonly ItemChange[];
  readonly breaking: boolean;
}

/** A change or blocked report from the regeneration loop (docs/onus-loop-v0.md §5, §6). */
export interface LoopChange {
  readonly task: { readonly id: string; readonly kind: string; readonly scope: readonly string[]; readonly target: { readonly def: string } | null };
  readonly status: 'opened' | 'blocked';
  readonly cause: string | null;
  readonly generated: { readonly at: string; readonly model: string };
  readonly interface_diff: readonly InterfaceDiff[];
  readonly ledger_delta: readonly { readonly def: string; readonly kind: string; readonly text: string; readonly before: string | null; readonly after: string | null }[];
  readonly body_diff: readonly { readonly file: string; readonly module: string; readonly before: string; readonly after: string }[];
  readonly trace: readonly { readonly iteration: number; readonly classification: string; readonly diagnostics_before: number; readonly diagnostics_after: number; readonly mechanical_repairs: number; readonly tokens: number; readonly ms: number; readonly escalation: string | null }[];
  readonly metrics: { readonly iterations: number; readonly mechanical_repairs: number; readonly escalation_steps: number; readonly proposals: number; readonly tokens: number };
  readonly proposals: readonly { readonly kind: string; readonly def: string; readonly current: string | null; readonly proposed: string | null; readonly rationale: string; readonly counterexample: Readonly<Record<string, unknown>> | null }[];
  readonly audit: readonly { readonly finding: string; readonly detail: string }[];
}

/** Everything one page renders. */
export interface ReviewData {
  readonly generated: { readonly tool: string; readonly at: string };
  readonly entry: string;
  readonly modules: readonly InterfaceDocument[];
  /** Canonical source of each module, for the counted body expansion (§15.1). */
  readonly sources: Readonly<Record<string, string>>;
  readonly paths: readonly PathReport[];
  readonly diagnostics: readonly DiagnosticJson[];
  readonly diff: InterfaceDiff | null;
  /** Absent in data written before milestone 14. */
  readonly changes?: readonly LoopChange[];
}
