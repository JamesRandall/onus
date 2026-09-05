/**
 * The assumption ledger (language spec §20.3): what `onus test --assumptions`
 * recorded for each `assume`, persisted in `.onus/ledger/assumptions.json`
 * and keyed by module and the BLAKE3 of the assumption's canonical text, so
 * a record survives moves and lapses when the assumption changes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VerificationRecord {
  readonly at: string;
  readonly target: string;
  readonly result: 'passed' | 'failed';
  readonly claim: string;
  readonly def: string;
}

export type AssumptionLedger = Readonly<Record<string, VerificationRecord>>;

export const LEDGER_FILE = 'assumptions.json';

/** Reads the ledger in `dir`, or an empty one when absent or unreadable. Effects: reads a file. */
export function readLedger(dir: string): AssumptionLedger {
  const path = join(dir, LEDGER_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, VerificationRecord> = {};
    for (const [k, v] of Object.entries(parsed)) if (isRecord(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Writes the ledger to `dir`, creating it. Effects: writes a file. */
export function writeLedger(dir: string, ledger: AssumptionLedger): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
}

function isRecord(v: unknown): v is VerificationRecord {
  return typeof v === 'object' && v !== null && 'at' in v && 'target' in v && 'result' in v && 'claim' in v && 'def' in v && (v.result === 'passed' || v.result === 'failed');
}

/** True iff `r` is a passing verification no older than `maxAgeMs` at `now`. Effects: none. */
export function isCurrent(r: VerificationRecord | undefined, now: number, maxAgeMs: number): boolean {
  if (r === undefined || r.result !== 'passed') return false;
  const at = Date.parse(r.at);
  return Number.isFinite(at) && now - at <= maxAgeMs;
}

// ---------------------------------------------------------------------------
// Obligation coverage and contract mutation (§20.4, §20.5)
// ---------------------------------------------------------------------------

export const COVERAGE_FILE = 'coverage.json';
export const MUTATIONS_FILE = 'mutations.json';

/** Runtime hits per obligation check, keyed by the check's `file:line:col`, from the last `onus test`. */
export type CoverageTable = Readonly<Record<string, number>>;

/** The outcome of one contract weakening under `onus test --mutate` (§20.4). */
export interface MutationRecord {
  readonly kind: 'drop-ensures' | 'widen-return' | 'widen-field' | 'negate-guard';
  /** The qualified name of the function, record or property mutated. */
  readonly def: string;
  /** The weakening, in words. */
  readonly text: string;
  /** Whether an example, property or law told the weakened contract from the original. */
  readonly detected: boolean;
  /** What detected it, or why nothing could. */
  readonly by: string;
}

/** Reads `dir/coverage.json`; an absent or malformed file is an empty table. Effects: reads the file system. */
export function readCoverage(dir: string): CoverageTable {
  return readCoverage_(join(dir, COVERAGE_FILE));
}

/**
 * Folds the per-process hit files a test run wrote under `dir` into `base`,
 * keeping the larger count per check. Effects: reads the file system.
 */
export function mergeCoverage(dir: string, base: CoverageTable): CoverageTable {
  const out: Record<string, number> = { ...base };
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    for (const [k, v] of Object.entries(readCoverage_(join(dir, name)))) out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

function readCoverage_(path: string): CoverageTable {
  const parsed = readJson(path);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') out[k] = v;
  return out;
}

/** Writes the coverage table. Effects: creates `dir` and writes the file. */
export function writeCoverage(dir: string, table: CoverageTable): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, COVERAGE_FILE), `${JSON.stringify(table, Object.keys(table).sort(), 2)}\n`);
}

/** Reads `dir/mutations.json`; an absent or malformed file is no records. Effects: reads the file system. */
export function readMutations(dir: string): readonly MutationRecord[] {
  const parsed = readJson(join(dir, MUTATIONS_FILE));
  if (typeof parsed !== 'object' || parsed === null || !('results' in parsed) || !Array.isArray(parsed.results)) return [];
  const out: MutationRecord[] = [];
  for (const r of parsed.results) {
    if (typeof r !== 'object' || r === null) continue;
    const kind = 'kind' in r ? r.kind : null;
    const def = 'def' in r ? r.def : null;
    const text = 'text' in r ? r.text : null;
    const detected = 'detected' in r ? r.detected : null;
    const by = 'by' in r ? r.by : null;
    if ((kind !== 'drop-ensures' && kind !== 'widen-return' && kind !== 'widen-field' && kind !== 'negate-guard') || typeof def !== 'string' || typeof text !== 'string' || typeof detected !== 'boolean' || typeof by !== 'string') continue;
    out.push({ kind, def, text, detected, by });
  }
  return out;
}

/** Writes the mutation records with the time of the run. Effects: creates `dir` and writes the file. */
export function writeMutations(dir: string, records: readonly MutationRecord[], at: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MUTATIONS_FILE), `${JSON.stringify({ at, results: records }, null, 2)}\n`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
