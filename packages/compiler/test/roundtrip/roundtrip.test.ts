/**
 * Round-trip properties of the canonical printer (impl spec §3.2):
 *
 *   parse(print(parse(s))) == parse(s)         for every fixture
 *   print(parse(s)) == print(parse(print(parse(s))))   (idempotent)
 *   print(parse(messy)) == canonical            for each messy/canonical pair
 *   print(parse(s)) == s                        for every canonical fixture
 */
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { parse } from '../../src/syntax/parser.js';
import { print } from '../../src/syntax/printer.js';
import { equalIgnoringSpans, firstDifference } from '../../src/syntax/equal.js';
import { toText } from '../../src/report/diagnostic.js';
import { fixturesIn } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));

function parseText(path: string, text: string) {
  const ctx = new Context();
  const file = ctx.addFile(path, text);
  const result = parse(file, ctx.sink);
  return { ctx, result };
}

describe('canonical fixtures', () => {
  const fixtures = fixturesIn(here);
  it('has at least 30 fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
  });

  for (const f of fixtures) {
    describe(f.name, () => {
      it('parses without diagnostics', () => {
        const { ctx } = parseText(f.path, f.text);
        expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
      });

      it('is its own canonical form', () => {
        const { result } = parseText(f.path, f.text);
        if (result.module === null) throw new Error('no module');
        expect(print(result.module, result.comments)).toBe(f.text);
      });

      it('round-trips through print and parse', () => {
        const a = parseText(f.path, f.text);
        if (a.result.module === null) throw new Error('no module');
        const printed = print(a.result.module, a.result.comments);
        const b = parseText(f.path, printed);
        expect(b.ctx.sink.all().map((d) => toText(b.ctx, d))).toEqual([]);
        if (b.result.module === null) throw new Error('no module after reprint');
        const diff = firstDifference(a.result.module, b.result.module);
        expect(diff).toBeNull();
        expect(equalIgnoringSpans(a.result.module, b.result.module)).toBe(true);
        expect([...b.result.comments.entries()]).toEqual([...a.result.comments.entries()]);
        expect(print(b.result.module, b.result.comments)).toBe(printed);
      });
    });
  }
});

describe('messy fixtures canonicalise', () => {
  const messyDir = join(here, 'messy');
  for (const f of fixturesIn(messyDir).filter((x) => !x.name.endsWith('.canonical.onus'))) {
    it(f.name, () => {
      const canonicalPath = f.path.replace(/\.onus$/, '.canonical.onus');
      const expected = fixturesIn(messyDir).find((x) => x.path === canonicalPath);
      if (expected === undefined) throw new Error(`missing ${canonicalPath}`);
      const { ctx, result } = parseText(f.path, f.text);
      expect(ctx.sink.all().map((d) => toText(ctx, d))).toEqual([]);
      if (result.module === null) throw new Error('no module');
      expect(print(result.module, result.comments)).toBe(expected.text);
      // And the canonical file is itself canonical.
      const again = parseText(canonicalPath, expected.text);
      if (again.result.module === null) throw new Error('no module');
      expect(print(again.result.module, again.result.comments)).toBe(expected.text);
      expect(equalIgnoringSpans(again.result.module, result.module)).toBe(true);
    });
  }
});
