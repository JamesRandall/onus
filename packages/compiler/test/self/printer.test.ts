/**
 * Milestone 15.1 (impl spec): the canonical printer in Onus
 * (`self/printer.onus`, driven by `self/fmt.onus`) against the TypeScript
 * printer, on every source in the repository. A source without syntax
 * errors must print byte-for-byte identically (spec §2.2: one canonical
 * form); a source with syntax errors must be refused by both.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { runDriver, selfDriver } from './driver.js';
import { runPipeline } from '../../src/driver.js';
import { DiagnosticSink, toText } from '../../src/report/diagnostic.js';
import { parse } from '../../src/syntax/parser.js';
import { print } from '../../src/syntax/printer.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');

function checked(entry: string, root: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root, verify: { budgetMs: 3000, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

function sources(): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'node_modules' || f === 'dist' || f === 'out') continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) visit(p);
      else if (f.endsWith('.onus')) out.push(p);
    }
  };
  for (const d of ['examples', 'packages/compiler/test', 'packages/stdlib/std', 'packages/loop/test', 'self']) visit(join(repoRoot, d));
  return out.sort();
}

/** The TypeScript printer's canonical form of `text`, or null when it has syntax errors. */
function expectedForm(path: string, text: string): string | null {
  const ctx = new Context({ log: () => undefined });
  const file = ctx.addFile(path, text);
  const sink = new DiagnosticSink();
  const r = parse(file, sink);
  if (r.module === null || sink.all().length > 0) return null;
  return print(r.module, r.comments);
}

describe('the printer in Onus (M15.1)', () => {
  const out = join(tmpRoot, 'fmt');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'fmt.onus'), selfRoot);
  const driver = selfDriver(ctx, out, 'fmt');

  it('prints every source in the repository exactly as the TypeScript printer does', () => {
    const files = sources();
    const disagreements: string[] = [];
    let compared = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const want = expectedForm(path, text);
      const r = runDriver(driver, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (want === null) {
        if (r.status === 0) disagreements.push(`${path}: has syntax errors but fmt printed it`);
        continue;
      }
      if (r.status !== 0) {
        disagreements.push(`${path}: fmt exited ${r.status}: ${r.stderr.slice(0, 500)}`);
        continue;
      }
      compared += 1;
      if (r.stdout !== want) {
        const a = r.stdout;
        let i = 0;
        while (i < a.length && i < want.length && a[i] === want[i]) i += 1;
        disagreements.push(`${path}: first difference at ${i}\n--- onus:       ${JSON.stringify(a.slice(Math.max(0, i - 120), i + 160))}\n--- typescript: ${JSON.stringify(want.slice(Math.max(0, i - 120), i + 160))}`);
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 900000);
});
