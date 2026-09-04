/**
 * `onus test --assumptions` (§20.2, §20.6; CHANGE-LOG-02's M8 addition):
 * the checkout example's `Idempotent` assumption has a `verify` block that
 * passes against a fake payments service, and the path report then shows
 * it as verified. A verify parameter without a source is E0603.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { checkAssumptionPlan, parseOutcomes, planAssumptions, writeAssumptionsLauncher } from '../../src/codegen/assumptions.js';
import { emitAll, runtimeEntry } from '../../src/codegen/build.js';
import { runPipeline } from '../../src/driver.js';
import { pathReport } from '../../src/report/path.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const checkoutDir = join(here, '..', '..', '..', '..', 'examples', 'checkout');
const outDir = join(here, '..', '..', '.onus-tmp', 'assumptions');

function context(env: string | null): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  const entry = join(checkoutDir, 'checkout.onus');
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  if (env !== null) ctx.addFile(join(checkoutDir, env), readFileSync(join(checkoutDir, env), 'utf8'));
  return ctx;
}

describe('onus test --assumptions', () => {
  it("verifies checkout's Idempotent assumption against the fake environment and the path report shows it", () => {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const ctx = context('test_env.onus');
    runPipeline(ctx, 'paths');
    expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    const envFile = ctx.files[1];
    const env = ctx.resolve.modules.find((m) => envFile !== undefined && m.file === envFile.id) ?? null;
    const plan = planAssumptions(ctx, env);
    expect(plan.producers.size).toBe(2);
    const built = emitAll(ctx, { outDir, ts: false, verify: true });
    expect(checkAssumptionPlan(ctx, plan, built.emitted)).toBe(true);
    const launcher = writeAssumptionsLauncher(ctx, outDir, built.emitted, plan, runtimeEntry());
    const r = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    const outcomes = parseOutcomes(r.stdout);
    expect(outcomes.map((o) => [o.def, o.result])).toEqual([['vendor.payments.charge', 'passed']]);
    const key = outcomes[0]?.key ?? '';
    const verified = context('test_env.onus');
    const at = '2026-09-04T00:00:00Z';
    const ctx2 = new Context({ stdlib: STDLIB_ROOT, verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined, assumptions: { [key]: { at, target: 'local', result: 'passed', claim: 'app.contracts.Idempotent', def: 'vendor.payments.charge' } } });
    for (const f of verified.files) ctx2.addFile(f.path, f.text);
    runPipeline(ctx2, 'paths');
    const analysis = [...ctx2.paths.analyses.values()].find((a) => ctx2.resolve.def(a.def).name === 'checkout');
    if (analysis === undefined) throw new Error('no checkout path');
    const report = pathReport(ctx2, analysis);
    const charge = report.assumes.find((a) => a.at === 'vendor.payments.charge');
    expect(charge).toMatchObject({ verifiable: true, last_verified: { at, target: 'local', result: 'passed' } });
    expect(report.assumes.filter((a) => a.at !== 'vendor.payments.charge').every((a) => !a.verifiable && a.last_verified === null)).toBe(true);
  }, 60000);

  it('reports E0603 when the environment has no source for a verify parameter', () => {
    const ctx = context(null);
    runPipeline(ctx, 'paths');
    expect(ctx.sink.all()).toEqual([]);
    const built = emitAll(ctx, { outDir: join(outDir, 'noenv'), ts: false, verify: true });
    expect(checkAssumptionPlan(ctx, planAssumptions(ctx, null), built.emitted)).toBe(false);
    const codes = ctx.sink.all().map((d) => d.code);
    expect(codes).toEqual(['E0603', 'E0603']);
    expect(ctx.sink.all()[0]?.context[0]).toContain('vendor.payments.Client');
  }, 60000);
});
