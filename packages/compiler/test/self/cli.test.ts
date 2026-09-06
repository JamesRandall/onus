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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { runtimeEntry } from '../../src/codegen/build.js';
import { selfDriver } from './driver.js';
import { buildNative, findClang } from '../../src/codegen/native-build.js';
import { findZ3 } from '../../src/verify/z3.js';
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
  const driver = selfDriver(ctx, out, 'cli');
  const runtime = runtimeEntry();
  const clang = findClang();

  /** Runs one command line with the same arguments on both sides; `--stdlib` and `--no-cache` are added to both. */
  function both(args: readonly string[], cwd: { ts: string; onus: string } = { ts: repoRoot, onus: repoRoot }): { ts: Run; onus: Run } {
    const common = [...args, '--stdlib', STDLIB_ROOT, '--no-cache'];
    const run = (cmd: string, argv: string[], dir: string, env: NodeJS.ProcessEnv): Run => {
      const r = spawnSync(cmd, argv, { encoding: 'utf8', cwd: dir, env });
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', ok: r.status === 0 };
    };
    return {
      ts: run(process.execPath, [tsCli, ...common], cwd.ts, process.env),
      onus: run(driver.cmd, [...driver.prefix, ...common], cwd.onus, { ...process.env, ONUS_RUNTIME: runtime }),
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

  it.skipIf(clang === null)('the released compiler needs no repository: no --stdlib, no --runtime, no node on the path (item 180)', () => {
    const native = buildNative(ctx, { outDir: fresh('release-build') });
    const diags = ctx.sink.all().map((d) => toText(ctx, d));
    expect(native.exe, diags.join('\n')).not.toBeNull();
    if (native.exe === null) return;
    const home = fresh('release-home');
    writeFileSync(join(home, 'mandelbrot.onus'), readFileSync(join(repoRoot, 'examples/mandelbrot/mandelbrot.onus'), 'utf8'));
    // A path without node: a directory holding clang and z3 alone (Homebrew keeps node beside z3), and the system's.
    const bin = fresh('release-bin');
    for (const tool of [clang, findZ3()?.path ?? null]) {
      if (tool === null) continue;
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim() || tool;
      symlinkSync(resolved, join(bin, basename(tool)));
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: [bin, '/usr/bin', '/bin'].join(':') };
    delete env['ONUS_STDLIB'];
    delete env['ONUS_RUNTIME'];
    const run = (args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } => {
      const r = spawnSync(native.exe ?? '', args, { encoding: 'utf8', cwd, env });
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
    };
    expect(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf8', env }).status).not.toBe(0);
    const version = run(['--version'], home);
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/^onus \d+\.\d+\.\d+\n$/);
    const check = run(['check', 'mandelbrot.onus'], home);
    expect(check.status, check.stdout + check.stderr).toBe(0);
    const js = run(['build', 'mandelbrot.onus', '--out', 'out'], home);
    expect(js.status, js.stdout + js.stderr).toBe(0);
    expect(existsSync(join(home, 'out', 'onus-runtime', 'index.js'))).toBe(true);
    expect(readFileSync(join(home, 'out', 'mandelbrot.js'), 'utf8')).toContain('from "./onus-runtime/index.js"');
    expect(readFileSync(join(home, 'out', 'std', 'int.js'), 'utf8')).toContain('from "../onus-runtime/index.js"');
    const jsRun = fresh('release-js-run');
    expect(spawnSync(process.execPath, [join(home, 'out', 'run_mandelbrot.js')], { encoding: 'utf8', cwd: jsRun }).status).toBe(0);
    const nat = run(['build', 'mandelbrot.onus', '--out', 'out', '--target', 'native'], home);
    expect(nat.status, nat.stdout + nat.stderr).toBe(0);
    expect(existsSync(join(home, 'out', 'native', 'runtime', 'onus.c'))).toBe(true);
    expect(existsSync(join(home, 'out', 'native', 'runtime', 'blake3', 'blake3.c'))).toBe(true);
    const natRun = fresh('release-native-run');
    expect(spawnSync(join(home, 'out', 'native', 'mandelbrot'), [], { encoding: 'utf8', cwd: natRun }).status).toBe(0);
    expect(readFileSync(join(natRun, 'mandelbrot.pgm'), 'utf8')).toBe(readFileSync(join(jsRun, 'mandelbrot.pgm'), 'utf8'));
  }, 600000);
});
