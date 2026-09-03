/**
 * Resolution and type fixtures (impl spec §10, milestone 2): every fixture
 * produces exactly the diagnostics in its `.expect.json`. Fixtures are
 * modules under this directory (the project root); helper modules live in
 * `lib/`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExpectation, fixturesIn, pipeline } from '../harness.js';
import { CODES } from '../../src/report/codes.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Codes of later milestones (verification) that no fixture can produce yet. */
const LATER = new Set(['E0302']);
/** Reported by the parser; its fixture lives in test/syntax. */
const PARSER_REPORTED = new Set(['E0102']);

describe('checker fixtures', () => {
  const fixtures = fixturesIn(here);
  const seen = new Set<string>();
  for (const f of fixtures) {
    it(f.name, () => {
      const { diagnostics } = pipeline(f.path, f.text, here);
      for (const d of diagnostics) seen.add(d.code);
      expect(checkExpectation(f.path, diagnostics)).toBeNull();
    });
  }

  it('rejects a std.* module outside the standard library (E0112)', () => {
    const path = join(here, 'std', 'reserved.onus');
    const { diagnostics } = pipeline(path, readFileSync(path, 'utf8'), here);
    for (const d of diagnostics) seen.add(d.code);
    expect(diagnostics.map((d) => d.code)).toEqual(['E0112']);
  });

  it('covers every resolution and typing diagnostic code', () => {
    for (const f of fixtures) for (const d of pipeline(f.path, f.text, here).diagnostics) seen.add(d.code);
    const codes = Object.keys(CODES).filter((c) => /^E0[12357]/.test(c) && !LATER.has(c) && !PARSER_REPORTED.has(c));
    expect(codes.filter((c) => !seen.has(c))).toEqual([]);
  });
});
