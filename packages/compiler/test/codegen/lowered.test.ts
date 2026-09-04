/**
 * The target-neutral form (impl spec §6, M11): the lowering of the fixture
 * suite and Mandelbrot is pinned as text, so a change in what generated
 * code does is a visible diff here, whichever emitter renders it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printIr } from '../../src/codegen/irtext.js';
import { lowerModule } from '../../src/codegen/lower.js';
import { pipeline } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const examplesDir = join(repoRoot, 'examples');

const SOURCES: readonly { name: string; path: string }[] = [
  { name: 'features', path: join(here, 'features.onus') },
  { name: 'mandelbrot', path: join(examplesDir, 'mandelbrot', 'mandelbrot.onus') },
  { name: 'checkout', path: join(examplesDir, 'checkout', 'checkout.onus') },
];

describe('the target-neutral form', () => {
  for (const src of SOURCES) {
    it(`${src.name} lowers to its pinned form`, () => {
      const r = pipeline(src.path, readFileSync(src.path, 'utf8'), null);
      expect(r.diagnostics).toEqual([]);
      const entryFile = r.ctx.files[0];
      const module = r.ctx.resolve.modules.find((m) => entryFile !== undefined && m.file === entryFile.id);
      if (module === undefined) throw new Error('entry module missing');
      const text = printIr(lowerModule(r.ctx, module, { verify: true }), r.ctx.resolve).split(repoRoot).join('<repo>');
      const golden = join(here, 'lowered', `${src.name}.ir.txt`);
      if (process.env['UPDATE_FIXTURES'] === '1' || !existsSync(golden)) {
        writeFileSync(golden, text);
        return;
      }
      expect(text).toBe(readFileSync(golden, 'utf8'));
    });
  }

  it('every runtime check names its obligation', () => {
    const path = join(here, 'features.onus');
    const r = pipeline(path, readFileSync(path, 'utf8'), null);
    const entryFile = r.ctx.files[0];
    const module = r.ctx.resolve.modules.find((m) => entryFile !== undefined && m.file === entryFile.id);
    if (module === undefined) throw new Error('entry module missing');
    const text = printIr(lowerModule(r.ctx, module, { verify: false }), r.ctx.resolve);
    const lines = text.split('\n');
    const checks = lines.filter((l) => l.trim().startsWith('check '));
    const checkedOps = lines.filter((l) => /[-+*/%]\? /.test(l));
    expect(checks.length + checkedOps.length).toBeGreaterThan(0);
    for (const c of checks) expect(c).toMatch(/\[(refinement|requires|ensures|overflow|invariant-entry|invariant-step|decreases) .+ @ \S+\]$/);
  });
});
