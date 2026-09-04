/**
 * The assumption ledger (language spec §20.3): what `onus test --assumptions`
 * recorded for each `assume`, persisted in `.onus/ledger/assumptions.json`
 * and keyed by module and the BLAKE3 of the assumption's canonical text, so
 * a record survives moves and lapses when the assumption changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
