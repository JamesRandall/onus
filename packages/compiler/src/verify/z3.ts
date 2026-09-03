/**
 * The z3 driver and the proof cache (impl spec §7.2–§7.4).
 *
 * One `z3 -in -smt2` process per condition, with the budget as z3's own
 * timeout and a slightly larger process timeout. `unsat` proves the
 * obligation; `sat` yields a model; `unknown` and timeouts are reported as
 * such and never cached. The cache lives in `.onus/cache/` and is keyed by
 * a BLAKE3 hash of the problem text, the solver version and the budget.
 */
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SolverOutcome = 'unsat' | 'sat' | 'unknown' | 'timeout' | 'error';

export interface SolverResult {
  readonly outcome: SolverOutcome;
  /** Values of the problem's constants when `sat`, by SMT name. */
  readonly model: Readonly<Record<string, string>>;
  readonly detail: string;
}

/** The z3 executable, or null when none is on PATH. Effects: spawns `z3 --version`. */
export function findZ3(explicit: string | null = null): { path: string; version: string } | null {
  const path = explicit ?? 'z3';
  const r = spawnSync(path, ['--version'], { encoding: 'utf8' });
  if (r.error !== undefined || r.status !== 0) return null;
  return { path, version: r.stdout.trim() };
}

/**
 * Runs z3 on `problem` with `budgetMs`.
 * Effects: spawns a process.
 */
export function runZ3(z3Path: string, problem: string, budgetMs: number): SolverResult {
  const r = spawnSync(z3Path, ['-in', '-smt2', `-t:${budgetMs}`], { input: problem, encoding: 'utf8', timeout: budgetMs * 4 + 2000 });
  if (r.error !== undefined && r.error.name === 'Error' && 'code' in r.error && r.error.code === 'ETIMEDOUT') {
    return { outcome: 'timeout', model: {}, detail: 'process timeout' };
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const first = lines.find((l) => l === 'sat' || l === 'unsat' || l === 'unknown' || l === 'timeout' || l.startsWith('(error'));
  if (first === 'unsat') return { outcome: 'unsat', model: {}, detail: '' };
  if (first === 'sat') return { outcome: 'sat', model: parseModel(out), detail: '' };
  if (first === 'unknown' || first === 'timeout') return { outcome: 'timeout', model: {}, detail: out.includes('timeout') || first === 'timeout' ? 'solver timeout' : 'unknown' };
  return { outcome: 'error', model: {}, detail: out.slice(0, 500) };
}

/** Extracts `(define-fun name () Sort value)` entries of a z3 model. Effects: none. */
export function parseModel(text: string): Record<string, string> {
  const model: Record<string, string> = {};
  const re = /\(define-fun\s+([^\s()]+)\s+\(\)\s+([^\s()]+)\s+((?:\(- \d+\))|[^\s()]+)\)/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    const value = m[3];
    if (name === undefined || value === undefined) continue;
    model[name] = value.startsWith('(- ') ? `-${value.slice(3, -1)}` : value;
  }
  return model;
}

export class ProofCache {
  constructor(private readonly dir: string | null) {}

  key(problem: string, version: string, budgetMs: number): string {
    return bytesToHex(blake3(new TextEncoder().encode(`${version}\n${budgetMs}\n${problem}`)));
  }

  get(key: string): SolverResult | null {
    if (this.dir === null) return null;
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isResult(parsed)) return parsed;
    } catch {
      // A corrupt entry is treated as a miss.
    }
    return null;
  }

  /** Stores a result. `unknown`, `timeout` and `error` are never cached. Effects: writes a file. */
  set(key: string, result: SolverResult): void {
    if (this.dir === null || result.outcome === 'timeout' || result.outcome === 'unknown' || result.outcome === 'error') return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(result));
  }
}

function isResult(v: unknown): v is SolverResult {
  return typeof v === 'object' && v !== null && 'outcome' in v && 'model' in v && 'detail' in v;
}
