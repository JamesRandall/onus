/**
 * Milestone 14 (docs/onus-loop-v0.md §5, §6): the Changes view renders a
 * loop change with its proposals marked as the loop's, the ledger delta,
 * the body diff collapsed and the trace.
 */
import { describe, expect, it } from 'vitest';
import { renderChangesView } from '../src/render.js';
import type { LoopChange } from '../src/types.js';

const change: LoopChange = {
  task: { id: 'task_01', kind: 'implement', scope: ['calc'], target: { def: 'calc.clamp' } },
  status: 'blocked',
  cause: 'contract_conflict',
  generated: { at: '2026-09-05T10:00:00.000Z', model: 'scripted' },
  interface_diff: [],
  ledger_delta: [{ def: 'calc.clamp', kind: 'ensures', text: 'lo <= result', before: null, after: 'proved' }],
  body_diff: [{ file: 'calc.onus', module: 'calc', before: '{ ... }', after: '{ return lo }' }],
  trace: [{ iteration: 1, classification: 'progress', diagnostics_before: 1, diagnostics_after: 1, mechanical_repairs: 0, tokens: 100, ms: 5, escalation: null }],
  metrics: { iterations: 1, mechanical_repairs: 0, escalation_steps: 0, proposals: 1, tokens: 100 },
  proposals: [{ kind: 'weaken_postcondition', def: 'calc.impossible', current: 'ensures result > x and result < x', proposed: null, rationale: 'unsatisfiable', counterexample: { x: 0 } }],
  audit: [],
};

describe('the Changes view', () => {
  it('renders a change with its proposals marked as proposed by loop', () => {
    const html = renderChangesView([change]);
    expect(html).toContain('proposed by loop');
    expect(html).toContain('weaken_postcondition');
    expect(html).toContain('blocked: contract_conflict');
    expect(html).toContain('<details class="body">');
    expect(html).toContain('ensures lo &lt;= result');
    expect(renderChangesView([])).toContain('no change');
  });
});
