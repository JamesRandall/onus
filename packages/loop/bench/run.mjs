#!/usr/bin/env node
// Benchmarks the regeneration loop (docs/onus-loop-v0.md) on a fixed task
// against one or more models, printing one Markdown table row per run in
// the format of docs/BENCHMARK.md, and appending them with --append.
//
//   node packages/loop/bench/run.mjs mandelbrot openrouter:deepseek/deepseek-v4-flash claude-code --append docs/BENCHMARK.md
//
// Keys come from the environment or the repository's .env.local. Each run
// works in a fresh copy of the example under .onus-tmp/bench/, so the
// repository is never modified; the change and every prompt and answer
// stay there for reading.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles, modelFromSpec, parseTask, runTask } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const TASKS = {
  mandelbrot: {
    describe: 'implement `mandelbrot.escape_count` from its interface, body elided',
    files: [join(repo, 'examples', 'mandelbrot', 'mandelbrot.onus')],
    task: { kind: 'implement', scope: ['mandelbrot'], target: { def: 'mandelbrot.escape_count' } },
  },
};

const argv = process.argv.slice(2);
const taskName = argv[0];
const specs = [];
let append = null;
let iterations = 6;
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i] === '--append') append = argv[++i];
  else if (argv[i] === '--iterations') iterations = Number(argv[++i]);
  else specs.push(argv[i]);
}
const task = TASKS[taskName];
if (task === undefined || specs.length === 0) {
  console.error(`usage: node packages/loop/bench/run.mjs <${Object.keys(TASKS).join('|')}> <model-spec>... [--append docs/BENCHMARK.md] [--iterations 6]`);
  process.exit(1);
}
loadEnvFiles([repo]);
const day = new Date().toISOString().slice(0, 10);
const rows = [];
for (const spec of specs) {
  const model = modelFromSpec(spec);
  if (typeof model === 'string') {
    console.error(model);
    continue;
  }
  const root = join(repo, '.onus-tmp', 'bench', taskName, model.name.replace(/[^A-Za-z0-9.-]/g, '_'));
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const f of task.files) cpSync(f, join(root, f.split('/').pop()));
  const parsed = parseTask({ id: 'bench', ...task.task, budget: { iterations, tokens: 400000, wall_ms: 900000 } });
  const t0 = Date.now();
  const r = await runTask(parsed.task, { root, model, log: (l) => console.error(`[${model.name}] ${l}`), budgetMs: 2000, cacheDir: join(repo, '.onus-tmp', 'bench', 'cache') });
  const ms = Date.now() - t0;
  const c = r.change;
  const result = r.status === 'change' ? 'green' : r.status === 'blocked' ? `blocked, ${c?.cause ?? '?'}` : `error: ${(r.error ?? '').split('\n')[0].slice(0, 60)}`;
  const first = c?.trace[0];
  const note = c === null ? '' : first === undefined ? '' : first.classification === 'green' ? 'first answer accepted' : `first answer: ${first.codes_after.slice(0, 3).join(', ') || 'failing tests'}${c.trace.length > 1 ? `; ${c.trace.length - 1} more` : ''}`;
  const row = `| ${day} | ${taskName} | \`${model.name}\` | ${result} | ${c?.metrics.iterations ?? 0} | ${(ms / 1000).toFixed(1)} s | ${c?.metrics.tokens ?? 0} | ${note} |`;
  rows.push(row);
  console.log(row);
}
if (append !== null && rows.length > 0) {
  if (!existsSync(append)) throw new Error(`${append} does not exist`);
  const text = readFileSync(append, 'utf8');
  appendFileSync(append, `${text.endsWith('\n') ? '' : '\n'}${rows.join('\n')}\n`);
  console.error(`appended ${rows.length} row${rows.length === 1 ? '' : 's'} to ${append}`);
}
