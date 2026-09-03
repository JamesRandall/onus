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

const USAGE = `usage:
  onus check <file.onus>... [--json] [--root <dir>] [--stdlib <dir>] [--to <pass>]
      report every diagnostic; exit 1 if any. Passes: ${PASSES.join(', ')}
  onus fmt <file.onus>... [--stdout]
      rewrite files in canonical form
  onus build <entry.onus> [--out <dir>] [--emit js|ts] [--root <dir>] [--stdlib <dir>]
      check, then emit JavaScript for every module into <dir> (default: <root>/out)
  onus run <entry.onus> [--out <dir>] [-- args...]
      build, then run the entry module's main
  onus interface | path | next   (later milestones)
`;

interface Args {
  readonly command: string | null;
  readonly files: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['root', 'stdlib', 'to', 'out', 'emit']);

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
  return new Context({ root: args.values.get('root') ?? null, stdlib });
}

function check(args: Args): number {
  if (args.files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const to = args.values.get('to') ?? 'contracts';
  if (!isPass(to)) {
    process.stderr.write(`onus: unknown pass \`${to}\`; expected one of ${PASSES.join(', ')}\n`);
    return 2;
  }
  const ctx = newContext(args);
  if (!readFiles(ctx, args.files)) return 2;
  runPipeline(ctx, to);
  emitDiagnostics(ctx, args.flags.has('json'));
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
    case 'path':
    case 'next':
      process.stderr.write(`onus ${args.command}: not available until a later milestone\n`);
      return 2;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
