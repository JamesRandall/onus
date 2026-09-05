/**
 * Milestone 14 (impl spec; docs/onus-loop-v0.md §2, §4–§6, §8, §9): the
 * regeneration loop with a scripted model, one case per task kind and per
 * stopping cause. Cases that need the verifier's counterexamples are
 * skipped without z3. A live run against Claude Code is behind
 * `ONUS_LOOP_LIVE=1`.
 */
import { describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { findZ3 } from '@onus/compiler';
import { ScriptedModel, loadEnvFiles, modelFromSpec, parseEnv, parseTask, runTask, type Task } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const tmpRoot = join(here, '..', '.onus-tmp');
const z3 = findZ3();
const cacheDir = join(tmpRoot, 'cache');

function fixture(name: string, run: string): string {
  const dir = join(tmpRoot, run);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(join(here, 'fixtures', name), dir, { recursive: true });
  return dir;
}

function task(over: Partial<Task> & { kind: Task['kind'] }): Task {
  const parsed = parseTask({ id: over.id ?? 'task_test', kind: over.kind, scope: over.scope ?? ['calc'], ...(over.target === undefined || over.target === null ? {} : { target: over.target.obligation === null ? { def: over.target.def } : over.target }), ...(over.budget === undefined ? {} : { budget: over.budget }), ...(over.context_policy === undefined ? {} : { context_policy: over.context_policy }), ...(over.counterexample === undefined || over.counterexample === null ? {} : { counterexample: over.counterexample }), ...(over.description === undefined || over.description === null ? {} : { description: over.description }) });
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.task;
}

const CLAMP_SIG = `pub fn clamp(x: Int, lo: Int, hi: Int where lo <= it) -> Int
  ensures proved lo <= result and result <= hi`;
const WRONG = `\`\`\`onus\n${CLAMP_SIG}\n{\n  return x\n}\n\`\`\``;
const RIGHT = `\`\`\`onus\n${CLAMP_SIG}\n{\n  if x < lo {\n    return lo\n  }\n  if x > hi {\n    return hi\n  }\n  return x\n}\n\`\`\``;

async function run(root: string, t: Task, model: ScriptedModel) {
  return runTask(t, { root, model, log: () => undefined, budgetMs: 2000, cacheDir, now: () => Date.now() });
}

describe.skipIf(z3 === null)('the cycle (§4) with a scripted model', () => {
  it('implement: a wrong body then a right one reaches green in two iterations and opens a change', async () => {
    const root = fixture('implement', 'implement');
    const model = new ScriptedModel([WRONG, RIGHT]);
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null } }), model);
    expect(r.status, r.error ?? '').toBe('change');
    const c = r.change;
    if (c === null) throw new Error('no change');
    expect(c.trace.map((x) => x.classification)).toEqual(['progress', 'green']);
    expect(c.interface_diff).toEqual([]);
    expect(c.body_diff).toHaveLength(1);
    expect(c.ledger_delta.some((l) => l.kind === 'ensures' && l.after === 'proved')).toBe(true);
    expect(readFileSync(join(root, 'calc.onus'), 'utf8')).toContain('if x < lo {');
    expect(existsSync(join(root, '.onus', 'changes', 'task_test', 'change.json'))).toBe(true);
    // The model saw the target with its body elided, the diagnostics of its wrong body, and no prose conventions.
    const first = model.requests[0]?.prompt ?? '';
    expect(first).toContain('{ ... }');
    expect(first).not.toContain('E0115');
    // The wrong body fails its example at check time (E0702); the model sees that diagnostic and the example.
    const second = model.requests[1]?.prompt ?? '';
    expect(second).toContain('## Diagnostics from the last check');
    expect(second).toContain('clamp(x: 5, lo: 0, hi: 3) == 3');
  });

  it('repair: a failed obligation with a counterexample reaches green', async () => {
    const root = fixture('repair', 'repair');
    const r = await run(root, task({ kind: 'repair', target: { def: 'calc.clamp', obligation: 'lo <= result and result <= hi' }, counterexample: { x: 7, lo: 0, hi: 3 } }), new ScriptedModel([RIGHT]));
    expect(r.status, r.error ?? '').toBe('change');
    expect(r.change?.trace.map((x) => x.classification)).toEqual(['green']);
    expect(r.change?.ledger_delta.some((l) => l.kind === 'ensures' && l.after === 'proved')).toBe(true);
  });

  it('contract conflict: an unsatisfiable postcondition ends in a proposal, and the file is unchanged', async () => {
    const root = fixture('conflict', 'conflict');
    const before = readFileSync(join(root, 'calc.onus'), 'utf8');
    const body = '```onus\npub fn impossible(x: Int) -> Int\n  ensures proved result > x and result < x\n{\n  return x\n}\n```';
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.impossible', obligation: null } }), new ScriptedModel([body, body]));
    expect(r.status).toBe('blocked');
    expect(r.change?.cause).toBe('contract_conflict');
    expect(r.change?.proposals.map((p) => p.kind)).toEqual(['weaken_postcondition']);
    expect(r.change?.proposals[0]?.evidence.counterexample).not.toBeNull();
    expect(readFileSync(join(root, 'calc.onus'), 'utf8')).toBe(before);
  });

  it('out of scope: a changed signature is refused twice, then blocked with a proposal', async () => {
    const root = fixture('implement', 'out-of-scope');
    const widened = '```onus\npub fn clamp(x: Int, lo: Int, hi: Int where lo <= it) -> Int\n  ensures proved lo <= result\n{\n  return lo\n}\n```';
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null } }), new ScriptedModel([widened, widened]));
    expect(r.status).toBe('blocked');
    expect(r.change?.cause).toBe('out_of_scope');
    expect(r.change?.proposals.map((p) => p.kind)).toEqual(['weaken_postcondition']);
    expect(readFileSync(join(root, 'calc.onus'), 'utf8')).toContain('{ ... }');
  });

  it('out of scope: a helper the loop may not add is blocked with a new_helper proposal', async () => {
    const root = fixture('implement', 'helper');
    const helper = `\`\`\`onus\nfn min(a: Int, b: Int) -> Int {\n  if a < b {\n    return a\n  }\n  return b\n}\n\n${CLAMP_SIG}\n{\n  return min(a: x, b: hi)\n}\n\`\`\``;
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null } }), new ScriptedModel([helper, helper]));
    expect(r.status).toBe('blocked');
    expect(r.change?.cause).toBe('out_of_scope');
    expect(r.change?.proposals.map((p) => p.kind)).toEqual(['new_helper']);
  });

  it('regenerate: a body that passes its contract but fails an example is an audit finding and a proposal', async () => {
    const root = fixture('regenerate', 'regenerate');
    const before = readFileSync(join(root, 'calc.onus'), 'utf8');
    const weaker = '```onus\npub fn double(n: Int where 0 <= it and it <= 1000) -> Int\n  ensures proved result >= n\n{\n  return n\n}\n```';
    const r = await run(root, task({ kind: 'regenerate', budget: { iterations: 2, tokens: 400000, wall_ms: 900000 } }), new ScriptedModel([weaker]));
    expect(r.status).toBe('blocked');
    expect(r.change?.audit.map((f) => f.finding)).toEqual(['example_failed']);
    expect(r.change?.proposals.map((p) => p.kind)).toEqual(['add_claim']);
    expect(readFileSync(join(root, 'calc.onus'), 'utf8')).toBe(before);
  });

  it('stall: the same wrong body walks the ladder and is blocked', async () => {
    const root = fixture('implement', 'stall');
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null } }), new ScriptedModel([WRONG]));
    expect(r.status).toBe('blocked');
    expect(r.change?.cause).toBe('stall');
    expect(r.change?.trace.map((x) => x.escalation)).toEqual([null, null, 'full diagnostic history', 'context policy scope']);
    expect(r.change?.metrics.escalation_steps).toBe(3);
    expect(r.change?.best_attempt?.bodies['calc.clamp']).toContain('return x');
  });

  it('budget: one iteration is exhausted', async () => {
    const root = fixture('implement', 'budget');
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null }, budget: { iterations: 1, tokens: 400000, wall_ms: 900000 } }), new ScriptedModel([WRONG]));
    expect(r.status).toBe('blocked');
    expect(r.change?.cause).toBe('budget');
  });

  it('ticket: the answer is a proposal, never an edit', async () => {
    const root = fixture('repair', 'ticket');
    const before = readFileSync(join(root, 'calc.onus'), 'utf8');
    const answer = 'The clamp should accept an empty range.\n{"kind": "add_precondition", "def": "calc.clamp", "current": null, "proposed": "requires lo <= hi", "rationale": "an empty range has no clamp"}';
    const r = await run(root, task({ kind: 'ticket', description: 'clamp misbehaves on empty ranges' }), new ScriptedModel([answer]));
    expect(r.status).toBe('change');
    expect(r.change?.proposals.map((p) => [p.kind, p.proposed])).toEqual([['add_precondition', 'requires lo <= hi']]);
    expect(r.change?.body_diff).toEqual([]);
    expect(readFileSync(join(root, 'calc.onus'), 'utf8')).toBe(before);
  });

  it('the change validates against its schema', async () => {
    const root = fixture('implement', 'schema');
    const r = await run(root, task({ kind: 'implement', target: { def: 'calc.clamp', obligation: null } }), new ScriptedModel([RIGHT]));
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(JSON.parse(readFileSync(join(here, '..', 'schema', 'proposal.schema.json'), 'utf8')));
    const validate = ajv.compile(JSON.parse(readFileSync(join(here, '..', 'schema', 'change.schema.json'), 'utf8')));
    const written: unknown = JSON.parse(readFileSync(join(root, '.onus', 'changes', 'task_test', 'change.json'), 'utf8'));
    expect(validate(written), JSON.stringify(validate.errors)).toBe(true);
    expect(r.status).toBe('change');
  });
});

describe('tasks (§2)', () => {
  it('a task is validated against its schema', () => {
    expect(parseTask({ id: 't', kind: 'polish', scope: ['a'] })).toHaveProperty('error');
    expect(parseTask({ id: 't', kind: 'implement', scope: [] })).toHaveProperty('error');
    expect(parseTask({ id: 't', kind: 'implement', scope: ['a'] })).toHaveProperty('error');
    const ok = parseTask({ id: 't', kind: 'implement', scope: ['a'], target: { def: 'a.f' } });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.task.budget.iterations).toBe(12);
    expect(ok.task.context_policy).toBe('module');
  });
});

describe('environment files', () => {
  it('parses KEY=value lines with comments, exports and quotes', () => {
    const env = parseEnv('# keys\nexport OPENROUTER_API_KEY="sk-or-test"\nOPENROUTER_MODEL=deepseek/deepseek-v4-flash\n\nBAD LINE\n');
    expect([...env]).toEqual([
      ['OPENROUTER_API_KEY', 'sk-or-test'],
      ['OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash'],
    ]);
    expect(loadEnvFiles([join(tmpRoot, 'no-such-dir')])).toEqual([]);
  });
});

// The live model comes from ONUS_LOOP_MODEL (claude-code, anthropic[:model], openrouter[:model]); keys from the environment or the repository's .env.local.
loadEnvFiles([repoRoot]);
const liveSpec = process.env['ONUS_LOOP_MODEL'] ?? 'claude-code';

describe.skipIf(process.env['ONUS_LOOP_LIVE'] !== '1' || z3 === null)(`live: ${liveSpec} as the model`, () => {
  it('regenerates the Mandelbrot escape count from its interface', async () => {
    const model = modelFromSpec(liveSpec);
    if (typeof model === 'string') throw new Error(model);
    const root = join(tmpRoot, 'live-mandelbrot');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(join(repoRoot, 'examples', 'mandelbrot', 'mandelbrot.onus'), join(root, 'mandelbrot.onus'));
    const r = await runTask(task({ kind: 'implement', scope: ['mandelbrot'], target: { def: 'mandelbrot.escape_count', obligation: null }, budget: { iterations: 6, tokens: 400000, wall_ms: 900000 } }), { root, model, log: (line) => process.stderr.write(`${line}\n`), budgetMs: 2000, cacheDir });
    expect(r.status, r.error ?? JSON.stringify(r.change?.last_diagnostics ?? [])).toBe('change');
  }, 900000);
});
