/**
 * Milestone 15.1 (impl spec): the lexer in Onus (`self/lexer.onus`) against
 * the TypeScript lexer, on every fixture and example in the repository.
 * The Onus lexer counts positions in code points; the TypeScript one in
 * UTF-16 units, converted here. Its own examples run as generated tests,
 * and the dump program is also built natively when clang is present.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, findClang, runJsExamples } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { lex } from '../../src/lexer/lexer.js';
import { DiagnosticSink, toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const selfRoot = join(repoRoot, 'self');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'self');
const clang = findClang();

function checked(entry: string, root: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, root, verify: { budgetMs: 3000, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

/** Every `.onus` file the repository holds, fixtures and examples alike. */
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

/** The dump the TypeScript lexer would print for `text`, positions in code points. */
function expectedDump(path: string, text: string): string {
  const ctx = new Context({ log: () => undefined });
  const file = ctx.addFile(path, text);
  const sink = new DiagnosticSink();
  const r = lex(file, sink);
  const cp = (offset: number): number => Array.from(text.slice(0, offset)).length;
  const lines: string[] = [];
  for (const t of r.tokens) {
    const where = ` ${cp(t.span.start)} ${cp(t.span.end)}`;
    switch (t.kind) {
      case 'name':
      case 'tname':
        lines.push(`${t.kind}${where} ${t.text}`);
        break;
      case 'int':
        // Digits as written: past 2^53 the JavaScript runtime's Int cannot hold the value (docs/CHANGES.md item 99).
        lines.push(`int${where} ${t.text.replace(/_/g, '')}`);
        break;
      case 'duration':
        lines.push(`duration${where} ${String(t.value)}`);
        break;
      case 'float':
        lines.push(`float${where} ${String(t.value)}`);
        break;
      case 'text':
        lines.push(`text${where} ${Array.from(String(t.value), (c) => String(c.codePointAt(0) ?? 0)).join(',')}`);
        break;
      default:
        lines.push(`${t.kind}${where}`);
    }
  }
  for (const c of r.comments) lines.push(`comment ${cp(c.span.start)} ${cp(c.span.end)} ${c.ownLine}`);
  for (const d of sink.all()) lines.push(`${d.code} ${cp(d.span.start)} ${cp(d.span.end)}`);
  return `${lines.join('\n')}\n`;
}

describe('the lexer in Onus (M15.1)', () => {
  const out = join(tmpRoot, 'lexdump');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const ctx = checked(join(selfRoot, 'lexdump.onus'), selfRoot);
  const built = emitAll(ctx, { outDir: out, ts: false });
  if (built.launcher === null) throw new Error('no launcher for lexdump');
  const launcher = built.launcher;

  it('its own examples pass as generated tests', () => {
    const results = runJsExamples(out, true);
    expect(results.size).toBeGreaterThan(0);
    expect([...results].filter(([, ok]) => !ok).map(([n]) => n)).toEqual([]);
  }, 120000);

  it('agrees with the TypeScript lexer on every source in the repository', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(50);
    const disagreements: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      const r = spawnSync(process.execPath, [launcher, path], { encoding: 'utf8' });
      if (r.status !== 0) {
        disagreements.push(`${path}: lexdump exited ${r.status}: ${r.stderr}`);
        continue;
      }
      if (r.stdout !== expectedDump(path, text)) disagreements.push(`${path}:\n--- onus\n${r.stdout.slice(0, 600)}\n--- typescript\n${expectedDump(path, text).slice(0, 600)}`);
    }
    expect(disagreements, disagreements.join('\n\n')).toEqual([]);
  }, 600000);

  it.skipIf(clang === null)('builds natively and agrees on the Mandelbrot example', () => {
    const native = buildNative(ctx, { outDir: out });
    const diags = ctx.sink.all().map((d) => toText(ctx, d));
    expect(native.exe, diags.join('\n')).not.toBeNull();
    if (native.exe === null) return;
    const path = join(repoRoot, 'examples', 'mandelbrot', 'mandelbrot.onus');
    const r = spawnSync(native.exe, [path], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(expectedDump(path, readFileSync(path, 'utf8')));
  }, 300000);
});
