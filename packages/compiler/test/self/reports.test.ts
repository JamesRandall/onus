/**
 * Milestone 15.3 (impl spec): the reports in Onus against the TypeScript
 * ones, on every source in the repository. For a source that checks clean,
 * `self/check.onus --interface-json --path-json` must print the entry
 * module's §11.1 interface document and the §9.1 report of each of its
 * paths byte for byte as `onus interface --json` and `onus path --json`
 * do; for a source with diagnostics, `--diag-json` must print the same §13
 * JSON objects (compared sorted, as checker.test.ts compares diagnostics).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { runPipeline } from '../../src/driver.js';
import { toJson, toText } from '../../src/report/diagnostic.js';
import { interfaceOf } from '../../src/report/interface.js';
import { pathReport } from '../../src/report/path.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');
const cacheDir = join(here, '..', '..', '.onus-tmp', 'cache');
const BUDGET_MS = 3000;

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

/** The TypeScript reports of `path`: the diagnostics as JSON lines when there are any, else the interface and path documents. */
function expected(path: string, text: string): { diagnostics: string; reports: string } {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(path, text);
  runPipeline(ctx, 'paths');
  const diagnostics = ctx.sink
    .all()
    .map((d) => JSON.stringify(toJson(ctx, d)))
    .sort()
    .map((l) => `${l}\n`)
    .join('');
  if (diagnostics.length > 0) return { diagnostics, reports: '' };
  const file = ctx.files[0];
  const rec = ctx.resolve.modules.find((m) => file !== undefined && m.file === file.id);
  if (rec === undefined || file === undefined) return { diagnostics, reports: '' };
  let reports = `${JSON.stringify(interfaceOf(ctx, rec.id), null, 2)}\n`;
  for (const a of ctx.paths.analyses.values()) {
    if (ctx.resolve.moduleOf(a.module).file === file.id) reports += `${JSON.stringify(pathReport(ctx, a), null, 2)}\n`;
  }
  return { diagnostics, reports };
}

describe('the reports in Onus (M15.3)', () => {
  const out = join(tmpRoot, 'reports');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'check.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for check');
  const launcher = built.launcher;

  it('prints the interface, path and diagnostic documents of every source as the TypeScript compiler does', () => {
    const disagreements: string[] = [];
    for (const path of sources()) {
      const text = readFileSync(path, 'utf8');
      const want = expected(path, text);
      const flags = want.diagnostics.length > 0 ? ['--diag-json'] : ['--interface-json', '--path-json'];
      const r = spawnSync(process.execPath, [launcher, path, '--stdlib', STDLIB_ROOT, '--budget', String(BUDGET_MS), '--cache', cacheDir, ...flags], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      if (r.status !== 0) {
        disagreements.push(`${path}: check exited ${r.status}: ${r.stderr.slice(0, 800)}`);
        continue;
      }
      if (want.diagnostics.length > 0) {
        const got = r.stdout
          .split('\n')
          .filter((l) => l.length > 0)
          .sort()
          .map((l) => `${l}\n`)
          .join('');
        if (got !== want.diagnostics) disagreements.push(`${path}: diagnostics\n--- onus:\n${got}--- typescript:\n${want.diagnostics}`);
      } else if (r.stdout !== want.reports) {
        const a = r.stdout.split('\n');
        const b = want.reports.split('\n');
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
        disagreements.push(`${path}: reports differ at line ${i + 1} (${a.length} vs ${b.length} lines)\n--- onus:       ${a.slice(i, i + 4).join('\n                ')}\n--- typescript: ${b.slice(i, i + 4).join('\n                ')}`);
      }
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 1800000);
});
