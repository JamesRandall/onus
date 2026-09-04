/**
 * Milestone 10 acceptance (impl spec §9): the review page renders the
 * compiler's reports. The checkout path renders with the assumed leaf
 * highlighted and the gate region drawn; the interface view collapses
 * bodies; diffs classify compatible and breaking changes.
 */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '@onus/review';
import { interfaceDiff } from '../../src/report/diff.js';
import { reviewData } from '../../src/report/review.js';
import { pipeline, type PipelineResult } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, '..', '..', '..', '..', 'examples');
const schemaDir = join(here, '..', '..', 'src', 'report', 'schema');
const ajv = new Ajv({ allErrors: true, strict: true });
const validDiff = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'interface-diff.schema.json'), 'utf8')));

function example(name: string, edit: (t: string) => string = (t) => t): PipelineResult {
  const path = join(examplesDir, name, `${name}.onus`);
  return pipeline(path, edit(readFileSync(path, 'utf8')), null);
}

describe('review page (§15)', () => {
  const r = example('checkout');
  const data = reviewData(r.ctx, null, '2026-09-03T00:00:00Z');
  const html = renderPage(data);

  it('renders the checkout path with the assumed leaf highlighted and the gate region drawn', () => {
    expect(r.diagnostics).toEqual([]);
    const path = data.paths.find((p) => p.path === 'checkout');
    expect(path?.gates).toEqual([{ evidence: 'app.auth.AuthedCustomer', producers: ['app.auth.require'], guarded: expect.arrayContaining(['checkout.load_basket', 'checkout.record_order', 'vendor.payments.charge']) }]);
    expect(path?.graph.edges.some((e) => e.from === 'checkout.handle_checkout' && e.to === 'vendor.payments.charge' && e.effects.includes('io.net'))).toBe(true);
    expect(html).toMatch(/<g class="node fn assumed" [^>]*data-id="vendor.payments.charge"/);
    expect(html).toMatch(/<g class="node entry" [^>]*data-id="checkout.handle_checkout"/);
    expect(html).toMatch(/<g class="node intrinsic" [^>]*data-id="std.sql.execute"/);
    expect(html).toContain('<rect class="gate"');
    expect(html).toContain('gate: app.auth.AuthedCustomer from app.auth.require');
    expect(html).toContain('ledger-row status-proved');
    expect(html).toContain('permitted by except');
    expect(html).toContain('verify(client: Client, service: auth.Service, clock: io.Clock) may io.net, alloc {');
    expect(html).toContain('assumed, unverified');
  });

  it('collapses bodies in the interface view and counts their opening', () => {
    expect(html).toContain('<details class="body" data-module="checkout" data-item="handle_checkout">');
    expect(html).toContain('data-total="4"');
    expect(html).toMatch(/<pre class="signature">pub fn handle_checkout\(/);
    expect(html).not.toContain('<script src=');
  });

  it('lists every module of the program, not the standard library', () => {
    expect(data.modules.map((m) => m.module).sort()).toEqual(['app.auth', 'app.contracts', 'checkout', 'vendor.payments']);
    expect(Object.keys(data.sources).sort()).toEqual(['app.auth', 'app.contracts', 'checkout', 'vendor.payments']);
  });

  it('includes only diagnostics when the program is invalid', () => {
    const bad = example('reporting', (t) => t.replace('effects <= { sql.read, alloc }', 'effects <= { alloc }'));
    const d = reviewData(bad.ctx, null, 'now');
    expect(d.diagnostics.length).toBeGreaterThan(0);
    expect(d.modules).toEqual([]);
    expect(renderPage(d)).toContain('E0412');
  });
});

describe('interface diff (§11.1, §15.1)', () => {
  const current = reviewData(example('reporting').ctx, null, 'now').modules.find((m) => m.module === 'reporting');
  if (current === undefined) throw new Error('reporting interface missing');

  it('is empty and compatible against itself', () => {
    const d = interfaceDiff(current, current);
    expect(validDiff(d), JSON.stringify(validDiff.errors)).toBe(true);
    expect(d).toMatchObject({ added: [], removed: [], changed: [], breaking: false });
  });

  it('classifies a removed ensures and a widened effect set as breaking', () => {
    const weaker = example('reporting', (t) => t.replace(' may sql.read, alloc\n  ensures forall t: MonthlyTotal in result: t.total_pence >= 0\n{', ' may sql.read, alloc {'));
    const next = reviewData(weaker.ctx, null, 'now').modules.find((m) => m.module === 'reporting');
    const d = interfaceDiff(current, next ?? current);
    expect(validDiff(d), JSON.stringify(validDiff.errors)).toBe(true);
    expect(d.breaking).toBe(true);
    const change = d.changed.find((c) => c.name === 'monthly_totals');
    expect(change?.contracts).toEqual([{ kind: 'ensures', text: 'forall t: MonthlyTotal in result: t.total_pence >= 0', change: 'removed', compatibility: 'breaking' }]);
    const reverse = interfaceDiff(next ?? current, current);
    expect(reverse.breaking).toBe(false);
    expect(reverse.changed[0]?.contracts[0]?.compatibility).toBe('compatible');
  });

  it('renders the diff view', () => {
    const removed = example('reporting', (t) => t.replace(' may sql.read, alloc\n  ensures forall t: MonthlyTotal in result: t.total_pence >= 0\n{', ' may sql.read, alloc {'));
    const html = renderPage(reviewData(removed.ctx, current, 'now'));
    expect(html).toContain('ensures removed');
    expect(html).toContain('breaking');
  });
});
