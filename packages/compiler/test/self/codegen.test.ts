/**
 * Milestone 15.4 (impl spec): the lowering and the JavaScript emitter in
 * Onus against the TypeScript ones, on every source in the repository that
 * checks clean. Both compilers run the pipeline to `paths` with the same z3
 * budget and proof cache (obligation statuses decide which checks are
 * emitted), then for every such source:
 *   - the target-neutral form of every non-library module, as `onus build
 *     --emit ir` prints it, must agree byte for byte;
 *   - the files `onus build` writes (`package.json`, the vitest config, every
 *     module, every generated test file and the launcher) must agree byte for
 *     byte, name for name;
 *   - the LLVM IR of `onus build --target native` and the E0800 diagnostics
 *     for what the native target does not compile must agree byte for byte.
 * The compiler in Onus is run once per source, several sources at a time;
 * the TypeScript side runs in this process. `ONUS_CODEGEN_SOURCES` (comma-
 * separated path fragments) restricts the sources while iterating.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll, runtimeEntry } from '../../src/codegen/build.js';
import { selfDriver, type SelfDriver } from './driver.js';
import { emitNative } from '../../src/codegen/native.js';
import { findLibpq } from '../../src/codegen/native-build.js';
import { diagnostic, toJson, toText } from '../../src/report/diagnostic.js';
import { printIr } from '../../src/codegen/irtext.js';
import { lowerModule } from '../../src/codegen/lower.js';
import { runPipeline } from '../../src/driver.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');
const cacheDir = join(here, '..', '..', '.onus-tmp', 'cache');
const BUDGET_MS = 3000;
const WORKERS = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
const LIBPQ = findLibpq() !== null;

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
  const only = (process.env['ONUS_CODEGEN_SOURCES'] ?? '').split(',').filter((s) => s.length > 0);
  return out.filter((p) => only.length === 0 || only.some((s) => p.includes(s))).sort();
}

/** Every file under `dir`, by path relative to it, with its content. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (d === dir && f === 'native') continue; // compared as the native program
      if (statSync(p).isDirectory()) visit(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true) visit(dir);
  return out;
}

interface Expected {
  /** The source has diagnostics, so nothing is emitted. */
  readonly skipped: boolean;
  readonly ir: string;
  readonly files: Map<string, string>;
  /** The native program's LLVM IR. */
  readonly ll: string;
  /** The E0800 diagnostics as §13 objects, one per line, sorted. */
  readonly native: string;
}

function expected(path: string, outDir: string, runtime: string): Expected {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(path, readFileSync(path, 'utf8'));
  runPipeline(ctx, 'paths');
  if (ctx.sink.hasErrors()) return { skipped: true, ir: '', files: new Map(), ll: '', native: '' };
  let ir = '';
  for (const m of ctx.resolve.modules) if (!m.isStd) ir += printIr(lowerModule(ctx, m, { verify: false }), ctx.resolve);
  rmSync(outDir, { recursive: true, force: true });
  emitAll(ctx, { outDir, ts: false });
  void runtime;
  const modules = ctx.resolve.modules.map((m) => lowerModule(ctx, m, { verify: false }));
  const entryFile = ctx.files[0];
  const entry = modules.find((m) => entryFile !== undefined && m.module.file === entryFile.id) ?? null;
  const program = emitNative(ctx, modules, entry, { sql: LIBPQ });
  const native = program.unsupported
    .map((u) => JSON.stringify(toJson(ctx, diagnostic({ code: 'E0800', span: u.span, def: u.def.split('.').pop() ?? null, context: [`\`${u.def}\` uses ${u.what}, which the native target does not provide in v0 (§19.1)`] }))))
    .sort()
    .map((l) => `${l}\n`)
    .join('');
  return { skipped: false, ir, files: tree(outDir), ll: program.ll, native };
}

function actual(driver: SelfDriver, path: string, outDir: string, runtime: string): Promise<{ status: number | null; stderr: string; ir: string; files: Map<string, string>; ll: string; native: string }> {
  rmSync(outDir, { recursive: true, force: true });
  return new Promise((resolve) => {
    const args = [...driver.prefix, path, '--stdlib', STDLIB_ROOT, '--budget', String(BUDGET_MS), '--cache', cacheDir, '--diag-json', '--ir', '--emit', outDir, '--runtime', runtime, '--native', outDir, ...(LIBPQ ? [] : ['--no-libpq'])];
    const child = spawn(driver.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      const diags: string[] = [];
      const ir: string[] = [];
      for (const line of stdout.split('\n')) {
        if (line.startsWith('{"code":')) diags.push(line);
        else ir.push(line);
      }
      const llPath = join(outDir, 'native', 'program.ll');
      const ll = statSync(llPath, { throwIfNoEntry: false })?.isFile() === true ? readFileSync(llPath, 'utf8') : '';
      resolve({
        status,
        stderr,
        ir: ir.join('\n'),
        files: tree(outDir),
        ll,
        native: diags
          .sort()
          .map((l) => `${l}\n`)
          .join(''),
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

describe('the lowering and the JavaScript emitter in Onus (M15.4)', () => {
  const out = join(tmpRoot, 'codegen');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'check.onus'), selfRoot);
  const driver = selfDriver(ctx, join(out, 'compiler'), 'check');
  const runtime = runtimeEntry();

  it('agrees with the TypeScript compiler on the target-neutral form and the emitted JavaScript of every clean source in the repository', async () => {
    const disagreements: string[] = [];
    const paths = sources();
    const wanted = new Map<string, Expected>();
    paths.forEach((path, i) => wanted.set(path, expected(path, join(out, 'ts', String(i)), runtime)));
    let next = 0;
    const results = new Map<string, Awaited<ReturnType<typeof actual>>>();
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const i = next;
        const path = paths[i];
        next += 1;
        if (path === undefined) break;
        if (wanted.get(path)?.skipped === true) continue;
        results.set(path, await actual(driver, path, join(out, 'onus', String(i)), runtime));
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, () => worker()));
    let compared = 0;
    for (const path of paths) {
      const want = wanted.get(path);
      if (want === undefined || want.skipped) continue;
      const got = results.get(path);
      if (got === undefined) {
        disagreements.push(`${path}: no result`);
        continue;
      }
      if (got.status !== 0) {
        disagreements.push(`${path}: check exited ${got.status}: ${got.stderr.slice(0, 800)}`);
        continue;
      }
      compared += 1;
      if (got.ir !== want.ir) disagreements.push(`${path}: ${firstDifference(got.ir, want.ir, 'IR texts')}`);
      if (got.ll !== want.ll) disagreements.push(`${path}: ${firstDifference(got.ll, want.ll, 'native programs')}`);
      if (got.native !== want.native) disagreements.push(`${path}: E0800 diagnostics\n--- onus:\n${got.native}--- typescript:\n${want.native}`);
      const names = new Set([...want.files.keys(), ...got.files.keys()]);
      for (const name of [...names].sort()) {
        const w = want.files.get(name);
        const g = got.files.get(name);
        if (w === undefined) disagreements.push(`${path}: ${name} emitted only by the compiler in Onus`);
        else if (g === undefined) disagreements.push(`${path}: ${name} emitted only by the TypeScript compiler`);
        else if (w !== g) disagreements.push(`${path}: ${firstDifference(g, w, name)}`);
      }
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  }, 4 * 60 * 60 * 1000);
});
