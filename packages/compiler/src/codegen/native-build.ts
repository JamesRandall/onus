/**
 * `onus build --target native` (impl spec M11; language spec §19): lowers
 * every module, emits one LLVM IR file, and has `clang` compile and link it
 * against the C runtime. Also the differential check of §19.5: the same
 * examples run on both targets, and any disagreement is `E0801`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '../context.js';
import { diagnostic } from '../report/diagnostic.js';
import { fileId, span as mkSpan } from '../source.js';
import { runtimeEntry } from './build.js';
import { lowerModule } from './lower.js';
import { emitNative } from './native.js';

export interface NativeBuildOptions {
  readonly outDir: string;
  /** Extra `clang` flags, e.g. `-DONUS_BROKEN_INT_TO_TEXT` for the differential test. */
  readonly cflags?: readonly string[];
  readonly clang?: string;
}

export interface NativeBuildResult {
  /** The executable, or null when the program reaches constructs the native backend does not compile (E0800). */
  readonly exe: string | null;
  readonly ll: string;
  readonly examples: readonly string[];
  readonly hasMain: boolean;
}

/** The directory holding `onus.c` and `onus.h`. Effects: none. */
export function nativeRuntimeDir(): string {
  return join(dirname(runtimeEntry()), '..', 'native');
}

/** The `clang` executable, or null when none is on PATH. Effects: spawns `clang --version`. */
export function findClang(explicit: string | null = null): string | null {
  const path = explicit ?? 'clang';
  const r = spawnSync(path, ['--version'], { encoding: 'utf8' });
  return r.error === undefined && r.status === 0 ? path : null;
}

/**
 * Builds the native executable for `ctx`'s program.
 * Preconditions: the pipeline ran to `paths` without diagnostics.
 * Effects: writes `<outDir>/native/program.ll` and the executable; reports
 * E0800 for unsupported constructs and E0999 when `clang` rejects the IR.
 */
export function buildNative(ctx: Context, opts: NativeBuildOptions): NativeBuildResult {
  const modules = ctx.resolve.modules.map((m) => lowerModule(ctx, m, { verify: false }));
  const entryFile = ctx.files[0];
  const entry = modules.find((m) => entryFile !== undefined && m.module.file === entryFile.id) ?? null;
  const program = emitNative(ctx, modules, entry);
  const dir = join(opts.outDir, 'native');
  mkdirSync(dir, { recursive: true });
  const ll = join(dir, 'program.ll');
  writeFileSync(ll, program.ll);
  for (const u of program.unsupported) {
    ctx.sink.report(diagnostic({ code: 'E0800', span: u.span, def: u.def.split('.').pop() ?? null, context: [`\`${u.def}\` uses ${u.what}, which the native target does not provide in v0 (§19.1)`] }));
  }
  if (program.unsupported.length > 0) return { exe: null, ll, examples: program.examples, hasMain: program.hasMain };
  const exe = join(dir, entry === null ? 'program' : entry.module.name.replace(/\./g, '_'));
  const clang = findClang(opts.clang ?? null);
  if (clang === null) {
    ctx.sink.report(diagnostic({ code: 'E0999', span: mkSpan(ctx.files[0]?.id ?? fileId(0), 0, 0), context: ['`clang` is not on PATH; the native target needs it (impl spec M11)'] }));
    return { exe: null, ll, examples: program.examples, hasMain: program.hasMain };
  }
  const runtime = nativeRuntimeDir();
  const r = spawnSync(clang, ['-O1', '-Wno-override-module', '-o', exe, ll, join(runtime, 'onus.c'), '-I', runtime, '-lm', ...(opts.cflags ?? [])], { encoding: 'utf8' });
  if (r.status !== 0) {
    ctx.sink.report(diagnostic({ code: 'E0999', span: mkSpan(ctx.files[0]?.id ?? fileId(0), 0, 0), context: ['clang rejected the generated IR; this is a compiler bug, please report it', ...(r.stderr ?? '').split('\n').slice(0, 20)] }));
    return { exe: null, ll, examples: program.examples, hasMain: program.hasMain };
  }
  return { exe, ll, examples: program.examples, hasMain: program.hasMain };
}

/**
 * Runs the native examples and returns each example's outcome by qualified name.
 * Effects: spawns the executable.
 */
export function runNativeExamples(exe: string): { results: Map<string, boolean>; output: string } {
  const r = spawnSync(exe, ['--onus-examples'], { encoding: 'utf8' });
  const results = new Map<string, boolean>();
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^(ok|FAIL) (.+)$/.exec(line);
    if (m !== null && m[2] !== undefined) results.set(m[2], m[1] === 'ok');
  }
  return { results, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * Runs the generated vitest examples with the JSON reporter and returns each
 * example's outcome by qualified name; properties and laws are not examples.
 * Effects: spawns vitest.
 */
export function runJsExamples(outDir: string): Map<string, boolean> {
  const report = join(outDir, 'examples.report.json');
  spawnSync('npx', ['vitest', 'run', '--root', outDir, '--config', join(outDir, 'vitest.config.mjs'), '--reporter=json', `--outputFile=${report}`], { encoding: 'utf8', env: { ...process.env, CI: '1' } });
  const results = new Map<string, boolean>();
  if (!existsSync(report)) return results;
  const parsed: unknown = JSON.parse(readFileSync(report, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('testResults' in parsed) || !Array.isArray(parsed.testResults)) return results;
  for (const file of parsed.testResults) {
    if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string' || !('assertionResults' in file) || !Array.isArray(file.assertionResults)) continue;
    const rel = file.name.slice(outDir.length + 1).replace(/\.examples\.test\.[jt]s$/, '');
    const module = rel.split('/').join('.');
    for (const a of file.assertionResults) {
      if (typeof a !== 'object' || a === null || !('title' in a) || typeof a.title !== 'string' || !('status' in a)) continue;
      if (a.title.startsWith('property ') || a.title.startsWith('law ')) continue;
      results.set(`${module}.${a.title}`, a.status === 'passed');
    }
  }
  return results;
}

/**
 * Compares example outcomes across targets (§19.5): a disagreement on a
 * program the compiler accepted is a backend defect.
 * Effects: reports E0801 per disagreement.
 */
export function compareTargets(ctx: Context, js: ReadonlyMap<string, boolean>, native: ReadonlyMap<string, boolean>): number {
  let disagreements = 0;
  for (const [name, nativeOk] of native) {
    const jsOk = js.get(name);
    if (jsOk === undefined || jsOk === nativeOk) continue;
    disagreements += 1;
    const dot = name.lastIndexOf('.');
    const moduleName = name.slice(0, dot);
    const example = name.slice(dot + 1);
    const module = ctx.resolve.modules.find((m) => m.name === moduleName);
    const def = module === undefined ? undefined : ctx.resolve.membersOf(module.id).tests.get(example);
    const span = def === undefined ? mkSpan(ctx.files[0]?.id ?? fileId(0), 0, 0) : ctx.resolve.def(def).span;
    ctx.sink.report(diagnostic({ code: 'E0801', span, def: example, context: [`example \`${name}\` ${jsOk ? 'passes' : 'fails'} on js and ${nativeOk ? 'passes' : 'fails'} on native; the targets must agree (§19.5)`] }));
  }
  return disagreements;
}
