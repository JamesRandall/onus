/**
 * Milestone 11 acceptance (impl spec §9): Mandelbrot builds natively and
 * writes an identical PGM to the JavaScript build; every example passes on
 * both targets; E0801 fires on a deliberately broken runtime primitive; a
 * program outside the native subset is E0800. Skipped when `clang` is not
 * on PATH.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, compareTargets, findClang, runJsExamples, runNativeExamples } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'native');
const clang = findClang();

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checked(entry: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

describe.skipIf(clang === null)('native target (§19)', () => {
  it('mandelbrot builds natively and writes the same PGM as the JavaScript build', () => {
    const out = fresh('mandelbrot');
    const entry = join(repoRoot, 'examples', 'mandelbrot', 'mandelbrot.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const jsDir = join(out, 'js-run');
    mkdirSync(jsDir, { recursive: true });
    expect(spawnSync(process.execPath, [js.launcher], { cwd: jsDir, encoding: 'utf8' }).status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const nativeDir = join(out, 'native-run');
    mkdirSync(nativeDir, { recursive: true });
    const r = spawnSync(native.exe, [], { cwd: nativeDir, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const jsPgm = readFileSync(join(jsDir, 'mandelbrot.pgm'), 'utf8');
    const nativePgm = readFileSync(join(nativeDir, 'mandelbrot.pgm'), 'utf8');
    expect(nativePgm.length).toBe(jsPgm.length);
    expect(nativePgm).toBe(jsPgm);
  }, 120000);

  it('every example passes on both targets', () => {
    for (const rel of ['examples/mandelbrot/mandelbrot.onus', 'packages/compiler/test/native/primitives.onus']) {
      const out = fresh(`examples-${rel.split('/').pop() ?? 'x'}`);
      const ctx = checked(join(repoRoot, rel));
      const js = emitAll(ctx, { outDir: out, ts: false });
      void js;
      const native = buildNative(ctx, { outDir: out });
      expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
      if (native.exe === null) throw new Error('native build failed');
      const nativeRun = runNativeExamples(native.exe);
      expect(nativeRun.results.size).toBeGreaterThan(0);
      expect([...nativeRun.results.entries()].filter(([, ok]) => !ok)).toEqual([]);
      const jsRun = runJsExamples(out);
      expect(jsRun.size).toBe(nativeRun.results.size);
      expect(compareTargets(ctx, jsRun, nativeRun.results)).toBe(0);
      expect(ctx.sink.all()).toEqual([]);
    }
  }, 180000);

  it('E0801 fires on a deliberately broken runtime primitive', () => {
    const out = fresh('broken');
    const ctx = checked(join(here, 'primitives.onus'));
    const js = emitAll(ctx, { outDir: out, ts: false });
    void js;
    const native = buildNative(ctx, { outDir: out, cflags: ['-DONUS_BROKEN_INT_TO_TEXT'] });
    if (native.exe === null) throw new Error('native build failed');
    const nativeRun = runNativeExamples(native.exe);
    expect(nativeRun.results.get('primitives.text_and_ints')).toBe(false);
    const jsRun = runJsExamples(out);
    expect(compareTargets(ctx, jsRun, nativeRun.results)).toBeGreaterThan(0);
    const codes = ctx.sink.all().map((d) => d.code);
    expect(codes).toContain('E0801');
    expect(ctx.sink.all()[0]?.context[0]).toContain('primitives.text_and_ints');
  }, 180000);

  it('a program outside the native subset is E0800', () => {
    const out = fresh('unsupported');
    const ctx = checked(join(here, 'unsupported.onus'));
    const native = buildNative(ctx, { outDir: out });
    expect(native.exe).toBeNull();
    const diags = ctx.sink.all();
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.code === 'E0800')).toBe(true);
    expect(diags[0]?.context[0]).toContain('function values');
  }, 60000);
});

if (clang === null) {
  it('notice: clang is not on PATH, native tests skipped', () => {
    process.stderr.write('onus tests: clang not found; native target tests skipped\n');
  });
}
