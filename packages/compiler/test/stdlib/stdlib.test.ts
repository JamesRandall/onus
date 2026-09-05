/**
 * Milestone 15.0 (impl spec): the standard library a compiler needs. Every
 * std module checks with its own examples passing at check time; the
 * fixtures here run the new functions as generated tests on JavaScript
 * (the differential harness runs them natively too); and a program reads a
 * file back through `io.read` and writes to the console on both targets.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, findClang, runJsExamples } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'stdlib');
const clang = findClang();

function checked(entry: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: dirname(entry), verify: { budgetMs: 2000, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('the standard library (M15.0)', () => {
  it('every std module checks, with its examples passing at check time', () => {
    for (const f of readdirSync(join(STDLIB_ROOT, 'std'))) {
      if (!f.endsWith('.onus') || f.startsWith('.')) continue;
      checked(join(STDLIB_ROOT, 'std', f));
    }
  });

  for (const name of ['text_ops', 'list_ops', 'list_generic', 'map_ops']) {
    it(`${name}: the examples pass as generated tests`, () => {
      const ctx = checked(join(here, `${name}.onus`));
      const out = fresh(name);
      emitAll(ctx, { outDir: out, ts: false });
      const results = runJsExamples(out, true);
      expect(results.size).toBeGreaterThan(0);
      expect([...results].filter(([, ok]) => !ok).map(([n]) => n)).toEqual([]);
    }, 60000);
  }

  it('a program reads a file back and prints on the console, on both targets', () => {
    const ctx = checked(join(here, 'io_program.onus'));
    const out = fresh('io_program');
    const js = emitAll(ctx, { outDir: out, ts: false });
    if (js.launcher === null) throw new Error('no launcher');
    const jsDir = join(out, 'js-run');
    mkdirSync(jsDir, { recursive: true });
    const r = spawnSync(process.execPath, [js.launcher], { cwd: jsDir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('3 parts\n');
    expect(r.stderr).toBe('done\n');
    expect(readFileSync(join(jsDir, 'roundtrip.txt'), 'utf8')).toBe('one\ntwo\n');
    if (clang === null) return;
    const native = buildNative(ctx, { outDir: out });
    const diags = ctx.sink.all().map((d) => toText(ctx, d));
    expect(native.exe, diags.join('\n')).not.toBeNull();
    if (native.exe === null) return;
    const nativeDir = join(out, 'native-run');
    mkdirSync(nativeDir, { recursive: true });
    const n = spawnSync(native.exe, [], { cwd: nativeDir, encoding: 'utf8' });
    expect(n.status, n.stderr).toBe(0);
    expect(n.stdout).toBe('3 parts\n');
    expect(n.stderr).toBe('done\n');
  }, 120000);
});
