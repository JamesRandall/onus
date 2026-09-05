/**
 * The differential harness (impl spec M12; language spec §19.5): every
 * fixture and example with `example` blocks is built for both targets;
 * those inside the native subset must agree on every example, and those
 * outside it must be refused with E0800 rather than miscompiled. Skipped
 * when `clang` is not on PATH.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, compareTargets, findClang, runJsExamples, runNativeExamples } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'differential');
const clang = findClang();

function sources(): string[] {
  const out: string[] = [];
  for (const dir of [join(here, '..', 'checker'), join(here, '..', 'paths'), join(here, '..', 'codegen'), join(here, '..', 'stdlib'), here]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.onus') || f.startsWith('e0') || f.startsWith('.')) continue;
      const path = join(dir, f);
      if (/^example |^\s*example /m.test(readFileSync(path, 'utf8'))) out.push(path);
    }
  }
  out.push(join(repoRoot, 'examples', 'mandelbrot', 'mandelbrot.onus'));
  return out;
}

describe.skipIf(clang === null)('differential testing across targets (§19.5)', () => {
  it('every fixture with examples agrees on both targets or is refused natively', () => {
    const agreed: string[] = [];
    const refused: string[] = [];
    for (const path of sources()) {
      const name = path.split('/').slice(-2).join('_').replace(/\.onus$/, '');
      const out = join(tmpRoot, name);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      const ctx = new Context({ stdlib: STDLIB_ROOT, root: dirname(path), verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
      ctx.addFile(path, readFileSync(path, 'utf8'));
      runPipeline(ctx, 'paths');
      if (ctx.sink.hasErrors()) continue; // not a program this suite asserts anything about
      emitAll(ctx, { outDir: out, ts: false });
      const native = buildNative(ctx, { outDir: out });
      const codes = ctx.sink.all().map((d) => d.code);
      if (native.exe === null) {
        expect(codes.every((c) => c === 'E0800'), `${name}: ${codes.join(', ')}`).toBe(true);
        refused.push(name);
        continue;
      }
      const nativeRun = runNativeExamples(native.exe);
      const js = runJsExamples(out);
      const shared = new Map([...nativeRun.results].filter(([k]) => js.has(k)));
      expect(compareTargets(ctx, js, shared), name).toBe(0);
      agreed.push(name);
    }
    process.stderr.write(`differential: ${agreed.length} agreed (${agreed.join(', ')}); ${refused.length} refused natively (${refused.join(', ')})\n`);
    expect(agreed.length).toBeGreaterThan(1);
  }, 600000);
});
