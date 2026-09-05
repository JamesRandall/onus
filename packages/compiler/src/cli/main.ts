#!/usr/bin/env node
/**
 * The `onus` command line (impl spec §2). Milestones 1–2 provide `check` and
 * `fmt`; the other commands report that they are not yet available.
 *
 * Exit codes: 0 success, 1 diagnostics reported, 2 usage or I/O failure.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../context.js';
import type { DefId } from '../resolve/defs.js';
import { PASSES, runFrontEnd, runPipeline, type PassName } from '../driver.js';
import { toJson, toText } from '../report/diagnostic.js';
import { defaultStdlibRoot } from '../resolve/loader.js';
import { build, runLauncher } from '../codegen/build.js';
import { interfaceOf, interfaceText } from '../report/interface.js';
import { pathReport, pathText, verifiedOf } from '../report/path.js';
import { next } from '../next/next.js';
import { diffText, interfaceDiff } from '../report/diff.js';
import { reviewData } from '../report/review.js';
import { renderPage } from '@onus/review';
import type { InterfaceDocument } from '../report/interface.js';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../config.js';
import { mergeCoverage, readCoverage, readLedger, readMutations, writeCoverage, writeLedger, writeMutations, type CoverageTable } from '../report/ledger.js';
import { coverageOf, coverageText, type CoverageJson } from '../report/coverage.js';
import { enumerateMutations, runMutations } from '../mutate/mutate.js';
import { findZ3 } from '../verify/z3.js';
import { checkAssumptionPlan, parseOutcomes, planAssumptions, writeAssumptionsLauncher } from '../codegen/assumptions.js';
import { emitAll, runtimeEntry } from '../codegen/build.js';
import { buildNative, compareTargets, runJsExamples, runNativeExamples } from '../codegen/native-build.js';
import { lowerModule } from '../codegen/lower.js';
import { printIr } from '../codegen/irtext.js';

const USAGE = `usage:
  onus check <file.onus>... [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>] [--budget <ms>] [--ledger] [--no-cache]
      report every diagnostic; exit 1 if any. Passes: ${PASSES.join(', ')}
  onus fmt <file.onus>... [--stdout]
      rewrite files in canonical form
  onus build <entry.onus> [--out <dir>] [--emit js|ts|ir] [--target js|native] [--root <dir>] [--stdlib <dir>]
      check, then emit JavaScript for every module into <dir> (default: <root>/out); --target native compiles
      an executable with clang into <dir>/native (§19); --emit ir prints the target-neutral form (fixture oracle)
  onus run <entry.onus> [--out <dir>] [--target js|native] [-- args...]
      build, then run the entry module's main
  onus interface <file.onus> [--json] [--diff <old-interface.json>] [--root <dir>] [--stdlib <dir>] [--budget <ms>] [--no-cache]
      check, then print the entry module's interface: canonical source with bodies elided, or the §11.1 JSON;
      with --diff, the changes since a previous interface document (§11.1, §15.1)
  onus review <entry.onus> [--out <dir>] [--against <old-interface.json>] [--root <dir>] [--stdlib <dir>] [--budget <ms>] [--no-cache]
      check, then write the review page (§15) and its data to <dir> (default: <entry dir>/review)
  onus test <entry.onus> [--out <dir>] [--target js|native|all] [--root <dir>] [--stdlib <dir>]
      build, then run the generated example, property and law tests (§20.6); --target all runs the examples on
      both targets and reports any disagreement as E0801 (§19.5)
  onus test <entry.onus> --assumptions [--env <test_module.onus>] [--target <name>] [--out <dir>]
      run every verify block against capabilities from the environment module and record the results in .onus/ledger/ (§20.2–§20.3)
  onus path <file.onus> [<name>] [--json] [--root <dir>] [--stdlib <dir>] [--budget <ms>] [--no-cache]
      check, then print the §9.1 report of the entry module's paths (or of the named one)
  onus next <file.onus> --offset <n> [--json] [--root <dir>] [--stdlib <dir>]
      the legal next tokens, expected type and names in scope at a UTF-16 offset (§14)
`;

interface Args {
  readonly command: string | null;
  readonly files: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['root', 'stdlib', 'to', 'out', 'emit', 'budget', 'offset', 'diff', 'against', 'env', 'target']);
const TARGETS: ReadonlySet<string> = new Set(['js', 'native', 'wasm', 'all']);

function parseArgs(argv: readonly string[]): Args {
  const files: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const v = argv[i + 1];
        if (v !== undefined) {
          values.set(name, v);
          i += 1;
        }
      } else {
        flags.add(name);
      }
    } else if (command === null) command = a;
    else files.push(a);
  }
  return { command, files, flags, values };
}

function readFiles(ctx: Context, paths: readonly string[]): boolean {
  for (const p of paths) {
    try {
      ctx.addFile(p, readFileSync(p, 'utf8'));
    } catch (e) {
      process.stderr.write(`onus: cannot read ${p}: ${e instanceof Error ? e.message : String(e)}\n`);
      return false;
    }
  }
  return true;
}

function emitDiagnostics(ctx: Context, json: boolean): void {
  for (const d of ctx.sink.all()) {
    process.stdout.write(json ? `${JSON.stringify(toJson(ctx, d))}\n` : `${toText(ctx, d)}\n`);
  }
}

function isPass(s: string): s is PassName {
  return (PASSES as readonly string[]).includes(s);
}

/** The project root: `--root`, else the entry file's directory. */
function rootOf(args: Args): string {
  const entry = args.files[0];
  return args.values.get('root') ?? (entry === undefined ? '.' : dirname(entry));
}

function newContext(args: Args): Context {
  const here = dirname(fileURLToPath(import.meta.url));
  const stdlib = args.values.get('stdlib') ?? defaultStdlibRoot(join(here, '..', '..'));
  const budget = Number(args.values.get('budget') ?? '500');
  const root = rootOf(args);
  const cacheDir = args.flags.has('no-cache') ? null : join(root, '.onus', 'cache');
  const config = readConfig(root);
  return new Context({
    root: args.values.get('root') ?? null,
    stdlib,
    verify: { budgetMs: Number.isFinite(budget) && budget > 0 ? budget : 500, cacheDir, z3Path: null },
    assumptions: readLedger(join(root, '.onus', 'ledger')),
    coverage: readCoverage(join(root, '.onus', 'ledger')),
    mutations: readMutations(join(root, '.onus', 'ledger')),
    assumptionMaxAgeMs: config.test.maxAssumptionAgeDays * 24 * 60 * 60 * 1000,
  });
}

/** Prints one line per obligation of the entry file's modules: the ledger (§11, §12.2). */
function printLedger(ctx: Context): void {
  const entryFile = ctx.files[0];
  for (const o of ctx.contracts.obligations) {
    const def = ctx.resolve.def(o.def);
    const site = ctx.resolve.node(o.at).span;
    if (entryFile !== undefined && site.file !== entryFile.id) continue;
    const at = toText(ctx, { code: 'E0001', title: '', def: null, span: site, obligation: null, context: [], repairs: [], canonicalHash: null }).split(': ')[0] ?? '';
    process.stdout.write(`${o.status.padEnd(8)} ${o.kind.padEnd(16)} ${at}  ${def.name}: ${o.text}${o.by ? `  [${o.by}]` : ''}\n`);
  }
}

function check(args: Args): number {
  if (args.files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const to = args.values.get('to') ?? 'paths';
  if (!isPass(to)) {
    process.stderr.write(`onus: unknown pass \`${to}\`; expected one of ${PASSES.join(', ')}\n`);
    return 2;
  }
  const ctx = newContext(args);
  if (!readFiles(ctx, args.files)) return 2;
  runPipeline(ctx, to);
  emitDiagnostics(ctx, args.flags.has('json'));
  if (args.flags.has('ledger')) printLedger(ctx);
  if (ctx.sink.hasErrors()) {
    if (!args.flags.has('json')) process.stdout.write(`${ctx.sink.count} error${ctx.sink.count === 1 ? '' : 's'}\n`);
    return 1;
  }
  return 0;
}

function fmt(args: Args): number {
  if (args.files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const ctx = new Context();
  if (!readFiles(ctx, args.files)) return 2;
  runFrontEnd(ctx);
  const syntaxErrors = ctx.sink.all().filter((d) => d.code !== 'E0001');
  if (syntaxErrors.length > 0) {
    for (const d of syntaxErrors) process.stdout.write(`${toText(ctx, d)}\n`);
    return 1;
  }
  for (const f of ctx.files) {
    const canonical = ctx.canonical.get(f.id);
    if (canonical === undefined) continue;
    if (args.flags.has('stdout')) process.stdout.write(canonical);
    else if (canonical !== f.text) writeFileSync(f.path, canonical, 'utf8');
  }
  return 0;
}

function buildCommand(args: Args, run: boolean): number {
  const entry = args.files[0];
  if (entry === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const emit = args.values.get('emit') ?? 'js';
  if (emit !== 'js' && emit !== 'ts' && emit !== 'ir') {
    process.stderr.write(`onus: --emit takes js, ts or ir\n`);
    return 2;
  }
  const target = args.values.get('target') ?? 'js';
  if (!TARGETS.has(target) || target === 'all') {
    process.stderr.write(`onus: --target takes js, native or wasm\n`);
    return 2;
  }
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  const outDir = resolve(args.values.get('out') ?? join(dirname(entry), 'out')); // vitest resolves `--config` against `--root`
  if (emit === 'ir') {
    runPipeline(ctx, 'paths');
    emitDiagnostics(ctx, args.flags.has('json'));
    if (ctx.sink.hasErrors()) return 1;
    for (const m of ctx.resolve.modules) if (!m.isStd) process.stdout.write(printIr(lowerModule(ctx, m, { verify: false }), ctx.resolve));
    return 0;
  }
  if (target === 'native' || target === 'wasm') {
    runPipeline(ctx, 'paths');
    if (!ctx.sink.hasErrors()) {
      const native = buildNative(ctx, { outDir, target });
      emitDiagnostics(ctx, args.flags.has('json'));
      if (ctx.sink.hasErrors() || native.exe === null) return 1;
      process.stderr.write(`onus build: wrote ${native.exe}\n`);
      if (!run) return 0;
      if (!native.hasMain) {
        process.stderr.write(`onus run: ${entry} declares no \`pub fn main\`\n`);
        return 2;
      }
      const r = target === 'wasm' ? spawnSync(process.execPath, [join(dirname(native.exe), 'run_wasm.mjs'), ...args.files.slice(1)], { stdio: 'inherit' }) : spawnSync(native.exe, args.files.slice(1), { stdio: 'inherit' });
      return r.status ?? 1;
    }
    emitDiagnostics(ctx, args.flags.has('json'));
    return 1;
  }
  const result = build(ctx, { outDir, ts: emit === 'ts' });
  emitDiagnostics(ctx, args.flags.has('json'));
  if (result === null) return 1;
  if (!run) return 0;
  if (result.launcher === null) {
    process.stderr.write(`onus run: ${entry} declares no \`pub fn main\`\n`);
    return 2;
  }
  return runLauncher(result.launcher, args.files.slice(1));
}

function interfaceCommand(args: Args): number {
  const entry = args.files[0];
  if (entry === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  runPipeline(ctx, 'paths');
  emitDiagnostics(ctx, args.flags.has('json'));
  if (ctx.sink.hasErrors()) return 1;
  const file = ctx.files[0];
  const rec = ctx.resolve.modules.find((m) => file !== undefined && m.file === file.id);
  if (rec === undefined) {
    process.stderr.write(`onus interface: ${entry} is not a module\n`);
    return 2;
  }
  const doc = interfaceOf(ctx, rec.id);
  const oldPath = args.values.get('diff');
  if (oldPath !== undefined) {
    const old = readInterface(oldPath);
    if (old === null) return 2;
    const d = interfaceDiff(old, doc);
    process.stdout.write(args.flags.has('json') ? `${JSON.stringify(d, null, 2)}\n` : diffText(d));
    return d.breaking ? 1 : 0;
  }
  process.stdout.write(args.flags.has('json') ? `${JSON.stringify(doc, null, 2)}\n` : interfaceText(ctx, rec.id));
  return 0;
}

/** Reads a previously written §11.1 document; the shape is trusted to the extent the diff reads it. */
function readInterface(path: string): InterfaceDocument | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isInterfaceDocument(parsed)) return parsed;
    process.stderr.write(`onus: ${path} is not an interface document\n`);
  } catch (e) {
    process.stderr.write(`onus: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  return null;
}

function isInterfaceDocument(v: unknown): v is InterfaceDocument {
  return typeof v === 'object' && v !== null && 'module' in v && typeof v.module === 'string' && 'hash' in v && 'items' in v && Array.isArray(v.items);
}

function reviewCommand(args: Args): number {
  const entry = args.files[0];
  if (entry === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const againstPath = args.values.get('against');
  const against = againstPath === undefined ? null : readInterface(againstPath);
  if (againstPath !== undefined && against === null) return 2;
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  runPipeline(ctx, 'paths');
  emitDiagnostics(ctx, args.flags.has('json'));
  const data = reviewData(ctx, against);
  const outDir = args.values.get('out') ?? join(dirname(entry), 'review');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), renderPage(data));
  writeFileSync(join(outDir, 'review.json'), `${JSON.stringify(data, null, 2)}\n`);
  process.stderr.write(`onus review: wrote ${join(outDir, 'index.html')}\n`);
  return ctx.sink.hasErrors() ? 1 : 0;
}

function pathCommand(args: Args): number {
  const entry = args.files[0];
  if (entry === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const wanted = args.files[1] ?? null;
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  runPipeline(ctx, 'paths');
  emitDiagnostics(ctx, args.flags.has('json'));
  const file = ctx.files[0];
  const reports = [...ctx.paths.analyses.values()]
    .filter((a) => file !== undefined && ctx.resolve.moduleOf(a.module).file === file.id)
    .filter((a) => wanted === null || ctx.resolve.def(a.def).name === wanted)
    .map((a) => pathReport(ctx, a));
  if (wanted !== null && reports.length === 0 && !ctx.sink.hasErrors()) {
    process.stderr.write(`onus path: no path \`${wanted}\` in ${entry}\n`);
    return 2;
  }
  for (const r of reports) process.stdout.write(args.flags.has('json') ? `${JSON.stringify(r, null, 2)}\n` : pathText(r));
  return ctx.sink.hasErrors() ? 1 : 0;
}

function nextCommand(args: Args): number {
  const entry = args.files[0];
  const offsetText = args.values.get('offset');
  if (entry === undefined || offsetText === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const offset = Number(offsetText);
  if (!Number.isInteger(offset) || offset < 0) {
    process.stderr.write(`onus next: --offset takes a non-negative integer\n`);
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(entry, 'utf8');
  } catch (e) {
    process.stderr.write(`onus: cannot read ${entry}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const result = next(newContext(args), entry, text, offset);
  if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`tokens: ${result.tokens.join(' ')}\nexpected: ${result.expectedType ?? '(none)'}\nin scope: ${result.inScope.join(', ')}\n`);
  return 0;
}

/** The coverage of the program's own obligations and assumptions (§20.5), for the `onus test` summary line. */
function programCoverage(ctx: Context, table: CoverageTable): CoverageJson {
  const t = ctx.resolve;
  const own = (def: DefId): boolean => !t.qualifiedName(def).startsWith('std.');
  const assumes = ctx.claims.assumes.filter((a) => own(a.fn)).map((a) => ({ verifiable: a.verify !== null, last_verified: verifiedOf(ctx, a.key) }));
  return coverageOf(ctx, ctx.contracts.obligations.filter((o) => own(o.def)), assumes, () => true, table);
}

/** `onus test --mutate` (§20.4): weakens contracts one at a time and reports the weakenings no test detects as M0001 rows. */
function mutateCommand(args: Args, entry: string): number {
  const root = rootOf(args);
  const outDir = resolve(args.values.get('out') ?? join(dirname(entry), 'out')); // vitest resolves `--config` against `--root`
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  runPipeline(ctx, 'paths');
  if (ctx.sink.hasErrors()) {
    emitDiagnostics(ctx, args.flags.has('json'));
    return 1;
  }
  const z3 = findZ3(ctx.options.verify.z3Path);
  if (z3 === null) process.stderr.write('onus test --mutate: z3 not found on PATH; only property guards are mutated\n');
  // A sibling of the build directory: the program's own test run must not see the mutated programs.
  const records = runMutations(ctx, enumerateMutations(ctx), { z3, budgetMs: ctx.options.verify.budgetMs, outDir: `${outDir}-mutate` });
  for (const r of records) process.stdout.write(`${r.detected ? 'detected' : 'M0001 undetected contract weakening'}: ${r.text} in ${r.def}: ${r.by}\n`);
  const surviving = records.filter((r) => !r.detected).length;
  process.stdout.write(`${records.length} contract mutation${records.length === 1 ? '' : 's'}: ${records.length - surviving} detected, ${surviving} surviving\n`);
  writeMutations(join(root, '.onus', 'ledger'), records, new Date(ctx.options.now()).toISOString());
  return 0;
}

function testCommand(args: Args): number {
  const entry = args.files[0];
  if (entry === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (args.flags.has('mutate')) return mutateCommand(args, entry);
  const root = rootOf(args);
  const config = readConfig(root);
  const outDir = resolve(args.values.get('out') ?? join(dirname(entry), 'out')); // vitest resolves `--config` against `--root`
  const ctx = newContext(args);
  const target = args.values.get('target') ?? 'js';
  if (!TARGETS.has(target)) {
    process.stderr.write(`onus: --target takes js, native or all\n`);
    return 2;
  }
  if (!args.flags.has('assumptions')) {
    if (!readFiles(ctx, [entry])) return 2;
    const result = build(ctx, { outDir, ts: false });
    emitDiagnostics(ctx, args.flags.has('json'));
    if (result === null) return 1;
    if (target === 'js') {
      if (!result.emitted.some((m) => m.tests !== null)) {
        process.stdout.write('onus test: no example, property or law to run\n');
        return 0;
      }
      const coverageDir = join(outDir, 'coverage');
      rmSync(coverageDir, { recursive: true, force: true });
      const r = spawnSync('npx', ['vitest', 'run', '--root', outDir, '--config', join(outDir, 'vitest.config.mjs')], { stdio: 'inherit', env: { ...process.env, ONUS_COVERAGE_DIR: coverageDir } });
      const ledgerDir = join(root, '.onus', 'ledger');
      const table = mergeCoverage(coverageDir, readCoverage(ledgerDir));
      writeCoverage(ledgerDir, table);
      process.stdout.write(`obligation coverage: ${coverageText(programCoverage(ctx, table))}\n`);
      return r.status ?? 1;
    }
    const native = buildNative(ctx, { outDir });
    emitDiagnostics(ctx, args.flags.has('json'));
    if (native.exe === null) return 1;
    const nativeRun = runNativeExamples(native.exe);
    process.stdout.write(nativeRun.output);
    if (target === 'native') return [...nativeRun.results.values()].every((ok) => ok) ? 0 : 1;
    const js = runJsExamples(outDir);
    for (const [name, ok] of js) process.stdout.write(`${ok ? 'ok' : 'FAIL'} ${name} (js)\n`);
    const disagreements = compareTargets(ctx, js, nativeRun.results);
    emitDiagnostics(ctx, args.flags.has('json'));
    const allOk = [...nativeRun.results.values()].every((ok) => ok) && [...js.values()].every((ok) => ok);
    return disagreements > 0 || !allOk ? 1 : 0;
  }
  const envPath = args.values.get('env') ?? (config.test.env === null ? null : join(root, config.test.env));
  if (!readFiles(ctx, envPath === null ? [entry] : [entry, envPath])) return 2;
  runPipeline(ctx, 'paths');
  if (ctx.sink.hasErrors()) {
    emitDiagnostics(ctx, args.flags.has('json'));
    return 1;
  }
  const envFile = envPath === null ? undefined : ctx.files.find((f) => f.path === envPath);
  const env = envFile === undefined ? null : (ctx.resolve.modules.find((m) => m.file === envFile.id) ?? null);
  const plan = planAssumptions(ctx, env);
  const built = emitAll(ctx, { outDir, ts: false, verify: true });
  if (!checkAssumptionPlan(ctx, plan, built.emitted)) {
    emitDiagnostics(ctx, args.flags.has('json'));
    return 1;
  }
  const launcher = writeAssumptionsLauncher(ctx, outDir, built.emitted, plan, runtimeEntry());
  const r = spawnSync(process.execPath, [launcher], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`onus test: the assumptions launcher failed\n${r.stderr}`);
    return 2;
  }
  const outcomes = parseOutcomes(r.stdout);
  const verifyTarget = args.values.get('target') ?? config.test.target;
  const at = new Date().toISOString();
  const ledgerDir = join(root, '.onus', 'ledger');
  const ledger = { ...readLedger(ledgerDir) };
  let failed = 0;
  for (const o of outcomes) {
    ledger[o.key] = { at, target: verifyTarget, result: o.result, claim: o.claim, def: o.def };
    if (o.result === 'failed') failed += 1;
    process.stdout.write(`${o.result.padEnd(7)} ${o.def}: ${o.claim}${o.detail === '' ? '' : ` (${o.detail})`}\n`);
  }
  writeLedger(ledgerDir, ledger);
  process.stdout.write(`${outcomes.length} assumption${outcomes.length === 1 ? '' : 's'} verified against ${verifyTarget}: ${outcomes.length - failed} passed, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'check':
      return check(args);
    case 'fmt':
      return fmt(args);
    case 'build':
      return buildCommand(args, false);
    case 'run':
      return buildCommand(args, true);
    case 'interface':
      return interfaceCommand(args);
    case 'path':
      return pathCommand(args);
    case 'next':
      return nextCommand(args);
    case 'review':
      return reviewCommand(args);
    case 'test':
      return testCommand(args);
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
