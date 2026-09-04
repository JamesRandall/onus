/**
 * Milestone 8 acceptance (impl spec §9): claims, capabilities and paths.
 * Fixtures produce their expected codes; the reporting example's
 * `monthly_report` passes; the checkout example's `checkout` passes with
 * exactly one external assumption (permitted by `except`), fails the policy
 * without the `except`, and fails the bound when a reachable effect leaves it.
 */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES } from '../../src/report/codes.js';
import { pathReport, pathText, type PathReport } from '../../src/report/path.js';
import { checkExpectation, fixturesIn, pipeline, type PipelineResult } from '../harness.js';
import { readFileSync as readSource } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, '..', '..', '..', '..', 'examples');
const schemaDir = join(here, '..', '..', 'src', 'report', 'schema');
const ajv = new Ajv({ allErrors: true, strict: true });
const validPath = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'path.schema.json'), 'utf8')));

function reportsOf(r: PipelineResult): PathReport[] {
  const file = r.ctx.files[0];
  return [...r.ctx.paths.analyses.values()].filter((a) => file !== undefined && r.ctx.resolve.moduleOf(a.module).file === file.id).map((a) => pathReport(r.ctx, a));
}

function example(name: string, edit: (text: string) => string = (t) => t): PipelineResult {
  const path = join(examplesDir, name, `${name}.onus`);
  return pipeline(path, edit(readFileSync(path, 'utf8')), null);
}

describe('claims, capabilities and paths fixtures', () => {
  const fixtures = fixturesIn(here);
  for (const f of fixtures) {
    it(f.name, () => {
      const { diagnostics } = pipeline(f.path, f.text, here);
      if (f.name.startsWith('ok_')) expect(diagnostics.map((d) => `${d.code} ${d.context.join(' ')}`)).toEqual([]);
      expect(checkExpectation(f.path, diagnostics)).toBeNull();
    });
  }

  it('every claims, path and capability code has a fixture', () => {
    const covered = new Set<string>();
    for (const f of fixtures) {
      const { diagnostics } = pipeline(f.path, f.text, here);
      for (const d of diagnostics) covered.add(d.code);
    }
    // E0603 is reported by `onus test --assumptions`, not the pipeline; its test lives in test/test.
    const codes = Object.keys(CODES).filter((c) => /^E0(20[3-9]|41|60)/.test(c) && c !== 'E0603');
    expect(codes.filter((c) => !covered.has(c))).toEqual([]);
  });
});

describe('policy verified_assumptions_only (§20.3)', () => {
  const path = join(here, 'e0416_unverified.onus');
  const text = readSource(path, 'utf8');
  it('passes with a current passing verification and fails with a stale one', () => {
    const first = pipeline(path, text, here);
    const key = first.ctx.claims.assumes[0]?.key;
    if (key === undefined) throw new Error('no assumption');
    const now = Date.parse('2026-09-04T12:00:00Z');
    const record = { target: 'staging', result: 'passed' as const, claim: 'e0416_unverified.Quiet', def: 'e0416_unverified.leaf' };
    const fresh = pipeline(path, text, here, 'paths', 500, { assumptions: { [key]: { ...record, at: '2026-09-03T12:00:00Z' } }, now: () => now });
    expect(fresh.diagnostics).toEqual([]);
    const stale = pipeline(path, text, here, 'paths', 500, { assumptions: { [key]: { ...record, at: '2026-08-01T12:00:00Z' } }, now: () => now });
    expect(stale.diagnostics.map((d) => d.code)).toEqual(['E0416']);
    const failed = pipeline(path, text, here, 'paths', 500, { assumptions: { [key]: { ...record, result: 'failed', at: '2026-09-04T00:00:00Z' } }, now: () => now });
    expect(failed.diagnostics.map((d) => d.code)).toEqual(['E0416']);
  });
});

describe('worked example paths (§18.2, §18.3)', () => {
  it('reporting: monthly_report passes', () => {
    const r = example('reporting');
    expect(r.diagnostics).toEqual([]);
    const [report] = reportsOf(r);
    expect(report?.path).toBe('monthly_report');
    expect(report?.ok).toBe(true);
    expect(validPath(report), JSON.stringify(validPath.errors)).toBe(true);
    expect(report?.effects.actual.every((e) => report.effects.bound?.includes(e))).toBe(true);
    expect(report?.reachable[0]).toBe('reporting.monthly_totals');
  });

  it('checkout: passes with exactly one external assumption', () => {
    const r = example('checkout');
    expect(r.diagnostics).toEqual([]);
    const [report] = reportsOf(r);
    expect(report?.ok).toBe(true);
    expect(validPath(report), JSON.stringify(validPath.errors)).toBe(true);
    expect(report?.claims).toEqual({ required: ['app.contracts.Idempotent'], satisfied: true });
    const external = report?.assumes.filter((a) => a.permitted_by === 'except') ?? [];
    expect(external.map((a) => a.at)).toEqual(['vendor.payments.charge']);
    expect(report?.assumes.every((a) => a.permitted_by !== null)).toBe(true);
    expect(report?.unresolvable_calls).toEqual([]);
    expect(report?.capabilities.map((c) => c.type)).toContain('sql.Db[ReadOnly]');
    expect(pathText(report ?? ({} as PathReport))).toContain('vendor.payments.charge: app.contracts.Idempotent');
  });

  it('checkout: removing the except fails the policy', () => {
    const r = example('checkout', (t) => t.replace(' except { vendor.payments.charge }', ''));
    expect(r.diagnostics.map((d) => d.code)).toEqual(['E0415']);
    const [report] = reportsOf(r);
    expect(report?.ok).toBe(false);
  });

  it('checkout: a reachable effect outside the bound fails it', () => {
    const r = example('checkout', (t) => t.replace('effects <= { sql.read, sql.write, io.net, io.clock, alloc }', 'effects <= { sql.read, io.net, io.clock, alloc }'));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.every((d) => d.code === 'E0412' && d.context[0]?.includes('sql.write'))).toBe(true);
    expect(r.diagnostics.map((d) => d.context[0]?.split('`')[1])).toContain('checkout.record_order');
  });
});
