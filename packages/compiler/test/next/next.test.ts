/**
 * Milestone 9 acceptance (impl spec §9): at every token of every canonical
 * fixture and example, the legal set contains the token actually present;
 * expected types are correct at hand-picked positions; locals in scope are
 * reported.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { lex } from '../../src/lexer/lexer.js';
import { isNameKind } from '../../src/lexer/tokens.js';
import { next, tokenName } from '../../src/next/next.js';
import { DiagnosticSink } from '../../src/report/diagnostic.js';
import { legalTokensAt } from '../../src/syntax/parser.js';
import { fixturesIn, STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, '..', '..', '..', '..', 'examples');

function sources(): { name: string; path: string; text: string }[] {
  const out = fixturesIn(join(here, '..', 'roundtrip')).map((f) => ({ name: f.name, path: f.path, text: f.text }));
  for (const e of ['mandelbrot/mandelbrot.onus', 'reporting/reporting.onus', 'checkout/checkout.onus']) {
    const path = join(examplesDir, e);
    out.push({ name: e, path, text: readFileSync(path, 'utf8') });
  }
  out.push({ name: 'positions.onus', path: join(here, 'positions.onus'), text: readFileSync(join(here, 'positions.onus'), 'utf8') });
  return out;
}

describe('legal tokens (§14)', () => {
  for (const src of sources()) {
    it(`${src.name}: the token present is legal at every position`, () => {
      const ctx = new Context();
      const file = ctx.addFile(src.path, src.text);
      const tokens = lex(file, new DiagnosticSink()).tokens.filter((t) => t.kind !== 'comment' && !(t.kind === 'nl' && t.span.start === t.span.end));
      const misses: string[] = [];
      let checked = 0;
      for (const t of tokens) {
        const legal = legalTokensAt(file, t.span.start);
        checked += 1;
        const ok = legal.has(t.kind) || (isNameKind(t.kind) && legal.has('name'));
        if (!ok) misses.push(`${t.span.start}: ${t.kind} ${JSON.stringify(t.text)} not in {${[...legal].join(' ')}}`);
      }
      expect(checked).toBeGreaterThan(2);
      expect(misses).toEqual([]);
    });
  }

  it('reports the decoder vocabulary', () => {
    expect(tokenName('name')).toBe('ident');
    expect(tokenName('int')).toBe('literal:int');
    expect(tokenName('fn')).toBe('fn');
  });
});

describe('expected types and scope (§14)', () => {
  const path = join(here, 'positions.onus');
  const text = readFileSync(path, 'utf8');
  const after = (marker: string, occurrence = 0): number => {
    let from = 0;
    for (let i = 0; i <= occurrence; i++) {
      const at = text.indexOf(marker, from);
      if (at < 0) throw new Error(`marker not found: ${marker}`);
      from = at + marker.length;
    }
    return from;
  };
  const at = (offset: number) => next(new Context({ stdlib: STDLIB_ROOT, log: () => undefined }), path, text, offset);

  const cases: [string, string, number?][] = [
    ['return Point { x: ', 'Int'],
    ['return Point { x: p.x * k, y: ', 'Int where it >= 0'],
    ['fn scale(p: Point, k: Int where it > 0) -> Point {\n  return ', 'Point'],
    ['| Dot(at) -> return ', 'Text'],
    ['| Dot(at) -> return name ++ ', 'Text'],
    ['var total: Int where it >= 0 = ', 'Int where it >= 0'],
    ['let bumped: Int = ', 'Int'],
    ['let bumped: Int = x + ', 'Int'],
    ['total = ', 'Int where it >= 0'],
    ['total = total + ', 'Int'],
    ['let maybe: Option[Text] = ', 'Option[Text]'],
    ['let r: Result[Int, Text] = ', 'Result[Int, Text]'],
    ['let r: Result[Int, Text] = Ok(value: ', 'Int'],
    ['  return total', 'Int where it >= 0', 0],
    ['let p: Point = ', 'Point'],
    ['let p: Point = scale(p: ', 'Point'],
    ['let p: Point = scale(p: Point { x: 1, y: 2 }, k: ', 'Int where it > 0'],
    ['let t: Text = label(s: ', 'Shape'],
    ['let t: Text = label(s: Dot(at: ', 'Point'],
    ['let n: Int = measure(xs: [1, 2], ratio: ', 'Float'],
    ['let n: Int = measure(xs: [1, 2], ratio: 0.5, flag: ', 'Bool'],
    ['let n: Int = measure(xs: ', 'List[Int]'],
    ['return Ok(value: ', 'Unit'],
  ];
  for (const [marker, expected, occurrence] of cases) {
    it(`after ${JSON.stringify(marker.slice(-30))}: ${expected}`, () => {
      const offset = marker === '  return total' ? after(marker, occurrence ?? 0) - 'total'.length : after(marker, occurrence ?? 0);
      expect(at(offset).expectedType).toBe(expected);
    });
  }

  it('lists the locals in scope, outermost first', () => {
    const r = at(after('total = total + '));
    expect(r.inScope).toEqual(['xs', 'ratio', 'flag', 'total', 'x', 'bumped']);
    expect(r.tokens).toContain('ident');
    expect(r.tokens).toContain('literal:int');
    expect(r.tokens).not.toContain('newline');
  });

  it('has no expected type outside expression position', () => {
    const r = at(after('let bumped: '));
    expect(r.expectedType).toBeNull();
    expect(r.tokens).toContain('type-ident');
  });

  it('offers statement starters at the start of a line in a block', () => {
    const r = at(after('  var total: Int where it >= 0 = 0\n'));
    expect(r.tokens).toEqual(expect.arrayContaining(['let', 'var', 'return', 'if', 'match', 'loop', 'for', 'ident', '}']));
  });
});
