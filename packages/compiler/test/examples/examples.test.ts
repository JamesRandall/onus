/**
 * The three worked examples (language spec §18) as integration tests.
 * Milestone 1: they parse and are canonical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontEnd } from '../harness.js';
import { toText } from '../../src/report/diagnostic.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, '..', '..', '..', '..', 'examples');

const EXAMPLES = ['mandelbrot/mandelbrot.onus', 'reporting/reporting.onus', 'checkout/checkout.onus'];

describe('worked examples', () => {
  for (const rel of EXAMPLES) {
    it(`${rel} parses and is canonical`, () => {
      const path = join(examplesDir, rel);
      const { ctx } = frontEnd(path, readFileSync(path, 'utf8'));
      expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
    });
  }
});
