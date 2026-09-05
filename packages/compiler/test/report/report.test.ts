/**
 * Milestone 7 acceptance (impl spec §9): interface documents and diagnostics
 * validate against the schemas in `src/report/schema/`, and the text rendering
 * of an interface is valid, canonical Onus with every body elided.
 */
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { interfaceOf, interfaceText, type InterfaceDocument } from '../../src/report/interface.js';
import { toJson, type DiagnosticJson } from '../../src/report/diagnostic.js';
import { parse } from '../../src/syntax/parser.js';
import { print } from '../../src/syntax/printer.js';
import { walk } from '../../src/syntax/walk.js';
import { findZ3 } from '../../src/verify/z3.js';
import { fixturesIn, frontEnd, pipeline, type PipelineResult } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', '..', 'src', 'report', 'schema');
const examplesDir = join(here, '..', '..', '..', '..', 'examples');
const ajv = new Ajv({ allErrors: true, strict: true });
const validDiagnostic = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'diagnostic.schema.json'), 'utf8')));
const validInterface = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'interface.schema.json'), 'utf8')));
const z3 = findZ3();

function errorsOf(validate: { errors?: unknown[] | null }): string {
  return JSON.stringify(validate.errors ?? []);
}

function entryInterface(r: PipelineResult): InterfaceDocument {
  const file = r.ctx.files[0];
  const rec = r.ctx.resolve.modules.find((m) => file !== undefined && m.file === file.id);
  if (rec === undefined) throw new Error('entry module not loaded');
  return interfaceOf(r.ctx, rec.id);
}

function entryText(r: PipelineResult): string {
  const file = r.ctx.files[0];
  const rec = r.ctx.resolve.modules.find((m) => file !== undefined && m.file === file.id);
  if (rec === undefined) throw new Error('entry module not loaded');
  return interfaceText(r.ctx, rec.id);
}

describe('interface documents (§11.1)', () => {
  for (const name of ['mandelbrot', 'reporting', 'checkout']) {
    const path = join(examplesDir, name, `${name}.onus`);
    it(`${name}: JSON validates against the schema`, () => {
      const r = pipeline(path, readFileSync(path, 'utf8'), null);
      expect(r.diagnostics).toEqual([]);
      const doc = entryInterface(r);
      expect(validInterface(doc), errorsOf(validInterface)).toBe(true);
      expect(doc.module).toBe(name);
      expect(doc.items.length).toBeGreaterThan(0);
    });

    it(`${name}: text rendering is canonical Onus with bodies elided`, () => {
      const r = pipeline(path, readFileSync(path, 'utf8'), null);
      const text = entryText(r);
      const ctx = new Context();
      const file = ctx.addFile(`${name}.interface.onus`, text);
      const parsed = parse(file, ctx.sink);
      expect(ctx.sink.all()).toEqual([]);
      if (parsed.module === null) throw new Error('no module');
      let bodies = 0;
      walk(parsed.module, (n) => {
        if (n.kind === 'FnDecl' && n.body !== null) {
          bodies += 1;
          expect(n.body.elided).toBe(true);
        }
        return true;
      });
      expect(bodies).toBeGreaterThan(0);
      expect(print(parsed.module, parsed.comments)).toBe(text);
    });
  }

  it('reporting: monthly_totals carries its effects, contracts and counts', () => {
    const path = join(examplesDir, 'reporting', 'reporting.onus');
    const doc = entryInterface(pipeline(path, readFileSync(path, 'utf8'), null));
    expect(doc.imports).toContain('std.sql');
    const item = doc.items.find((i) => i.name === 'monthly_totals');
    expect(item?.kind).toBe('fn');
    expect(item?.visibility).toBe('pub');
    expect(item?.signature.startsWith('fn monthly_totals(')).toBe(true);
    expect(item?.effects).toContain('sql.read');
    expect(item?.effects).toContain('alloc');
    expect(item?.contracts.map((c) => c.kind)).toContain('ensures');
    expect(doc.obligations.proved + doc.obligations.checked + doc.obligations.assumed + doc.obligations.failed).toBe(doc.ledger.length);
  });

  it('checkout: the assumption is listed with its function and justification', () => {
    const path = join(examplesDir, 'checkout', 'checkout.onus');
    const doc = entryInterface(pipeline(path, readFileSync(path, 'utf8'), null));
    expect(doc.assumes.map((a) => [a.def, a.claim])).toEqual([
      ['load_basket', 'Idempotent'],
      ['record_order', 'Idempotent'],
    ]);
    expect(doc.assumes.every((a) => a.justification.length > 0)).toBe(true);
    const owner = doc.items.find((i) => i.name === 'record_order');
    expect(owner?.assumes.length).toBe(1);
  });

  it('mandelbrot: examples and the property are reported under their function', () => {
    const path = join(examplesDir, 'mandelbrot', 'mandelbrot.onus');
    const doc = entryInterface(pipeline(path, readFileSync(path, 'utf8'), null));
    const item = doc.items.find((i) => i.name === 'escape_count');
    expect(item?.examples.length).toBeGreaterThan(0);
    expect(item?.examples.every((e) => e.status === 'passed')).toBe(true);
    expect(doc.items.some((i) => i.kind === 'example' && i.name === 'escape_count')).toBe(false);
    const prop = doc.items.find((i) => i.kind === 'property' && i.name === 'escape_bounded');
    expect(prop?.properties.length).toBe(1);
    expect(prop?.properties[0]?.status).toBe('checked');
    if (z3 !== null) expect(doc.ledger.filter((l) => l.status === 'checked' && l.kind !== 'representation').length).toBe(1);
  });
});

describe('diagnostics JSON (§13)', () => {
  const dirs: { dir: string; run: (path: string, text: string, dir: string) => PipelineResult }[] = [
    { dir: join(here, '..', 'syntax'), run: (p, t) => frontEnd(p, t) },
    { dir: join(here, '..', 'checker'), run: (p, t, d) => pipeline(p, t, d, 'contracts') },
  ];
  if (z3 !== null) dirs.push({ dir: join(here, '..', 'verify'), run: (p, t, d) => pipeline(p, t, d, 'verify') });
  for (const { dir, run } of dirs) {
    it(`every diagnostic of ${dir.split('/').pop() ?? dir} fixtures validates`, () => {
      const all: DiagnosticJson[] = [];
      for (const f of fixturesIn(dir)) {
        const r = run(f.path, f.text, dir);
        for (const d of r.ctx.sink.all()) {
          const j = toJson(r.ctx, d);
          expect(validDiagnostic(j), `${f.name}: ${errorsOf(validDiagnostic)}`).toBe(true);
          all.push(j);
        }
      }
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((d) => d.canonical_hash !== undefined)).toBe(true);
    });
  }

  it.skipIf(z3 === null)('a failed pinned ensures carries its counterexample', () => {
    const dir = join(here, '..', 'verify');
    const path = join(dir, 'e0302_ensures_pinned.onus');
    const r = pipeline(path, readFileSync(path, 'utf8'), dir);
    const d = r.ctx.sink.all().map((x) => toJson(r.ctx, x)).find((x) => x.code === 'E0302');
    expect(d?.obligation?.counterexample).not.toBeNull();
    expect(d?.location.def).toBe('halve');
  });
});
