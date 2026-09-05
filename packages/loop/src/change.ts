/**
 * Changes and blocked reports (docs/onus-loop-v0.md §4, §5, §6): the
 * loop's output, written under `.onus/changes/<task id>/` for the review
 * tool. A proposal is a structured object, never an edit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiagnosticJson, InterfaceDiff } from '@onus/compiler';
import type { Task } from './task.js';

export type ProposalKind = 'weaken_postcondition' | 'add_precondition' | 'widen_effects' | 'add_claim' | 'add_example' | 'new_helper' | 'unsatisfiable';

export interface Proposal {
  readonly kind: ProposalKind;
  readonly def: string;
  readonly current: string | null;
  readonly proposed: string | null;
  readonly evidence: { readonly counterexample: Readonly<Record<string, unknown>> | null; readonly iterations: number; readonly [k: string]: unknown };
  readonly rationale: string;
}

export interface TraceEntry {
  readonly iteration: number;
  readonly model: string;
  readonly prompt_hash: string;
  readonly diagnostics_before: number;
  readonly diagnostics_after: number;
  readonly codes_after: readonly string[];
  readonly failing_tests: readonly string[];
  readonly mechanical_repairs: number;
  readonly tokens: number;
  readonly ms: number;
  readonly classification: string;
  readonly escalation: string | null;
}

export interface LedgerDelta {
  readonly def: string;
  readonly kind: string;
  readonly text: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface BodyDiff {
  readonly file: string;
  readonly module: string;
  readonly before: string;
  readonly after: string;
}

export interface AuditFinding {
  readonly finding: 'obligation_regressed' | 'example_failed' | 'body_differs';
  readonly detail: string;
}

export type BlockedCause = 'stall' | 'contract_conflict' | 'out_of_scope' | 'budget' | 'compiler_bug' | 'baseline';

export interface Metrics {
  readonly iterations: number;
  readonly mechanical_repairs: number;
  readonly escalation_steps: number;
  readonly proposals: number;
  readonly tokens: number;
}

export interface Change {
  readonly schema_version: 1;
  readonly task: Task;
  readonly status: 'opened' | 'blocked';
  readonly cause?: BlockedCause;
  readonly generated: { readonly at: string; readonly model: string };
  readonly interface_diff: readonly InterfaceDiff[];
  readonly ledger_delta: readonly LedgerDelta[];
  readonly body_diff: readonly BodyDiff[];
  readonly trace: readonly TraceEntry[];
  readonly metrics: Metrics;
  readonly proposals: readonly Proposal[];
  readonly audit: readonly AuditFinding[];
  readonly last_diagnostics?: readonly DiagnosticJson[];
  readonly best_attempt?: { readonly iteration: number; readonly diagnostics: number; readonly bodies: Readonly<Record<string, string>> } | null;
}

/** The directory a task's change lives in. Effects: none. */
export function changeDir(root: string, taskId: string): string {
  return join(root, '.onus', 'changes', taskId.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/** Writes `change.json` for the task. Effects: creates the directory and writes the file. */
export function writeChange(root: string, change: Change): string {
  const dir = changeDir(root, change.task.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'change.json');
  writeFileSync(path, `${JSON.stringify(change, null, 2)}\n`);
  return path;
}
