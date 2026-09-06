/**
 * Milestone 11 acceptance (impl spec §9): Mandelbrot builds natively and
 * writes an identical PGM to the JavaScript build; every example passes on
 * both targets; E0801 fires on a deliberately broken runtime primitive; a
 * `Dict` keyed by a record is E0800. Skipped when `clang` is not on PATH.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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

  it('`io.run` and `io.mkdir` behave the same on both targets', () => {
    const out = fresh('process');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'process_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const jsDir = join(out, 'js-run');
    mkdirSync(jsDir, { recursive: true });
    const jsRun = spawnSync(process.execPath, [js.launcher, 'one', 'two'], { cwd: jsDir, encoding: 'utf8' });
    expect(jsRun.status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const nativeDir = join(out, 'native-run');
    mkdirSync(nativeDir, { recursive: true });
    const r = spawnSync(native.exe, ['one', 'two'], { cwd: nativeDir, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(['status 0 out hello native', 'cat fed through stdin', 'sh 3 oops', 'missing: not found onus-no-such-program', 'slow: other `sleep` did not finish within 200 ms', 'args 2', ''].join('\n'));
    expect(r.stdout).toBe(jsRun.stdout);
    expect(readFileSync(join(nativeDir, 'made', 'deep', 'dir', 'note.txt'), 'utf8')).toBe('hello native\n');
    expect(readFileSync(join(jsDir, 'made', 'deep', 'dir', 'note.txt'), 'utf8')).toBe('hello native\n');
  }, 120000);

  it('`io.now` is monotonic and since the start on both targets', () => {
    const out = fresh('clock');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'clock_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const jsRun = spawnSync(process.execPath, [js.launcher], { encoding: 'utf8' });
    expect(jsRun.stdout).toBe('ok\n');
    expect(jsRun.status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const r = spawnSync(native.exe, [], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('ok\n');
    expect(r.status).toBe(0);
  }, 120000);

  it('`io.exec` hands the child the standard streams on both targets', () => {
    const out = fresh('exec');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'exec_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const expected = 'from child\nstatus 3\nmissing: not found onus-no-such-program\n';
    const jsRun = spawnSync(process.execPath, [js.launcher], { encoding: 'utf8' });
    expect(jsRun.stdout).toBe(expected);
    expect(jsRun.status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const r = spawnSync(native.exe, [], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(expected);
    expect(r.status).toBe(0);
  }, 120000);

  it('`main` chooses its exit status on both targets (§8.3)', () => {
    const out = fresh('status');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'status_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const jsRun = spawnSync(process.execPath, [js.launcher], { encoding: 'utf8' });
    expect(jsRun.stdout).toBe('exiting with 3\n');
    expect(jsRun.stderr).toBe('');
    expect(jsRun.status).toBe(3);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const r = spawnSync(native.exe, [], { encoding: 'utf8' });
    expect(r.stdout).toBe('exiting with 3\n');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(3);
  }, 120000);

  it('`io.remove_all` removes trees and files on both targets', () => {
    const out = fresh('remove');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'remove_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const expected = 'tree gone\nfile gone\nabsent ok\n';
    const jsDir = join(out, 'js-run');
    mkdirSync(jsDir, { recursive: true });
    const jsRun = spawnSync(process.execPath, [js.launcher], { encoding: 'utf8', cwd: jsDir });
    expect(jsRun.stdout).toBe(expected);
    expect(jsRun.status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const nativeDir = join(out, 'native-run');
    mkdirSync(nativeDir, { recursive: true });
    const r = spawnSync(native.exe, [], { encoding: 'utf8', cwd: nativeDir });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(expected);
    expect(r.status).toBe(0);
    expect(existsSync(join(nativeDir, 'tree'))).toBe(false);
  }, 120000);

  it('`io.list_dir` lists names in code point order on both targets', () => {
    const out = fresh('list');
    const entry = join(repoRoot, 'packages', 'compiler', 'test', 'native', 'list_native.onus');
    const ctx = checked(entry);
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('js build failed');
    const expected = 'a.txt b.txt sub \u00e9.txt\nmissing: not found never-there\n';
    const jsDir = join(out, 'js-run');
    mkdirSync(jsDir, { recursive: true });
    const jsRun = spawnSync(process.execPath, [js.launcher], { encoding: 'utf8', cwd: jsDir });
    expect(jsRun.stdout).toBe(expected);
    expect(jsRun.status).toBe(0);
    const native = buildNative(ctx, { outDir: out });
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    if (native.exe === null) throw new Error('native build failed');
    const nativeDir = join(out, 'native-run');
    mkdirSync(nativeDir, { recursive: true });
    const r = spawnSync(native.exe, [], { encoding: 'utf8', cwd: nativeDir });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(expected);
    expect(r.status).toBe(0);
  }, 120000);

  it('every example passes on both targets', () => {
    for (const rel of ['examples/mandelbrot/mandelbrot.onus', 'packages/compiler/test/native/primitives.onus', 'packages/compiler/test/native/eq_recursive.onus', 'packages/compiler/test/native/dict.onus', 'packages/compiler/test/native/generics.onus', 'packages/compiler/test/native/text_native.onus', 'packages/compiler/test/native/function_values.onus', 'packages/compiler/test/native/old_native.onus', 'packages/compiler/test/codegen/features.onus', 'packages/compiler/test/stdlib/list_generic.onus', 'packages/compiler/test/verify/ok_interface_calls.onus']) {
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

  it('a Dict keyed by a record is E0800 on the native target (§19.1)', () => {
    const out = fresh('dict-key');
    const ctx = checked(join(here, 'e0800_dict_key.onus'));
    const native = buildNative(ctx, { outDir: out });
    expect(native.exe).toBeNull();
    const diags = ctx.sink.all();
    expect(diags.map((d) => d.code)).toEqual(['E0800']);
    expect(diags[0]?.context[0]).toContain('`Dict` keys of type `Point`');
  }, 60000);
});

if (clang === null) {
  it('notice: clang is not on PATH, native tests skipped', () => {
    process.stderr.write('onus tests: clang not found; native target tests skipped\n');
  });
}
