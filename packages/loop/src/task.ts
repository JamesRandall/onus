/**
 * Tasks (docs/onus-loop-v0.md §2): the loop's input, validated against
 * `schema/task.schema.json`. Defaults: twelve iterations, 400k tokens,
 * fifteen minutes, `context_policy: module`, escalation steps 3 and 4 off.
 */
import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';

export type TaskKind = 'implement' | 'repair' | 'interface_change' | 'regenerate' | 'ticket';
export type ContextPolicy = 'none' | 'module' | 'scope';

export interface Budget {
  readonly iterations: number;
  readonly tokens: number;
  readonly wall_ms: number;
}

export interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly scope: readonly string[];
  readonly target: { readonly def: string; readonly obligation: string | null } | null;
  readonly counterexample: Readonly<Record<string, unknown>> | null;
  readonly budget: Budget;
  readonly context_policy: ContextPolicy;
  readonly origin: { readonly kind: string; readonly ref: string } | null;
  readonly description: string | null;
  readonly escalation: { readonly helpers: boolean; readonly alternate_model: string | null };
}

export const DEFAULT_BUDGET: Budget = { iterations: 12, tokens: 400000, wall_ms: 900000 };

const schemaUrl = new URL('../schema/task.schema.json', import.meta.url);
let validator: ValidateFunction | null = null;

function validate(json: unknown): string | null {
  if (validator === null) {
    const ajv = new Ajv({ allErrors: true });
    validator = ajv.compile(JSON.parse(readFileSync(schemaUrl, 'utf8')));
  }
  if (validator(json)) return null;
  return (validator.errors ?? []).map((e) => `${e.instancePath === '' ? 'task' : e.instancePath}: ${e.message ?? 'invalid'}`).join('; ');
}

function record(x: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[k] = v;
  return out;
}

function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

function int(x: unknown, fallback: number): number {
  return typeof x === 'number' && Number.isInteger(x) ? x : fallback;
}

/**
 * Parses a task from JSON. Returns the task, or the validation message.
 * Effects: reads the schema file once.
 */
export function parseTask(json: unknown): { readonly task: Task } | { readonly error: string } {
  const message = validate(json);
  if (message !== null) return { error: message };
  const r = record(json);
  if (r === null) return { error: 'task: not an object' };
  const kind = str(r['kind']);
  const policy = str(r['context_policy']);
  const target = record(r['target']);
  const origin = record(r['origin']);
  const budget = record(r['budget']) ?? {};
  const escalation = record(r['escalation']) ?? {};
  const scopeRaw = r['scope'];
  const scope = Array.isArray(scopeRaw) ? scopeRaw.filter((s): s is string => typeof s === 'string') : [];
  if (kind !== 'implement' && kind !== 'repair' && kind !== 'interface_change' && kind !== 'regenerate' && kind !== 'ticket') return { error: 'task: unknown kind' };
  if ((kind === 'implement' || kind === 'repair' || kind === 'interface_change') && target === null) return { error: `task: a ${kind} task needs a target` };
  const targetDef = target === null ? null : str(target['def']);
  return {
    task: {
      id: str(r['id']) ?? '',
      kind,
      scope,
      target: target === null || targetDef === null ? null : { def: targetDef, obligation: str(target['obligation']) },
      counterexample: record(r['counterexample']),
      budget: { iterations: int(budget['iterations'], DEFAULT_BUDGET.iterations), tokens: int(budget['tokens'], DEFAULT_BUDGET.tokens), wall_ms: int(budget['wall_ms'], DEFAULT_BUDGET.wall_ms) },
      context_policy: policy === 'none' || policy === 'scope' ? policy : 'module',
      origin: origin === null ? null : { kind: str(origin['kind']) ?? 'unknown', ref: str(origin['ref']) ?? '' },
      description: str(r['description']),
      escalation: { helpers: escalation['helpers'] === true, alternate_model: str(escalation['alternate_model']) },
    },
  };
}
