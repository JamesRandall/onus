/**
 * Rendering of the review page (language spec §15). Every view is a string
 * rendering of compiler output; nothing here analyses a program. The only
 * runtime script switches views, filters the ledger and counts body
 * expansions (§15.1: body-open rate per module).
 */
import { layoutGraph, NODE_H, NODE_W } from './layout.js';
import type { Coverage, DiagnosticJson, InterfaceDiff, InterfaceDocument, InterfaceItem, PathReport, ReviewData, Verified } from './types.js';

/** `assumed, verified <when> against <target>` or `assumed, unverified` (§20.3). Effects: none. */
export function freshness(a: { readonly verifiable: boolean; readonly last_verified: Verified | null }): string {
  if (a.last_verified !== null) return `${a.last_verified.result === 'passed' ? 'verified' : 'verification failed'} ${a.last_verified.at} against ${a.last_verified.target}`;
  return a.verifiable ? 'unverified (verifiable)' : 'unverified';
}

/** HTML-escapes text. Effects: none. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function counts(o: { proved: number; checked: number; assumed: number; failed: number }): string {
  const parts = [`${o.proved} proved`];
  if (o.checked > 0) parts.push(`${o.checked} checked`);
  if (o.assumed > 0) parts.push(`${o.assumed} assumed`);
  if (o.failed > 0) parts.push(`${o.failed} failed`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Path view
// ---------------------------------------------------------------------------

/** The path view: the graph as SVG, then the path's assumptions, capabilities and ledger rows. Effects: none. */
export function renderPathView(r: PathReport): string {
  const breaks = r.unresolvable_calls.map((u, i) => ({ id: `break:${i}`, after: u.at.split(':')[0] ?? r.entry, reason: u.reason, at: u.at }));
  const layout = layoutGraph(r.graph.nodes, r.graph.edges, r.entry, breaks.map((b) => ({ id: b.id, after: b.after })));
  const assumedIds = new Set(r.assumes.map((a) => a.at));
  const recoverIds = new Set(r.recovers.map((x) => x.def));
  const svg: string[] = [];
  for (const g of r.gates) {
    const boxes = g.guarded.map((id) => layout.placed.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined);
    if (boxes.length === 0) continue;
    const pad = 14;
    const x = Math.min(...boxes.map((b) => b.x)) - pad;
    const y = Math.min(...boxes.map((b) => b.y)) - pad - 16;
    const x2 = Math.max(...boxes.map((b) => b.x)) + NODE_W + pad;
    const y2 = Math.max(...boxes.map((b) => b.y)) + NODE_H + pad;
    svg.push(`<rect class="gate" x="${x}" y="${y}" width="${x2 - x}" height="${y2 - y}" rx="10"/>`);
    svg.push(`<text class="gate-label" x="${x + 8}" y="${y + 13}">gate: ${esc(g.evidence)} from ${esc(g.producers.join(', '))}</text>`);
  }
  for (const e of r.graph.edges) {
    const a = layout.placed.get(e.from);
    const b = layout.placed.get(e.to);
    if (a === undefined || b === undefined) continue;
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    const back = b.layer <= a.layer;
    svg.push(`<path class="edge${back ? ' back' : ''}" d="M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}"/>`);
    if (e.effects.length > 0) svg.push(`<text class="edge-label" x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 4}">${esc(e.effects.join(', '))}</text>`);
  }
  for (const b of breaks) {
    const a = layout.placed.get(b.after);
    const p = layout.placed.get(b.id);
    if (a === undefined || p === undefined) continue;
    svg.push(`<path class="edge break" d="M${a.x + NODE_W / 2},${a.y + NODE_H} L${p.x + NODE_W / 2},${p.y}"/>`);
    svg.push(`<g class="node break" transform="translate(${p.x},${p.y})"><rect width="${NODE_W}" height="${NODE_H}" rx="6"/><text x="12" y="22">unresolvable call</text><text class="small" x="12" y="42">${esc(b.at)}</text><text class="small" x="12" y="60">${esc(b.reason.slice(0, 36))}</text></g>`);
  }
  for (const n of r.graph.nodes) {
    const p = layout.placed.get(n.id);
    if (p === undefined) continue;
    const classes = ['node', n.kind];
    if (assumedIds.has(n.id) || n.assumes > 0) classes.push('assumed');
    if (recoverIds.has(n.id) || n.recovers > 0) classes.push('recover');
    const o = n.obligations;
    svg.push(
      `<g class="${classes.join(' ')}" transform="translate(${p.x},${p.y})" data-id="${esc(n.id)}"><rect width="${NODE_W}" height="${NODE_H}" rx="6"/>` +
        `<text class="name" x="12" y="20">${esc(n.id)}</text>` +
        `<text class="small" x="12" y="38">${esc(n.effects.length > 0 ? n.effects.join(', ') : 'pure')}</text>` +
        `<text class="small" x="12" y="54">${esc(n.claims.length > 0 ? `claims ${n.claims.map((c) => c.split('.').pop() ?? c).join(', ')}` : 'no claims')}</text>` +
        `<text class="small" x="12" y="70">${o.proved}/${o.checked}/${o.assumed} proved/checked/assumed${n.assumes > 0 ? ` · ${n.assumes} assume` : ''}${n.recovers > 0 ? ` · ${n.recovers} recover` : ''}</text></g>`,
    );
  }
  const head = `<h2>path <code>${esc(r.path)}</code> <span class="status ${r.ok ? 'ok' : 'failed'}">${r.ok ? 'ok' : 'failed'}</span></h2>
<p>entry <code>${esc(r.entry)}</code> · ${r.reachable.length} reachable · effects { ${esc(r.effects.actual.join(', '))} }${r.effects.bound === null ? '' : ` within { ${esc(r.effects.bound.join(', '))} }`}${r.effects.forbid.length > 0 ? ` · forbid { ${esc(r.effects.forbid.join(', '))} }` : ''}${r.claims.required.length > 0 ? ` · require { ${esc(r.claims.required.join(', '))} } ${r.claims.satisfied ? 'satisfied' : 'not satisfied'}` : ''}</p>`;
  const assumes = r.assumes.length === 0 ? '<p>No assumptions on this path.</p>' : `<table><thead><tr><th>assume</th><th>at</th><th>justification</th><th>permitted by</th><th>verified</th></tr></thead><tbody>${r.assumes.map((a) => `<tr class="assumed"><td><code>${esc(a.claim)}</code></td><td><code>${esc(a.at)}</code></td><td>${esc(a.justification)}</td><td>${a.permitted_by === null ? 'not permitted' : `permitted by ${esc(a.permitted_by)}`}</td><td class="fresh ${a.last_verified?.result === 'passed' ? 'verified' : 'unverified'}">assumed, ${esc(freshness(a))}</td></tr>${a.verify === null ? '' : `<tr class="verify-row"><td colspan="5"><pre class="verify">${esc(a.verify)}</pre></td></tr>`}`).join('')}</tbody></table>`;
  const caps = r.capabilities.length === 0 ? '' : `<h3>Capabilities</h3><table><thead><tr><th>type</th><th>constructed at</th><th>assumes</th></tr></thead><tbody>${r.capabilities.map((c) => `<tr><td><code>${esc(c.type)}</code></td><td><code>${esc(c.constructed_at)}</code></td><td>${esc(c.assumes.join('; ') || 'none recorded')}</td></tr>`).join('')}</tbody></table>`;
  const recovers = r.recovers.length === 0 ? '' : `<h3>Recover sites</h3><ul>${r.recovers.map((x) => `<li class="recover"><code>${esc(x.def)}</code> at <code>${esc(x.at)}</code></li>`).join('')}</ul>`;
  return `<section class="path" data-path="${esc(r.path)}">${head}
<div class="graph"><svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">${svg.join('\n')}</svg></div>
${coverageLine(r.obligation_coverage)}
<h3>Assumptions</h3>${assumes}${caps}${recovers}
<h3>Ledger (${counts(r.obligations)})</h3>${ledgerTable(r.ledger.map((l) => ({ ...l, at: l.at })))}
</section>`;
}

function ledgerTable(rows: readonly { kind: string; text: string; def: string; status: string; by: string | null; pinned: boolean; at: string }[]): string {
  if (rows.length === 0) return '<p>No obligations.</p>';
  return `<table class="ledger"><thead><tr><th>status</th><th>kind</th><th>obligation</th><th>in</th><th>at</th><th>by</th></tr></thead><tbody>${rows
    .map((l) => `<tr class="ledger-row status-${esc(l.status)}"><td class="status ${esc(l.status)}">${esc(l.status)}${l.pinned ? ' (pinned)' : ''}</td><td>${esc(l.kind)}</td><td><code>${esc(l.text)}</code></td><td><code>${esc(l.def)}</code></td><td><code>${esc(l.at)}</code></td><td>${esc(l.by ?? '')}</td></tr>`)
    .join('')}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Interface view
// ---------------------------------------------------------------------------

function locText(l: { file: string; span: readonly [readonly [number, number], readonly [number, number]] }): string {
  return `${l.file}:${l.span[0][0]}:${l.span[0][1]}`;
}

function contractLine(c: InterfaceItem['contracts'][number]): string {
  const mark = c.status === 'proved' ? '' : c.status === 'checked' ? ` <span class="mark checked">checked at ${esc(c.checked_at ?? 'runtime')}</span>` : ` <span class="mark ${esc(c.status)}">${esc(c.status)}</span>`;
  return `<div class="contract"><code>${esc(c.kind)} ${c.pinned ? 'proved ' : ''}${esc(c.text)}</code>${mark}</div>`;
}

/** The interface view of one module: signatures, contracts, examples, properties, with bodies collapsed and their opening counted. Effects: none. */
export function renderInterfaceView(doc: InterfaceDocument, source: string | null): string {
  const lines = source === null ? null : source.split('\n');
  const bodyOf = (item: InterfaceItem): string | null => {
    if (lines === null) return null;
    const [[l1], [l2]] = item.at.span;
    return lines.slice(l1 - 1, l2).join('\n');
  };
  const items = doc.items
    .map((item) => {
      const body = bodyOf(item);
      const sig = `<pre class="signature">${esc(item.kind === 'fn' ? `${item.visibility === 'pub' ? 'pub ' : ''}${item.signature}` : item.signature)}</pre>`;
      const meta = item.kind === 'fn' ? `<p class="meta">${item.effects.length > 0 ? `effects ${esc(item.effects.join(', '))}` : 'pure'}${item.claims.length > 0 ? ` · claims ${esc(item.claims.join(', '))}` : ''} · ${counts(item.obligations)}</p>` : '';
      const contracts = item.contracts.map(contractLine).join('');
      const assumes = item.assumes.map((a) => `<div class="assumed">assume <code>${esc(a.claim)}</code> — ${esc(a.justification)} <span class="small">(${esc(locText(a.at))}; ${esc(freshness(a))})</span>${a.verify === null ? '' : `<pre class="verify">${esc(a.verify)}</pre>`}</div>`).join('');
      const recovers = item.recovers.map((x) => `<div class="recover">recover at ${esc(locText(x.at))}</div>`).join('');
      const tests = [...item.examples.map((e) => `<span class="test ${esc(e.status.replace(' ', '-'))}">example ${esc(e.name)}: ${esc(e.status)}</span>`), ...item.properties.map((p) => `<span class="test ${esc(p.status)}">property ${esc(p.name)}: ${esc(p.status)}</span>`)].join(' ');
      const bodyBlock = item.kind === 'fn' && body !== null ? `<details class="body" data-module="${esc(doc.module)}" data-item="${esc(item.name)}"><summary><code>{ ... }</code> <span class="small">expand body (counted)</span></summary><pre>${esc(body)}</pre></details>` : '';
      return `<article class="item ${esc(item.kind)}" id="item-${esc(doc.module)}-${esc(item.name)}">${sig}${meta}${contracts}${assumes}${recovers}${tests === '' ? '' : `<p>${tests}</p>`}${bodyBlock}</article>`;
    })
    .join('\n');
  const fnCount = doc.items.filter((i) => i.kind === 'fn').length;
  return `<section class="module" data-module="${esc(doc.module)}"><h2>module <code>${esc(doc.module)}</code>${doc.test_module ? ' (test module)' : ''}</h2>
<p class="meta">${esc(doc.hash)} · imports ${esc(doc.imports.join(', ') || 'nothing')} · ${counts(doc.obligations)} · ${doc.assumes.length} assumed claim${doc.assumes.length === 1 ? '' : 's'} · ${doc.recovers.length} recover site${doc.recovers.length === 1 ? '' : 's'}${doc.sealed_types.length > 0 ? ` · sealed ${esc(doc.sealed_types.join(', '))}` : ''} · <span class="rate" data-module="${esc(doc.module)}" data-total="${fnCount}">0 of ${fnCount} bodies opened</span></p>
${coverageLine(doc.obligation_coverage)}${items}</section>`;
}

/** The obligation coverage line (§20.5): proved, checked and exercised, assumptions verified, mutations surviving. Effects: none. */
function coverageLine(c: Coverage | undefined): string {
  if (c === undefined) return '';
  const mutations = c.mutations_detected + c.mutations_surviving === 0 ? 'no contract mutations run' : `${c.mutations_detected} contract mutation${c.mutations_detected === 1 ? '' : 's'} detected, <span class="${c.mutations_surviving > 0 ? 'surviving' : 'ok'}">${c.mutations_surviving} surviving</span>`;
  return `<p class="coverage">coverage: ${c.proved} proved · ${c.checked} checked, <span class="${c.checked_exercised < c.checked ? 'unexercised' : 'ok'}">${c.checked_exercised} exercised by tests</span> · ${c.assumptions} assumption${c.assumptions === 1 ? '' : 's'}, ${c.assumptions_verifiable} verifiable, ${c.assumptions_verified} verified · ${mutations}</p>`;
}

// ---------------------------------------------------------------------------
// Ledger view
// ---------------------------------------------------------------------------

/** Every obligation of every module, plus assumptions, recover sites and capability construction sites. Effects: none. */
export function renderLedgerView(data: ReviewData): string {
  const rows = data.modules.flatMap((m) => m.ledger.map((l) => ({ ...l, def: `${m.module}.${l.def}`, at: locText(l.at) })));
  const filters = ['all', 'proved', 'checked', 'assumed', 'failed'].map((s) => `<button class="filter${s === 'all' ? ' active' : ''}" data-status="${s}">${s}</button>`).join(' ');
  const assumes = data.modules.flatMap((m) => m.assumes.map((a) => `<tr class="assumed"><td><code>${esc(m.module)}.${esc(a.def)}</code></td><td><code>${esc(a.claim)}</code></td><td>${esc(a.justification)}</td><td><code>${esc(locText(a.at))}</code></td><td>${esc(freshness(a))}</td></tr>${a.verify === null ? '' : `<tr class="verify-row"><td colspan="5"><pre class="verify">${esc(a.verify)}</pre></td></tr>`}`));
  const recovers = data.modules.flatMap((m) => m.recovers.map((x) => `<li class="recover"><code>${esc(m.module)}.${esc(x.def)}</code> at <code>${esc(locText(x.at))}</code></li>`));
  const caps = data.paths.flatMap((p) => p.capabilities.map((c) => `<tr><td><code>${esc(p.path)}</code></td><td><code>${esc(c.type)}</code></td><td><code>${esc(c.constructed_at)}</code></td><td>${esc(c.assumes.join('; ') || 'none recorded')}</td></tr>`));
  return `<section class="ledger-view"><h2>Ledger</h2><p>${filters}</p>${ledgerTable(rows)}
<h3>Assumptions (${assumes.length})</h3>${assumes.length === 0 ? '<p>None.</p>' : `<table><thead><tr><th>in</th><th>claim</th><th>justification</th><th>at</th><th>verified</th></tr></thead><tbody>${assumes.join('')}</tbody></table>`}
<h3>Recover sites (${recovers.length})</h3>${recovers.length === 0 ? '<p>None.</p>' : `<ul>${recovers.join('')}</ul>`}
<h3>Capability construction sites (${caps.length})</h3>${caps.length === 0 ? '<p>None on any path.</p>' : `<table><thead><tr><th>path</th><th>type</th><th>constructed at</th><th>depends on</th></tr></thead><tbody>${caps.join('')}</tbody></table>`}</section>`;
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------

/** Two interface documents compared, as the compiler diffed them (§15.1). Effects: none. */
export function renderDiffView(diff: InterfaceDiff | null): string {
  if (diff === null) return '<section><h2>Diff</h2><p>No previous interface was given (<code>onus review --against &lt;interface.json&gt;</code>).</p></section>';
  const li = (xs: readonly { name: string; kind: string; visibility: string }[]): string => (xs.length === 0 ? '<li>none</li>' : xs.map((x) => `<li><code>${esc(x.kind)} ${esc(x.name)}</code> (${esc(x.visibility)})</li>`).join(''));
  const changed = diff.changed
    .map((c) => {
      const parts: string[] = [];
      if (c.signature !== null) parts.push(`<div class="breaking">signature changed<pre>- ${esc(c.signature.old)}\n+ ${esc(c.signature.new)}</pre></div>`);
      if (c.effects.added.length > 0) parts.push(`<div class="breaking">effects widened: ${esc(c.effects.added.join(', '))}</div>`);
      if (c.effects.removed.length > 0) parts.push(`<div class="compatible">effects narrowed: ${esc(c.effects.removed.join(', '))}</div>`);
      for (const k of c.contracts) parts.push(`<div class="${esc(k.compatibility)}">${esc(k.kind)} ${esc(k.change)}: <code>${esc(k.text)}</code> (${esc(k.compatibility)})</div>`);
      for (const a of c.assumes.added) parts.push(`<div class="assumed">new assumption: <code>${esc(a)}</code></div>`);
      for (const a of c.assumes.removed) parts.push(`<div class="compatible">assumption removed: <code>${esc(a)}</code></div>`);
      if (c.recovers.added > 0) parts.push(`<div class="recover">${c.recovers.added} new recover site${c.recovers.added === 1 ? '' : 's'}</div>`);
      if (c.recovers.removed > 0) parts.push(`<div class="compatible">${c.recovers.removed} recover site${c.recovers.removed === 1 ? '' : 's'} removed</div>`);
      for (const o of c.obligations) parts.push(`<div class="${o.to === 'proved' ? 'compatible' : 'breaking'}">${esc(o.kind)} <code>${esc(o.text)}</code>: ${esc(o.from)} → ${esc(o.to)}</div>`);
      return `<article class="item"><h4><code>${esc(c.kind)} ${esc(c.name)}</code> ${c.breaking ? '<span class="status failed">breaking</span>' : '<span class="status ok">compatible</span>'}</h4>${parts.join('')}</article>`;
    })
    .join('');
  return `<section class="diff"><h2>Diff <span class="status ${diff.breaking ? 'failed' : 'ok'}">${diff.breaking ? 'breaking' : 'compatible'}</span></h2>
<p class="meta"><code>${esc(diff.module)}</code>: ${esc(diff.old_hash)} → ${esc(diff.new_hash)}</p>
<h3>Added</h3><ul>${li(diff.added)}</ul><h3>Removed</h3><ul>${li(diff.removed)}</ul><h3>Changed</h3>${changed === '' ? '<p>No item changed.</p>' : changed}</section>`;
}

// ---------------------------------------------------------------------------
// Diagnostics and counterexamples
// ---------------------------------------------------------------------------

/** Diagnostics with the solver's model against the contract text (§15.1, counterexample view). Effects: none. */
export function renderDiagnosticsView(diagnostics: readonly DiagnosticJson[]): string {
  if (diagnostics.length === 0) return '<section><h2>Diagnostics</h2><p>None.</p></section>';
  const items = diagnostics.map((d) => {
    const ob = d.obligation;
    const model = ob?.counterexample === null || ob?.counterexample === undefined ? '' : `<table class="model"><thead><tr><th>name</th><th>value</th></tr></thead><tbody>${Object.entries(ob.counterexample).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td><code>${esc(String(v))}</code></td></tr>`).join('')}</tbody></table>`;
    return `<article class="diagnostic"><h4><code>${esc(d.code)}</code> ${esc(d.title)} <span class="small">${esc(d.location.file)}:${d.location.span[0][0]}:${d.location.span[0][1]}${d.location.def === null ? '' : ` in ${esc(d.location.def)}`}</span></h4>${d.context.map((c) => `<p>${esc(c)}</p>`).join('')}${ob === undefined ? '' : `<p class="contract"><code>${esc(ob.kind)} ${esc(ob.text)}</code> <span class="mark ${esc(ob.status)}">${esc(ob.status)}</span></p>${model}`}</article>`;
  });
  return `<section><h2>Diagnostics (${diagnostics.length})</h2>${items.join('')}</section>`;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const CSS = `
:root { color-scheme: light; --fg: #1f2328; --muted: #57606a; --line: #d0d7de; --bg: #ffffff; --panel: #f6f8fa; --amber: #fff3cd; --amber-line: #b8860b; --purple: #6f42c1; }
body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: var(--fg); background: var(--bg); }
header { padding: 12px 24px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; }
nav button { font: inherit; background: none; border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; color: var(--fg); }
nav button.active { background: var(--fg); color: var(--bg); border-color: var(--fg); }
main { padding: 16px 24px 48px; max-width: 1400px; }
.view[hidden] { display: none; }
h2 { font-size: 18px; margin: 20px 0 6px; } h3 { font-size: 15px; margin: 18px 0 6px; } h4 { margin: 12px 0 4px; }
code, pre { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; overflow-x: auto; margin: 6px 0; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; } th { color: var(--muted); font-weight: 600; }
.meta, .small { color: var(--muted); } .small { font-size: 12px; }
.item { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; margin: 10px 0; }
.contract { margin: 2px 0 2px 12px; }
.mark.checked { color: var(--muted); } .mark.failed, .status.failed, .breaking { color: #1f2328; font-weight: 600; } .status.ok, .compatible { color: var(--muted); }
.assumed { background: var(--amber); } tr.assumed td { background: var(--amber); } div.assumed { border-left: 3px solid var(--amber-line); padding: 2px 8px; margin: 4px 0; }
.recover { color: var(--purple); } div.recover { border-left: 3px solid var(--purple); padding: 2px 8px; margin: 4px 0; }
.graph { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
svg text { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: var(--fg); } svg text.small { font-size: 10.5px; fill: var(--muted); } svg text.name { font-weight: 600; }
svg .node rect { fill: #fff; stroke: #57606a; stroke-width: 1.2; } svg .node.entry rect { stroke-width: 2.4; stroke: #1f2328; } svg .node.intrinsic rect { stroke-dasharray: 4 3; }
svg .node.assumed rect { fill: var(--amber); stroke: var(--amber-line); } svg .node.recover rect { stroke: var(--purple); stroke-width: 2.4; }
svg .node.break rect { fill: #fff; stroke: #1f2328; stroke-dasharray: 2 4; } svg .edge { fill: none; stroke: #8c959f; stroke-width: 1.2; } svg .edge.back { stroke-dasharray: 6 3; } svg .edge.break { stroke: #1f2328; stroke-dasharray: 2 4; }
svg .edge-label { font-size: 10px; fill: var(--muted); text-anchor: middle; } svg .gate { fill: #d0d7de; fill-opacity: 0.35; stroke: #8c959f; stroke-dasharray: 8 4; } svg .gate-label { font-size: 11px; fill: var(--muted); }
.filter.active { background: var(--fg); color: var(--bg); } .filter { font: inherit; border: 1px solid var(--line); border-radius: 6px; background: none; padding: 2px 8px; cursor: pointer; }
.test.passed, .test.proved { color: var(--muted); } .test.failed { font-weight: 600; }
details.body summary { cursor: pointer; color: var(--muted); }
pre.verify { margin: 6px 0 2px; background: #fff; } tr.verify-row td { background: var(--amber); border-top: none; padding-top: 0; }
`;

const SCRIPT = `
(function () {
  var buttons = document.querySelectorAll('nav button[data-view]');
  function show(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== name; });
    buttons.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === name); });
    try { localStorage.setItem('onus-review-view', name); } catch (e) {}
  }
  buttons.forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-view')); }); });
  var initial = null; try { initial = localStorage.getItem('onus-review-view'); } catch (e) {}
  show(initial && document.querySelector('.view[data-view="' + initial + '"]') ? initial : 'paths');
  document.querySelectorAll('.filter').forEach(function (f) {
    f.addEventListener('click', function () {
      var status = f.getAttribute('data-status');
      document.querySelectorAll('.filter').forEach(function (x) { x.classList.toggle('active', x === f); });
      document.querySelectorAll('.ledger-view tr.ledger-row').forEach(function (row) { row.hidden = status !== 'all' && !row.classList.contains('status-' + status); });
    });
  });
  var opened = {};
  document.querySelectorAll('details.body').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      var m = d.getAttribute('data-module'); var item = d.getAttribute('data-item');
      opened[m] = opened[m] || {}; opened[m][item] = true;
      var n = Object.keys(opened[m]).length;
      document.querySelectorAll('.rate[data-module="' + m + '"]').forEach(function (r) {
        var total = Number(r.getAttribute('data-total')) || 0;
        r.textContent = n + ' of ' + total + ' bodies opened' + (total > 0 ? ' (' + Math.round(100 * n / total) + '%)' : '');
      });
    });
  });
})();
`;

/**
 * The whole review page: one self-contained HTML document with every view
 * pre-rendered; the inline script only switches views, filters the ledger
 * and counts body expansions.
 * Effects: none.
 */
export function renderPage(data: ReviewData): string {
  const paths = data.paths.length === 0 ? '<section><h2>Paths</h2><p>The entry module declares no <code>path</code>.</p></section>' : data.paths.map(renderPathView).join('\n');
  const modules = data.modules.map((m) => renderInterfaceView(m, data.sources[m.module] ?? null)).join('\n');
  const views: [string, string, string][] = [
    ['paths', 'Paths', paths],
    ['interfaces', 'Interfaces', modules === '' ? '<section><h2>Interfaces</h2><p>No modules.</p></section>' : modules],
    ['ledger', 'Ledger', renderLedgerView(data)],
    ['diff', 'Diff', renderDiffView(data.diff)],
    ['diagnostics', `Diagnostics${data.diagnostics.length > 0 ? ` (${data.diagnostics.length})` : ''}`, renderDiagnosticsView(data.diagnostics)],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Onus review: ${esc(data.entry)}</title><style>${CSS}.coverage { color: #555; font-size: 0.95em; }
.coverage .unexercised, .coverage .surviving { color: #a40; font-weight: 600; }
</style></head>
<body><header><h1>Onus review · <code>${esc(data.entry)}</code></h1><nav>${views.map(([id, label]) => `<button data-view="${id}">${esc(label)}</button>`).join(' ')}</nav><span class="small">generated by ${esc(data.generated.tool)} at ${esc(data.generated.at)}</span></header>
<main>${views.map(([id, , html]) => `<div class="view" data-view="${id}" hidden>${html}</div>`).join('\n')}</main>
<script>${SCRIPT}</script></body></html>
`;
}
