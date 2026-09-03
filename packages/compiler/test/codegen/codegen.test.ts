/**
 * Milestone 5 acceptance (impl spec §9):
 *   - `onus run examples/mandelbrot` writes a correct PGM in one step;
 *   - generated `example`, `property` and `law` tests pass under vitest;
 *   - the fixture suite's `--emit ts` output passes `tsc --strict`;
 *   - a deliberately violated `requires` panics with the obligation in the message.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { build, emitAll } from '../../src/codegen/build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
/** Generated tests resolve `vitest` and `fast-check` from the nearest node_modules, so output stays inside the repository. */
const tmpRoot = join(here, '..', '..', '.onus-tmp');

/** A fresh, empty output directory under the repository. Effects: deletes and recreates it. */
function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
const examplesDir = join(repoRoot, 'examples');
const checkerDir = join(here, '..', 'checker');

function buildTo(entry: string, outDir: string, ts: boolean): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  const result = build(ctx, { outDir, ts });
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (result === null) throw new Error(`build of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function node(script: string, cwd: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function tsc(project: string) {
  return spawnSync(process.execPath, [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', project], { encoding: 'utf8' });
}

function vitest(root: string) {
  const bin = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
  return spawnSync(process.execPath, [bin, 'run', '--root', root, '--config', join(root, 'vitest.config.mjs')], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
}

describe('codegen', () => {
  it('onus run mandelbrot writes a correct PGM', () => {
    const out = fresh('mandelbrot');
    const ctx = new Context({ stdlib: STDLIB_ROOT });
    const entry = join(examplesDir, 'mandelbrot', 'mandelbrot.onus');
    ctx.addFile(entry, readFileSync(entry, 'utf8'));
    const result = build(ctx, { outDir: out, ts: false });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (result === null || result.launcher === null) throw new Error('no launcher');
    const r = node(result.launcher, out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const pgm = readFileSync(join(out, 'mandelbrot.pgm'), 'utf8').split(/\s+/).filter((x) => x !== '');
    expect(pgm.slice(0, 4)).toEqual(['P2', '800', '600', '255']);
    expect(pgm.length - 4).toBe(800 * 600);
    const pixels = pgm.slice(4).map(Number);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pixels) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    expect(hi).toBe(255);
    expect(lo).toBeGreaterThanOrEqual(1);
    // The centre of the view (-2.5..1, -1..1) is inside the set.
    expect(pixels[300 * 800 + 500]).toBe(255);
  }, 60000);

  it('generated example, property and law tests pass under vitest', () => {
    const out = fresh('tests');
    buildTo(join(here, 'features.onus'), out, false);
    buildTo(join(examplesDir, 'mandelbrot', 'mandelbrot.onus'), out, false);
    const files = readdirSync(out).filter((f) => f.endsWith('.examples.test.js'));
    expect(files.sort()).toEqual(['features.examples.test.js', 'mandelbrot.examples.test.js']);
    const r = vitest(out);
    expect(r.stdout + r.stderr).toMatch(/Tests\s+\d+ passed/);
    expect(r.status).toBe(0);
  }, 120000);

  it('--emit ts output passes tsc --strict', () => {
    const out = fresh('ts');
    const entries = [
      join(here, 'features.onus'),
      join(here, 'violated_requires.onus'),
      ...['mandelbrot/mandelbrot.onus', 'reporting/reporting.onus', 'checkout/checkout.onus'].map((e) => join(examplesDir, e)),
      ...readdirSync(checkerDir).filter((f) => f.startsWith('ok_') && f.endsWith('.onus')).map((f) => join(checkerDir, f)),
    ];
    for (const entry of entries) {
      const ctx = new Context({ stdlib: STDLIB_ROOT, root: entry.startsWith(checkerDir) ? checkerDir : null });
      ctx.addFile(entry, readFileSync(entry, 'utf8'));
      runPipeline(ctx, 'contracts');
      expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
      emitAll(ctx, { outDir: out, ts: true });
    }
    expect(existsSync(join(out, 'tsconfig.json'))).toBe(true);
    const r = tsc(join(out, 'tsconfig.json'));
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 120000);

  it('a violated requires panics with the obligation in the message', () => {
    const out = fresh('panic');
    const ctx = new Context({ stdlib: STDLIB_ROOT });
    const entry = join(here, 'violated_requires.onus');
    ctx.addFile(entry, readFileSync(entry, 'utf8'));
    const result = build(ctx, { outDir: out, ts: false });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (result === null || result.launcher === null) throw new Error('no launcher');
    const r = node(result.launcher, out);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('panic: requires `n > 0` failed at');
    expect(r.stderr).toContain('violated_requires.onus:5:3 in half');
  }, 60000);

  it('the other worked examples build as JavaScript', () => {
    const out = fresh('examples');
    for (const e of ['reporting/reporting.onus', 'checkout/checkout.onus']) buildTo(join(examplesDir, e), out, false);
    expect(existsSync(join(out, 'reporting.js'))).toBe(true);
    expect(existsSync(join(out, 'checkout.js'))).toBe(true);
    expect(existsSync(join(out, 'vendor', 'payments.js'))).toBe(true);
  }, 60000);
});
