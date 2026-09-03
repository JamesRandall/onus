#!/usr/bin/env node
/**
 * The `onus` command line (impl spec §2). Milestone 1 provides `check` and
 * `fmt`; the other commands report that they are not yet available.
 *
 * Exit codes: 0 success, 1 diagnostics reported, 2 usage or I/O failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Context } from '../context.js';
import { runFrontEnd } from '../driver.js';
import { toJson, toText } from '../report/diagnostic.js';

const USAGE = `usage:
  onus check <file.onus>... [--json]     report every diagnostic; exit 1 if any
  onus fmt <file.onus>... [--stdout]     rewrite files in canonical form
  onus build | run | interface | path | next   (later milestones)
`;

interface Args {
  readonly command: string | null;
  readonly files: readonly string[];
  readonly flags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): Args {
  const files: string[] = [];
  const flags = new Set<string>();
  let command: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else if (command === null) command = a;
    else files.push(a);
  }
  return { command, files, flags };
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

function check(args: Args): number {
  if (args.files.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  const ctx = new Context();
  if (!readFiles(ctx, args.files)) return 2;
  runFrontEnd(ctx);
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

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'check':
      return check(args);
    case 'fmt':
      return fmt(args);
    case 'build':
    case 'run':
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
