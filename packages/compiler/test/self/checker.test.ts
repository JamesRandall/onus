/**
 * Milestone 15.2 (impl spec): the checker in Onus (`self/check.onus`)
 * against the TypeScript checker, on every source in the repository. Both
 * run the pipeline up to the same pass; the diagnostics must agree in code,
 * file and span (in code points). The order may differ: the checker in Onus
 * checks refinement predicates from a queue rather than where the type is
 * elaborated, so both lists are compared sorted.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { runPipeline, type PassName } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');

/** The last pass the checker in Onus implements. */
const TO: PassName = 'effects';

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

/** The TypeScript pipeline's diagnostics up to `TO`, one line each: code, path, start, end in code points. */
function expectedLines(path: string, text: string): string {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root: null, log: () => undefined });
  ctx.addFile(path, text);
  runPipeline(ctx, TO);
  const lines: string[] = [];
  for (const d of ctx.sink.all()) {
    const f = ctx.fileOf(d.span);
    const cp = (offset: number): number => Array.from(f.text.slice(0, offset)).length;
    lines.push(`${d.code}\t${f.path}\t${cp(d.span.start)}\t${cp(d.span.end)}`);
  }
  return lines.sort().map((l) => `${l}\n`).join('');
}

describe('the checker in Onus (M15.2)', () => {
  const out = join(tmpRoot, 'check');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'check.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for check');
  const launcher = built.launcher;

  it(`agrees with the TypeScript checker up to ${TO} on every source in the repository`, () => {
    const files = sources();
    const disagreements: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const r = spawnSync(process.execPath, [launcher, path, '--stdlib', STDLIB_ROOT, '--to', TO], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) {
        disagreements.push(`${path}: check exited ${r.status}: ${r.stderr.slice(0, 800)}`);
        continue;
      }
      const got = r.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => l.split('\t').slice(0, 4).join('\t'))
        .sort()
        .map((l) => `${l}\n`)
        .join('');
      const want = expectedLines(path, text);
      if (got !== want) disagreements.push(`${path}:\n--- onus:\n${got}--- typescript:\n${want}`);
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 900000);
});
