/**
 * Milestone 15.3 (impl spec): the contracts pass, the verifier, claims,
 * capabilities, paths and the reports in Onus against the TypeScript ones,
 * on every source in the repository. Both compilers run the pipeline to
 * `paths` with the same z3 budget and proof cache. For every source:
 *   - the diagnostics must agree as §13 JSON objects (compared sorted, as
 *     checker.test.ts compares them);
 *   - the obligation ledgers must agree entry for entry, in creation order:
 *     kind, site, text, status, provenance, pinning and definition;
 *   - when the source checks clean, the entry module's §11.1 interface
 *     document and the §9.1 report of each of its paths must agree byte for
 *     byte with `onus interface --json` and `onus path --json`.
 * The compiler in Onus is run once per source, several sources at a time;
 * the TypeScript side runs in this process.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
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
/** Sources checked by the compiler in Onus at the same time. */
const WORKERS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

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

interface Expected {
  /** The §13 objects, one per line, sorted. */
  readonly diagnostics: string;
  /** The ledger, one entry per line, in creation order. */
  readonly ledger: string;
  /** The interface document and the path reports, pretty-printed; empty when the source has diagnostics. */
  readonly reports: string;
}

/** The TypeScript pipeline's diagnostics, ledger and reports for `path`. */
function expected(path: string, text: string): Expected {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(path, text);
  runPipeline(ctx, 'paths');
  const cpOf = (fileId: number, offset: number): number => Array.from(ctx.files[fileId]?.text.slice(0, offset) ?? '').length;
  const diagnostics = ctx.sink
    .all()
    .map((d) => JSON.stringify(toJson(ctx, d)))
    .sort()
    .map((l) => `${l}\n`)
    .join('');
  const ledger: string[] = [];
  for (const o of ctx.contracts.obligations) {
    const span = ctx.resolve.node(o.at).span;
    const f = ctx.fileOf(span);
    ledger.push(`O\t${o.kind}\t${f.path}\t${cpOf(f.id, span.start)}\t${cpOf(f.id, span.end)}\t${o.text.replace(/\n/g, '\\n')}\t${o.status}\t${o.by ?? '-'}\t${o.pinned !== null}\t${ctx.resolve.def(o.def).name}`);
  }
  let reports = '';
  const file = ctx.files[0];
  const rec = ctx.resolve.modules.find((m) => file !== undefined && m.file === file.id);
  if (diagnostics.length === 0 && rec !== undefined && file !== undefined) {
    reports = `${JSON.stringify(interfaceOf(ctx, rec.id), null, 2)}\n`;
    for (const a of ctx.paths.analyses.values()) {
      if (ctx.resolve.moduleOf(a.module).file === file.id) reports += `${JSON.stringify(pathReport(ctx, a), null, 2)}\n`;
    }
  }
  return { diagnostics, ledger: ledger.map((l) => `${l}\n`).join(''), reports };
}

/** Runs the compiler in Onus on `path` and splits its output into the same three parts. */
function actual(launcher: string, path: string): Promise<{ status: number | null; stderr: string } & Expected> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, path, '--stdlib', STDLIB_ROOT, '--budget', String(BUDGET_MS), '--cache', cacheDir, '--diag-json', '--ledger', '--interface-json', '--path-json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      const diagnostics: string[] = [];
      const ledger: string[] = [];
      const reports: string[] = [];
      for (const line of stdout.split('\n')) {
        if (line.startsWith('O\t')) ledger.push(line);
        else if (line.startsWith('{"code":')) diagnostics.push(line);
        else reports.push(line);
      }
      // The reports end with a newline of their own; the final split element is the empty text after it.
      const reportText = reports.join('\n').replace(/\n$/, '');
      resolve({
        status,
        stderr,
        diagnostics: diagnostics
          .sort()
          .map((l) => `${l}\n`)
          .join(''),
        ledger: ledger.map((l) => `${l}\n`).join(''),
        reports: reportText.length === 0 ? '' : `${reportText}\n`,
      });
    });
  });
}

function firstDifference(a: string, b: string, what: string): string {
  const as = a.split('\n');
  const bs = b.split('\n');
  let i = 0;
  while (i < as.length && i < bs.length && as[i] === bs[i]) i += 1;
  return `${what} differ at line ${i + 1} (${as.length - 1} vs ${bs.length - 1} lines)\n--- onus:       ${as.slice(i, i + 3).join('\n                ')}\n--- typescript: ${bs.slice(i, i + 3).join('\n                ')}`;
}

describe('the verifier and the reports in Onus (M15.3)', () => {
  const out = join(tmpRoot, 'verify');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'check.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for check');
  const launcher = built.launcher;

  it('agrees with the TypeScript compiler on the diagnostics, the ledger and the reports of every source in the repository', async () => {
    const disagreements: string[] = [];
    const paths = sources();
    // The TypeScript side first, in this process; then the compiler in Onus, several sources at a time.
    const wanted = new Map<string, Expected>();
    for (const path of paths) wanted.set(path, expected(path, readFileSync(path, 'utf8')));
    let next = 0;
    const results = new Map<string, Awaited<ReturnType<typeof actual>>>();
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const path = paths[next];
        next += 1;
        if (path === undefined) break;
        results.set(path, await actual(launcher, path));
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, () => worker()));
    for (const path of paths) {
      const want = wanted.get(path);
      const got = results.get(path);
      if (want === undefined || got === undefined) {
        disagreements.push(`${path}: no result`);
        continue;
      }
      if (got.status !== 0) {
        disagreements.push(`${path}: check exited ${got.status}: ${got.stderr.slice(0, 800)}`);
        continue;
      }
      if (got.diagnostics !== want.diagnostics) disagreements.push(`${path}: diagnostics\n--- onus:\n${got.diagnostics}--- typescript:\n${want.diagnostics}`);
      if (got.ledger !== want.ledger) disagreements.push(`${path}: ${firstDifference(got.ledger, want.ledger, 'ledgers')}`);
      if (got.reports !== want.reports) disagreements.push(`${path}: ${firstDifference(got.reports, want.reports, 'reports')}`);
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 4 * 60 * 60 * 1000);
});
