/**
 * The review tool renders compiler output and nothing else: a synthetic
 * path report lays out top-down from the entry, marks the assumed leaf and
 * draws the gate region; text is escaped.
 */
import { describe, expect, it } from 'vitest';
import { layoutGraph, NODE_H, NODE_W } from '../src/layout.js';
import { esc, renderPage, renderPathView } from '../src/render.js';
import type { PathReport, ReviewData } from '../src/types.js';

const counts = { proved: 1, checked: 0, assumed: 0, failed: 0 };
const node = (id: string, extra: Partial<PathReport['graph']['nodes'][number]> = {}): PathReport['graph']['nodes'][number] => ({ id, module: 'm', kind: 'fn', effects: [], claims: [], obligations: counts, assumes: 0, recovers: 0, unresolvable: 0, ...extra });

const report: PathReport = {
  path: 'p',
  entry: 'm.entry',
  reachable: ['m.entry', 'm.gate', 'm.guarded', 'v.leaf'],
  effects: { bound: ['io.net'], forbid: [], actual: ['io.net'] },
  claims: { required: ['v.C'], satisfied: true },
  assumes: [{ claim: 'v.C', at: 'v.leaf', justification: 'vendor <contract>', permitted_by: 'except' }],
  obligations: { ...counts, checked_at: [] },
  unresolvable_calls: [{ at: 'm.guarded:9:3', reason: 'function value' }],
  capabilities: [],
  graph: {
    nodes: [node('m.entry', { kind: 'entry' }), node('m.gate'), node('m.guarded'), node('v.leaf', { effects: ['io.net'], assumes: 1 })],
    edges: [
      { from: 'm.entry', to: 'm.gate', effects: [], at: 'a' },
      { from: 'm.entry', to: 'm.guarded', effects: [], at: 'b' },
      { from: 'm.guarded', to: 'v.leaf', effects: ['io.net'], at: 'c' },
    ],
  },
  gates: [{ evidence: 'm.Evidence', producers: ['m.gate'], guarded: ['m.guarded'] }],
  recovers: [{ def: 'm.entry', at: 'm.entry:3:1' }],
  ledger: [{ kind: 'requires', text: 'x > 0', def: 'm.guarded', status: 'proved', by: 'z3', pinned: false, at: 'm.onus:9:3' }],
  ok: true,
};

describe('path view', () => {
  it('lays out layers top-down from the entry', () => {
    const l = layoutGraph(report.graph.nodes, report.graph.edges, report.entry);
    expect(l.placed.get('m.entry')?.layer).toBe(0);
    expect(l.placed.get('m.guarded')?.layer).toBe(1);
    expect(l.placed.get('v.leaf')?.layer).toBe(2);
    expect((l.placed.get('v.leaf')?.y ?? 0) > (l.placed.get('m.entry')?.y ?? 0)).toBe(true);
  });

  it('marks the assumed leaf, the recover site, the gate region and the break', () => {
    const html = renderPathView(report);
    expect(html).toMatch(/<g class="node fn assumed" [^>]*data-id="v.leaf"/);
    expect(html).toMatch(/<g class="node entry recover" [^>]*data-id="m.entry"/);
    expect(html).toContain('<rect class="gate"');
    expect(html).toContain('gate: m.Evidence from m.gate');
    expect(html).toContain('class="node break"');
    expect(html).toContain('vendor &lt;contract&gt;');
    expect(html).toContain('ledger-row status-proved');
  });

  it('draws the gate region around the guarded nodes', () => {
    const html = renderPathView(report);
    const rect = /<rect class="gate" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/.exec(html);
    if (rect === null) throw new Error('no gate rect');
    const [x, y, w, h] = rect.slice(1, 5).map(Number);
    const guarded = layoutGraph(report.graph.nodes, report.graph.edges, report.entry).placed.get('m.guarded');
    if (guarded === undefined || x === undefined || y === undefined || w === undefined || h === undefined) throw new Error('layout missing');
    expect(x).toBeLessThan(guarded.x);
    expect(y).toBeLessThan(guarded.y);
    expect(x + w).toBeGreaterThan(guarded.x + NODE_W);
    expect(y + h).toBeGreaterThan(guarded.y + NODE_H);
  });

  it('escapes text', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('page', () => {
  it('renders every view once', () => {
    const data: ReviewData = { generated: { tool: 'test', at: 'now' }, entry: 'm', modules: [], sources: {}, paths: [report], diagnostics: [], diff: null };
    const html = renderPage(data);
    for (const v of ['paths', 'interfaces', 'ledger', 'diff', 'diagnostics']) expect(html).toContain(`data-view="${v}"`);
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});
