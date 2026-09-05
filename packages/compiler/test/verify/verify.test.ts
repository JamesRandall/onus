/**
 * Milestone 6 acceptance (impl spec §9): verification fixtures produce the
 * expected diagnostics and obligation statuses; a pinned `proved` that
 * fails reports a counterexample; timeouts are E0501. Skipped with a notice
 * when z3 is not on PATH.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExpectation, fixturesIn, ledgerOf, pipeline } from '../harness.js';
import { findZ3 } from '../../src/verify/z3.js';

const here = dirname(fileURLToPath(import.meta.url));
const z3 = findZ3();
const examplesDir = join(here, '..', '..', '..', '..', 'examples');

describe.skipIf(z3 === null)('verification fixtures', () => {
  for (const f of fixturesIn(here)) {
    it(f.name, () => {
      const { ctx, diagnostics } = pipeline(f.path, f.text, here, 'verify', f.name.startsWith('e0501') ? 200 : 500);
      if (f.name.startsWith('ok_') || f.name.startsWith('checked_')) expect(diagnostics.map((d) => `${d.code} ${d.context.join(' ')}`)).toEqual([]);
      expect(checkExpectation(f.path, diagnostics, ledgerOf(ctx, f.path))).toBeNull();
    });
  }

  it('a failed pinned ensures carries a counterexample', () => {
    const path = join(here, 'e0302_ensures_pinned.onus');
    const { diagnostics } = pipeline(path, readFileSync(path, 'utf8'), here, 'verify');
    const d = diagnostics.find((x) => x.code === 'E0302');
    expect(d?.obligation?.counterexample).toBeDefined();
    expect(Object.keys(d?.obligation?.counterexample ?? {})).toContain('x');
  });

  it("mandelbrot's ledger has no checked obligation (§18.1)", () => {
    const path = join(examplesDir, 'mandelbrot', 'mandelbrot.onus');
    const { ctx, diagnostics } = pipeline(path, readFileSync(path, 'utf8'), null, 'verify');
    expect(diagnostics).toEqual([]);
    const entry = ctx.files[0];
    const mine = ctx.contracts.obligations.filter((o) => entry !== undefined && ctx.resolve.node(o.at).span.file === entry.id);
    expect(mine.length).toBeGreaterThan(20);
    const notProved = mine.filter((o) => o.status !== 'proved' && o.kind !== 'property' && o.kind !== 'representation' && o.kind !== 'assertion');
    expect(notProved.map((o) => `${o.kind} ${o.text} [${o.by ?? ''}]`)).toEqual([]);
  });
});

if (z3 === null) {
  it('notice: z3 is not on PATH, verification tests skipped', () => {
    process.stderr.write('onus tests: z3 not found; verification fixtures skipped\n');
  });
}
