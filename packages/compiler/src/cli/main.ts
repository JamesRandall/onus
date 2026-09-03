#!/usr/bin/env node
/**
 * The `onus` command line (impl spec §2). Milestones 1–2 provide `check` and
 * `fmt`; the other commands report that they are not yet available.
 *
 * Exit codes: 0 success, 1 diagnostics reported, 2 usage or I/O failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '../context.js';
import { PASSES, runFrontEnd, runPipeline, type PassName } from '../driver.js';
import { toJson, toText } from '../report/diagnostic.js';
import { defaultStdlibRoot } from '../resolve/loader.js';
import { build, runLauncher } from '../codegen/build.js';
import { interfaceOf, interfaceText } from '../report/interface.js';
import { pathReport, pathText } from '../report/path.js';
import { next } from '../next/next.js';

const USAGE = `usage:
  onus check <file.onus>... [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>] [--budget <ms>] [--ledger] [--no-cache]
      report every diagnostic; exit 1 if any. Passes: ${PASSES.join(', ')}
  onus fmt <file.onus>... [--stdout]
      rewrite files in canonical form
  onus build <entry.onus> [--out <dir>] [--emit js|ts] [--root <dir>] [--stdlib <dir>]
      check, then emit JavaScript for every module into <dir> (default: <root>/out)
  onus run <entry.onus> [--out <dir>] [-- args...]
      build, then run the entry module's main
  onus interface <file.onus> [--json] [--root <dir>] [--stdlib <dir>] [--budget <ms>] [--no-cache]
      check, then print the entry module's interface: canonical source with bodies elided, or the §11.1 JSON
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

const VALUE_FLAGS: ReadonlySet<string> = new Set(['root', 'stdlib', 'to', 'out', 'emit', 'budget', 'offset']);

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

function newContext(args: Args): Context {
  const here = dirname(fileURLToPath(import.meta.url));
  const stdlib = args.values.get('stdlib') ?? defaultStdlibRoot(join(here, '..', '..'));
  const budget = Number(args.values.get('budget') ?? '500');
  const entry = args.files[0];
  const cacheDir = args.flags.has('no-cache') ? null : join(args.values.get('root') ?? (entry === undefined ? '.' : dirname(entry)), '.onus', 'cache');
  return new Context({ root: args.values.get('root') ?? null, stdlib, verify: { budgetMs: Number.isFinite(budget) && budget > 0 ? budget : 500, cacheDir, z3Path: null } });
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
  if (emit !== 'js' && emit !== 'ts') {
    process.stderr.write(`onus: --emit takes js or ts\n`);
    return 2;
  }
  const ctx = newContext(args);
  if (!readFiles(ctx, [entry])) return 2;
  const outDir = args.values.get('out') ?? join(dirname(entry), 'out');
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
  process.stdout.write(args.flags.has('json') ? `${JSON.stringify(interfaceOf(ctx, rec.id), null, 2)}\n` : interfaceText(ctx, rec.id));
  return 0;
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
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
