/**
 * The module verification cache (impl spec §7.3): a module verified once
 * without a diagnostic is replayed on the next check with the same text,
 * imports, solver and budget, with an identical ledger; a change to the
 * module invalidates its entry; a module that reports a diagnostic is never
 * stored. Skipped with a notice when z3 is not on PATH.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { runPipeline } from '../../src/driver.js';
import { findZ3 } from '../../src/verify/z3.js';
import { ModuleCache, moduleKeys } from '../../src/verify/modcache.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const z3 = findZ3();

function check(path: string, text: string, cacheDir: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, verify: { budgetMs: 500, cacheDir, z3Path: null }, log: () => undefined });
  ctx.addFile(path, text);
  runPipeline(ctx, 'verify');
  return ctx;
}

function ledger(ctx: Context): string[] {
  return ctx.contracts.obligations.map((o) => `${o.kind}\t${o.text}\t${o.status}\t${o.by ?? '-'}`);
}

function entries(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.module.json')).sort();
}

describe.skipIf(z3 === null)('the module verification cache', () => {
  it('replays a module verified before with the same ledger, and invalidates when the module changes', () => {
    if (z3 === null) return;
    const dir = mkdtempSync(join(tmpdir(), 'onus-modcache-'));
    try {
      const path = join(here, 'ok_match_join.onus');
      const text = readFileSync(path, 'utf8');
      const first = check(path, text, dir);
      expect(first.sink.all()).toEqual([]);
      const keys = moduleKeys(first, 'ts', z3.version, 500);
      const entry = first.resolve.modules.find((m) => m.file === first.files[0]?.id);
      expect(entry).toBeDefined();
      const key = entry === undefined ? '' : (keys.get(entry.id) ?? '');
      const stored = new ModuleCache(dir).get(key);
      expect(stored).not.toBeNull();
      expect(stored?.obligations.length).toBe(first.contracts.obligations.filter((o) => entry !== undefined && first.resolve.def(o.def).module === entry.id).length);
      const stock = entries(dir);
      // Second run: a replay, same ledger, no new entry.
      const second = check(path, text, dir);
      expect(second.sink.all()).toEqual([]);
      expect(ledger(second)).toEqual(ledger(first));
      expect(entries(dir)).toEqual(stock);
      // A changed module gets a new key, so a new entry, and the same ledger.
      const changed = `${text}\n-- a comment changes the canonical text\n`;
      const third = check(path, changed, dir);
      expect(third.sink.all()).toEqual([]);
      expect(ledger(third)).toEqual(ledger(first));
      expect(entries(dir).length).toBe(stock.length + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never stores a module whose verification reported a diagnostic', () => {
    if (z3 === null) return;
    const dir = mkdtempSync(join(tmpdir(), 'onus-modcache-'));
    try {
      const path = join(here, 'e0343_needs_panic.onus');
      const ctx = check(path, readFileSync(path, 'utf8'), dir);
      expect(ctx.sink.all().length).toBeGreaterThan(0);
      const keys = moduleKeys(ctx, 'ts', z3.version, 500);
      const entry = ctx.resolve.modules.find((m) => m.file === ctx.files[0]?.id);
      const key = entry === undefined ? '' : (keys.get(entry.id) ?? '');
      expect(new ModuleCache(dir).get(key)).toBeNull();
      // Its dependencies verified cleanly and are stored.
      expect(entries(dir).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

if (z3 === null) {
  it('notice: z3 is not on PATH, module cache tests skipped', () => {
    process.stderr.write('onus tests: z3 not found; module cache tests skipped\n');
  });
}
