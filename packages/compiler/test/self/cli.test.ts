/**
 * Milestone 15.4 (impl spec): the `onus` command line in Onus against the
 * TypeScript one on the commands it provides — check, fmt, build, run,
 * interface and path — over a fixed set of invocations. Standard output must
 * agree byte for byte, the two must agree on whether the command failed, and
 * what the commands write (a built program, the image mandelbrot renders)
 * must agree byte for byte. Standard error is not compared: the runtime
 * prints a returned `Err` there, and exit statuses beyond 0 and 1 wait on a
 * language change (`self/cli.onus`).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll, runtimeEntry } from '../../src/codegen/build.js';
import { findClang } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self', 'cli');
const cacheDir = join(here, '..', '..', '.onus-tmp', 'cache');
const tsCli = join(here, '..', '..', 'dist', 'cli', 'main.js');
const BUDGET_MS = 3000;

function checked(entry: string, root: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root, verify: { budgetMs: BUDGET_MS, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

/** Every file under `dir` by relative path, `native/` excluded (compared on its own). */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (d === dir && f === 'native') continue;
      if (statSync(p).isDirectory()) visit(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('the command line in Onus (M15.4)', () => {
  const out = fresh('compiler');
  const ctx = checked(join(selfRoot, 'cli.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for cli');
  const launcher = built.launcher;
  const runtime = runtimeEntry();
  const clang = findClang();

  /** Runs one command line with the same arguments on both sides; `--stdlib` and `--no-cache` are added to both. */
  function both(args: readonly string[], cwd: { ts: string; onus: string } = { ts: repoRoot, onus: repoRoot }): { ts: Run; onus: Run } {
    const common = [...args, '--stdlib', STDLIB_ROOT, '--no-cache'];
    const run = (argv: string[], dir: string, env: NodeJS.ProcessEnv): Run => {
      const r = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: dir, env });
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', ok: r.status === 0 };
    };
    return {
      ts: run([tsCli, ...common], cwd.ts, process.env),
      onus: run([launcher, ...common], cwd.onus, { ...process.env, ONUS_RUNTIME: runtime }),
    };
  }

  function agree(r: { ts: Run; onus: Run }): void {
    expect(r.onus.stdout).toBe(r.ts.stdout);
    expect(r.onus.ok).toBe(r.ts.ok);
  }

  it('check: the text and JSON diagnostics of a failing fixture, and the ledger of a clean one', () => {
    const failing = join(repoRoot, 'packages/compiler/test/verify/e0302_ensures_pinned.onus');
    const text = both(['check', failing]);
    agree(text);
    expect(text.ts.ok).toBe(false);
    expect(text.ts.stdout).toContain('E0302');
    agree(both(['check', failing, '--json']));
    const clean = join(repoRoot, 'packages/compiler/test/verify/e0343_needs_panic.onus');
    agree(both(['check', clean, '--ledger']));
    agree(both(['check', join(repoRoot, 'packages/compiler/test/native/recursion.onus'), '--ledger']));
  }, 300000);

  it('check: an unknown pass and no file are refused', () => {
    agree(both(['check', join(repoRoot, 'packages/compiler/test/native/recursion.onus'), '--to', 'nowhere']));
    agree(both(['check']));
  }, 60000);

  it('fmt --stdout prints the canonical form, and reports syntax errors', () => {
    const messy = readdirSync(join(repoRoot, 'packages/compiler/test/roundtrip/messy')).filter((f) => f.endsWith('.onus') && !f.endsWith('.canonical.onus'));
    for (const f of messy.slice(0, 6)) agree(both(['fmt', join(repoRoot, 'packages/compiler/test/roundtrip/messy', f), '--stdout']));
    const broken = join(fresh('fmt'), 'broken.onus');
    writeFileSync(broken, 'module broken\n\nfn f( -> Int {\n  return 1\n}\n');
    const r = both(['fmt', broken, '--stdout']);
    agree(r);
    expect(r.ts.ok).toBe(false);
  }, 120000);

  it('build --emit ir prints the target-neutral form', () => {
    agree(both(['build', join(repoRoot, 'examples/mandelbrot/mandelbrot.onus'), '--emit', 'ir']));
  }, 300000);

  it('interface: the canonical text, the §11.1 document, and a diff against a previous document', () => {
    const mandelbrot = join(repoRoot, 'examples/mandelbrot/mandelbrot.onus');
    agree(both(['interface', mandelbrot]));
    agree(both(['interface', mandelbrot, '--json']));
    const dir = fresh('interface');
    const original = join(repoRoot, 'packages/compiler/test/native/recursion.onus');
    const old = both(['interface', original, '--json']);
    agree(old);
    const oldPath = join(dir, 'old.json');
    writeFileSync(oldPath, old.ts.stdout);
    // The same module with a function added, a contract tightened and one removed: added, changed and breaking.
    const changed = readFileSync(original, 'utf8').replace('fn countdown(n: Int where it >= 0) -> Int\n  decreases n\n', 'fn countdown(n: Int where it >= 0) -> Int\n  requires n < 1000\n  decreases n\n') + '\npub fn extra(x: Int) -> Int {\n  return x\n}\n';
    const copy = join(dir, 'recursion.onus');
    writeFileSync(copy, changed);
    const diff = both(['interface', copy, '--diff', oldPath]);
    agree(diff);
    expect(diff.ts.stdout).toContain('+ fn extra');
    agree(both(['interface', copy, '--diff', oldPath, '--json']));
    const unchanged = both(['interface', original, '--diff', oldPath]);
    agree(unchanged);
    expect(unchanged.ts.ok).toBe(true);
    agree(both(['interface', original, '--diff', join(dir, 'missing.json')]));
    writeFileSync(join(dir, 'not-a-doc.json'), '{"items": 3}\n');
    agree(both(['interface', original, '--diff', join(dir, 'not-a-doc.json')]));
  }, 300000);

  it('path: the §9.1 report as text and JSON, and an unknown path name', () => {
    const reporting = join(repoRoot, 'examples/reporting/reporting.onus');
    const root = join(repoRoot, 'examples/reporting');
    agree(both(['path', reporting, '--root', root]));
    agree(both(['path', reporting, '--root', root, '--json']));
    agree(both(['path', reporting, 'monthly_report', '--root', root]));
    agree(both(['path', reporting, 'no_such_path', '--root', root]));
  }, 300000);

  it('build and run: the JavaScript program and what it writes', () => {
    const mandelbrot = join(repoRoot, 'examples/mandelbrot/mandelbrot.onus');
    const tsOut = fresh('build-ts');
    const onusOut = fresh('build-onus');
    const tsBuild = both(['build', mandelbrot, '--out', tsOut]).ts;
    const onusBuild = both(['build', mandelbrot, '--out', onusOut]).onus;
    expect(onusBuild.stdout).toBe(tsBuild.stdout);
    expect(onusBuild.ok).toBe(tsBuild.ok);
    const tsFiles = tree(tsOut);
    const onusFiles = tree(onusOut);
    expect([...onusFiles.keys()]).toEqual([...tsFiles.keys()]);
    for (const [name, text] of tsFiles) expect(onusFiles.get(name), name).toBe(text);
    const tsRun = fresh('run-ts');
    const onusRun = fresh('run-onus');
    const rt = both(['run', mandelbrot, '--out', 'out'], { ts: tsRun, onus: onusRun });
    agree(rt);
    expect(rt.ts.ok).toBe(true);
    expect(readFileSync(join(onusRun, 'mandelbrot.pgm'), 'utf8')).toBe(readFileSync(join(tsRun, 'mandelbrot.pgm'), 'utf8'));
  }, 600000);

  it.skipIf(clang === null)('build and run --target native: the LLVM IR, the executable, and what it writes', () => {
    const mandelbrot = join(repoRoot, 'examples/mandelbrot/mandelbrot.onus');
    const tsRun = fresh('native-ts');
    const onusRun = fresh('native-onus');
    const r = both(['run', mandelbrot, '--target', 'native', '--out', 'out'], { ts: tsRun, onus: onusRun });
    agree(r);
    expect(r.ts.ok).toBe(true);
    expect(r.ts.stderr).toContain('onus build: wrote');
    expect(r.onus.stderr).toContain('onus build: wrote');
    expect(readFileSync(join(onusRun, 'out', 'native', 'program.ll'), 'utf8')).toBe(readFileSync(join(tsRun, 'out', 'native', 'program.ll'), 'utf8'));
    expect(readFileSync(join(onusRun, 'mandelbrot.pgm'), 'utf8')).toBe(readFileSync(join(tsRun, 'mandelbrot.pgm'), 'utf8'));
  }, 600000);
});
