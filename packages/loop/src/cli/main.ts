#!/usr/bin/env node
/**
 * `onus-loop run <task.json>` (docs/onus-loop-v0.md §10): runs one task to
 * its conclusion. Exit codes: 0 change opened, 2 blocked, 1 error.
 * `watch` waits for task intake and is not in v0.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFiles } from '../env.js';
import { modelFromSpec } from '../model.js';
import { runTask } from '../cycle.js';
import { parseTask } from '../task.js';

const USAGE = `usage:
  onus-loop run <task.json> [--root <dir>] [--model claude-code[:<model>]|anthropic[:<model>]|openrouter[:<model>]|scripted:<file.json>] [--budget <ms>] [--json] [--no-write]
      run one task to its conclusion; exit 0 when a change is opened, 2 when blocked, 1 on error.
      Keys are read from the environment, or from .env and .env.local in the project root and the current directory:
      ANTHROPIC_API_KEY, OPENROUTER_API_KEY (and OPENROUTER_MODEL for the default model).
`;

interface Args {
  readonly command: string | undefined;
  readonly files: string[];
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const files: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const valued = new Set(['root', 'model', 'budget']);
  let command: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (valued.has(name) && next !== undefined) {
        values.set(name, next);
        i += 1;
      } else flags.add(name);
    } else if (command === undefined) command = a;
    else files.push(a);
  }
  return { command, files, flags, values };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command !== 'run' || args.files[0] === undefined) {
    process.stderr.write(USAGE);
    return args.command === 'watch' ? 2 : 1;
  }
  const taskPath = args.files[0];
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`onus-loop: cannot read ${taskPath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const parsed = parseTask(json);
  if ('error' in parsed) {
    process.stderr.write(`onus-loop: ${parsed.error}\n`);
    return 1;
  }
  const root = resolve(args.values.get('root') ?? '.');
  loadEnvFiles([root, process.cwd()]);
  const model = modelFromSpec(args.values.get('model') ?? 'claude-code');
  if (typeof model === 'string') {
    process.stderr.write(`onus-loop: ${model}\n`);
    return 1;
  }
  const budget = Number(args.values.get('budget') ?? '2000');
  const result = await runTask(parsed.task, { root, model, log: (line) => process.stderr.write(`${line}\n`), budgetMs: Number.isFinite(budget) ? budget : 2000, write: !args.flags.has('no-write') });
  if (result.status === 'error') {
    process.stderr.write(`onus-loop: ${result.error ?? 'error'}\n`);
    return 1;
  }
  const change = result.change;
  if (args.flags.has('json')) process.stdout.write(`${JSON.stringify(change)}\n`);
  else if (change !== null) {
    const m = change.metrics;
    process.stdout.write(`${change.status === 'opened' ? 'change opened' : `blocked (${change.cause ?? 'unknown'})`}: ${m.iterations} iteration${m.iterations === 1 ? '' : 's'}, ${m.mechanical_repairs} mechanical repair${m.mechanical_repairs === 1 ? '' : 's'}, ${m.escalation_steps} escalation step${m.escalation_steps === 1 ? '' : 's'}, ${m.proposals} proposal${m.proposals === 1 ? '' : 's'}, ${m.tokens} tokens\n`);
    for (const p of change.proposals) process.stdout.write(`  proposal ${p.kind} for ${p.def}: ${p.rationale}\n`);
    for (const f of change.audit) process.stdout.write(`  audit ${f.finding}: ${f.detail}\n`);
    if (result.path !== null) process.stdout.write(`  ${result.path}\n`);
  }
  return result.status === 'change' ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`onus-loop: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
