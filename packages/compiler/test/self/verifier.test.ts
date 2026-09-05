/**
 * Milestone 15.3 (impl spec): the contracts pass and verifier in Onus
 * (`self/check.onus --ledger`) against the TypeScript ones, on every source
 * in the repository. Both run the pipeline up to the same pass with the
 * same z3 budget and proof cache; the diagnostics must agree in code, file
 * and span (compared sorted, see checker.test.ts), and the obligation
 * ledgers must agree entry for entry, in creation order: kind, site, text,
 * status, provenance, pinning and definition.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { runPipeline, type PassName } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');
const cacheDir = join(here, '..', '..', '.onus-tmp', 'cache');
const BUDGET_MS = 3000;

/** The last pass the verifier in Onus implements. */
const TO: PassName = 'verify';

function checked(entry: string, root: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function sources(): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === 'dist' || f === 'out') continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) visit(p);
      else if (f.endsWith('.onus')) out.push(p);
    }
  };
  for (const d of ['examples', 'packages/compiler/test', 'packages/stdlib/std', 'packages/loop/test', 'self']) visit(join(repoRoot, d));
  return out.sort();
}

/** The TypeScript pipeline's diagnostics (sorted) and ledger (in order) up to `TO`. */
function expected(path: string, text: string): { diagnostics: string; ledger: string } {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(path, text);
  runPipeline(ctx, TO);
  const cpOf = (fileId: number, offset: number): number => Array.from(ctx.files[fileId]?.text.slice(0, offset) ?? '').length;
  const diagnostics: string[] = [];
  for (const d of ctx.sink.all()) {
    const f = ctx.fileOf(d.span);
    diagnostics.push(`${d.code}\t${f.path}\t${cpOf(f.id, d.span.start)}\t${cpOf(f.id, d.span.end)}`);
  }
  const ledger: string[] = [];
  for (const o of ctx.contracts.obligations) {
    const span = ctx.resolve.node(o.at).span;
    const f = ctx.fileOf(span);
    ledger.push(`O\t${o.kind}\t${f.path}\t${cpOf(f.id, span.start)}\t${cpOf(f.id, span.end)}\t${o.text.replace(/\n/g, '\\n')}\t${o.status}\t${o.by ?? '-'}\t${o.pinned !== null}\t${ctx.resolve.def(o.def).name}`);
  }
  return { diagnostics: diagnostics.sort().map((l) => `${l}\n`).join(''), ledger: ledger.map((l) => `${l}\n`).join('') };
}

describe('the verifier in Onus (M15.3)', () => {
  const out = join(tmpRoot, 'verify');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'check.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for check');
  const launcher = built.launcher;

  it(`agrees with the TypeScript compiler up to ${TO} on every source in the repository, ledger included`, () => {
    const disagreements: string[] = [];
    for (const path of sources()) {
      const text = readFileSync(path, 'utf8');
      const r = spawnSync(process.execPath, [launcher, path, '--stdlib', STDLIB_ROOT, '--to', TO, '--budget', String(BUDGET_MS), '--cache', cacheDir, '--ledger'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) {
        disagreements.push(`${path}: check exited ${r.status}: ${r.stderr.slice(0, 800)}`);
        continue;
      }
      const lines = r.stdout.split('\n').filter((l) => l.length > 0);
      const gotDiagnostics = lines
        .filter((l) => !l.startsWith('O\t'))
        .map((l) => l.split('\t').slice(0, 4).join('\t'))
        .sort()
        .map((l) => `${l}\n`)
        .join('');
      const gotLedger = lines
        .filter((l) => l.startsWith('O\t'))
        .map((l) => `${l}\n`)
        .join('');
      const want = expected(path, text);
      if (gotDiagnostics !== want.diagnostics) disagreements.push(`${path}: diagnostics\n--- onus:\n${gotDiagnostics}--- typescript:\n${want.diagnostics}`);
      if (gotLedger !== want.ledger) {
        const a = gotLedger.split('\n');
        const b = want.ledger.split('\n');
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
        disagreements.push(`${path}: ledger differs at entry ${i} (${a.length - 1} vs ${b.length - 1} entries)\n--- onus:       ${a.slice(i, i + 3).join('\n                ')}\n--- typescript: ${b.slice(i, i + 3).join('\n                ')}`);
      }
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 1800000);
});
