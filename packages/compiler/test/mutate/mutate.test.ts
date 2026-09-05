/**
 * Milestone 13 (impl spec; language spec §20.4, §20.5): contract mutation
 * and obligation coverage. Dropping the `ensures` on the Mandelbrot escape
 * count is detected by its property; a deliberately unexercised result
 * refinement survives and is reported; negating a guard is detected only
 * when the guard matters; and a test run records which checked obligations
 * it reached. Static mutations need z3.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { runPipeline } from '../../src/driver.js';
import { enumerateMutations, runMutations } from '../../src/mutate/mutate.js';
import { checkSite, coverageOf } from '../../src/report/coverage.js';
import { interfaceOf } from '../../src/report/interface.js';
import { mergeCoverage, type MutationRecord } from '../../src/report/ledger.js';
import { toText } from '../../src/report/diagnostic.js';
import { findZ3 } from '../../src/verify/z3.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'mutate');
const z3 = findZ3();

function checked(entry: string, extra: { coverage?: Readonly<Record<string, number>>; mutations?: readonly MutationRecord[] } = {}): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: dirname(entry), verify: { budgetMs: 2000, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined, ...extra });
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

describe('contract mutation (§20.4)', () => {
  it.skipIf(z3 === null)('dropping the ensures on escape_count is detected by its property', () => {
    const ctx = checked(join(repoRoot, 'examples', 'mandelbrot', 'mandelbrot.onus'));
    const plans = enumerateMutations(ctx).filter((p) => p.kind !== 'negate-guard');
    const records = runMutations(ctx, plans, { z3, budgetMs: 2000, outDir: fresh('mandelbrot') });
    const drop = records.find((r) => r.kind === 'drop-ensures' && r.def === 'mandelbrot.escape_count');
    expect(drop?.detected).toBe(true);
    expect(drop?.by).toContain('escape_bounded');
  }, 120000);

  it.skipIf(z3 === null)('a deliberately unexercised result refinement survives and is reported', () => {
    const ctx = checked(join(here, 'unexercised.onus'));
    const plans = enumerateMutations(ctx).filter((p) => p.kind === 'widen-return' && p.def === 'unexercised.half');
    expect(plans).toHaveLength(1);
    const records = runMutations(ctx, plans, { z3, budgetMs: 2000, outDir: fresh('unexercised-static') });
    expect(records.map((r) => [r.def, r.detected])).toEqual([['unexercised.half', false]]);
  }, 60000);

  it('negating a guard is detected when the guard matters and survives when it does not', () => {
    const ctx = checked(join(here, 'unexercised.onus'));
    const plans = enumerateMutations(ctx).filter((p) => p.kind === 'negate-guard');
    const records = runMutations(ctx, plans, { z3: null, budgetMs: 2000, outDir: fresh('unexercised-guards') });
    expect(records.map((r) => [r.def, r.detected]).sort()).toEqual([
      ['unexercised.half_is_smaller', true],
      ['unexercised.plus_zero', false],
    ]);
  }, 120000);

  it('the records feed the interface report', () => {
    const mutations: MutationRecord[] = [
      { kind: 'widen-return', def: 'unexercised.half', text: 'widen', detected: false, by: 'nothing depends on it' },
      { kind: 'negate-guard', def: 'unexercised.half_is_smaller', text: 'negate', detected: true, by: 'fails' },
      { kind: 'drop-ensures', def: 'other.f', text: 'drop', detected: false, by: 'nothing' },
    ];
    const ctx = checked(join(here, 'unexercised.onus'), { mutations });
    const module = ctx.resolve.modules.find((m) => m.name === 'unexercised');
    if (module === undefined) throw new Error('module');
    const doc = interfaceOf(ctx, module.id);
    expect(doc.obligation_coverage.mutations_detected).toBe(1);
    expect(doc.obligation_coverage.mutations_surviving).toBe(1);
  });
});

describe('obligation coverage (§20.5)', () => {
  it('a test run records which checked obligations it reached', () => {
    const entry = join(here, 'unexercised.onus');
    const ctx = checked(entry);
    const out = fresh('coverage');
    emitAll(ctx, { outDir: out, ts: false });
    const coverageDir = join(out, 'coverage');
    const r = spawnSync('npx', ['vitest', 'run', '--root', out, '--config', join(out, 'vitest.config.mjs')], { encoding: 'utf8', env: { ...process.env, CI: '1', ONUS_COVERAGE_DIR: coverageDir } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const table = mergeCoverage(coverageDir, {});
    const own = ctx.contracts.obligations.filter((o) => ctx.resolve.qualifiedName(o.def).startsWith('unexercised.'));
    const stepResult = own.find((o) => o.kind === 'refinement' && o.status === 'checked' && ctx.resolve.def(o.def).name === 'step');
    expect(stepResult).toBeDefined();
    if (stepResult !== undefined) expect(table[checkSite(ctx, stepResult)] ?? 0).toBeGreaterThan(0);
    const c = coverageOf(ctx, own, [], () => true, table);
    expect(c.checked).toBeGreaterThan(0);
    expect(c.checked_exercised).toBe(c.checked);
    expect(coverageOf(ctx, own, [], () => true, {}).checked_exercised).toBe(0);
  }, 120000);
});
