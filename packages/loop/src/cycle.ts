/**
 * The cycle (docs/onus-loop-v0.md §4): intake → prepare → [generate →
 * check → classify]* → conclude, with the escalation ladder of §4.1, the
 * budgets of §4.2, the proposals of §5, the changes of §6, the
 * regeneration audits of §8 and the boundaries of §9. The loop edits
 * bodies and nothing else; when it cannot, it stops with a proposal.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interfaceDiff, printItem, type DiagnosticJson, type InterfaceDiff, type Span, type ast as A } from '@onus/compiler';
import { assemble, type HistoryEntry, type TargetInfo } from './context.js';
import { applyRepairs, bodyHash, canonical, elide, extractCode, fnsOf, legalTokenNames, parseFragment, parseModule, signatureText, spliceItem, withBody, type Parsed } from './edit.js';
import type { Model } from './model.js';
import { checkProject, loadProject, type CheckResult, type ProjectFiles } from './project.js';
import type { ContextPolicy, Task } from './task.js';
import { changeDir, writeChange, type AuditFinding, type BlockedCause, type BodyDiff, type Change, type LedgerDelta, type Proposal, type TraceEntry } from './change.js';

export interface RunOptions {
  readonly root: string;
  readonly model: Model;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  /** z3 budget per obligation. */
  readonly budgetMs?: number;
  readonly cacheDir?: string | null;
  /** Where checks and builds go; default `<change dir>/work`. */
  readonly workDir?: string;
  /** Write the new bodies and `change.json`; off for dry runs. */
  readonly write?: boolean;
}

export interface RunResult {
  readonly status: 'change' | 'blocked' | 'error';
  readonly change: Change | null;
  readonly error: string | null;
  /** Path of `change.json` when written. */
  readonly path: string | null;
  /** The final texts of the scope files, changed or not. */
  readonly texts: ReadonlyMap<string, string>;
}

type Classification = 'green' | 'progress' | 'grew' | 'stall' | 'contract conflict' | 'unusable';

interface Working {
  readonly texts: Map<string, string>;
}

function failure(error: string, texts: ReadonlyMap<string, string> = new Map()): RunResult {
  return { status: 'error', change: null, error, path: null, texts };
}

/** The signature of a check outcome, for noticing an identical one (§4 "stall"). */
function outcomeSignature(diagnostics: readonly DiagnosticJson[], failing: readonly string[]): string {
  const parts = diagnostics.map((d) => `${d.code}@${d.location.def ?? ''}:${JSON.stringify(d.location.span)}${d.obligation === undefined ? '' : `|${d.obligation.kind} ${d.obligation.text}`}`);
  return [...parts.sort(), ...[...failing].sort().map((f) => `test ${f}`)].join('\n');
}

function ledgerDelta(before: CheckResult, after: CheckResult): LedgerDelta[] {
  const key = (r: { def: string; kind: string; text: string }): string => `${r.def}|${r.kind}|${r.text}`;
  const a = new Map(before.ledger.map((r) => [key(r), r]));
  const b = new Map(after.ledger.map((r) => [key(r), r]));
  const out: LedgerDelta[] = [];
  for (const [k, r] of b) {
    const prev = a.get(k);
    if (prev === undefined || prev.status !== r.status) out.push({ def: r.def, kind: r.kind, text: r.text, before: prev?.status ?? null, after: r.status });
  }
  for (const [k, r] of a) if (!b.has(k)) out.push({ def: r.def, kind: r.kind, text: r.text, before: r.status, after: null });
  return out;
}

function interfaceDiffs(scope: readonly string[], before: CheckResult, after: CheckResult): InterfaceDiff[] {
  const out: InterfaceDiff[] = [];
  for (const name of scope) {
    const a = before.interfaces.get(name);
    const b = after.interfaces.get(name);
    if (a === undefined || b === undefined) continue;
    const d = interfaceDiff(a, b);
    if (d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0) out.push(d);
  }
  return out;
}

/** Regeneration audit findings (§8): what the interfaces alone could not reconstruct. */
function audit(baseline: CheckResult, final: CheckResult | null): AuditFinding[] {
  if (final === null) return [];
  const out: AuditFinding[] = [];
  if (final.diagnostics.length > 0) {
    // The regenerated program does not check: every diagnostic is a finding.
    for (const d of final.json) {
      if (d.code === 'E0702') out.push({ finding: 'example_failed', detail: `${d.context.join('; ')} on the regenerated body of ${d.location.def ?? '?'}: something the old body did that no claim required` });
      else out.push({ finding: 'obligation_regressed', detail: `${d.code} ${d.title}${d.obligation === undefined ? '' : ` (${d.obligation.kind} ${d.obligation.text})`} in ${d.location.def ?? '?'}: the interfaces were sufficient to check the old body but not to reconstruct it` });
    }
    return out;
  }
  const after = new Map(final.ledger.map((r) => [`${r.def}|${r.kind}|${r.text}`, r.status]));
  for (const r of baseline.ledger) {
    if (r.status !== 'proved' && r.status !== 'checked') continue;
    const now = after.get(`${r.def}|${r.kind}|${r.text}`);
    if (now === 'failed' || now === 'unprovable' || (r.status === 'proved' && now === 'checked')) out.push({ finding: 'obligation_regressed', detail: `${r.kind} ${r.text} in ${r.def}: ${r.status} on the old body, ${now} on the regenerated one; usually a missing example or invariant` });
  }
  if (baseline.tests !== null && final.tests !== null) {
    for (const [name, ok] of baseline.tests) if (ok && final.tests.get(name) === false) out.push({ finding: 'example_failed', detail: `${name} passes on the old body and fails on the regenerated one: something the old body did that no claim required` });
  }
  return out;
}

function proposalsFromAudit(findings: readonly AuditFinding[], target: string, iterations: number): Proposal[] {
  return findings.map((f) => ({
    kind: f.finding === 'example_failed' ? 'add_claim' : 'add_example',
    def: target,
    current: null,
    proposed: null,
    evidence: { counterexample: null, iterations, finding: f.finding },
    rationale: f.detail,
  }));
}

/** The body spans of the targets in the current texts, per file, for mechanical repair (§4 "check"). */
function targetBodySpans(check: CheckResult, targets: readonly TargetInfo[]): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  for (const mod of check.ctx.resolve.modules) {
    for (const fn of fnsOf(mod.module)) {
      if (fn.body === null || !targets.some((t) => t.module === mod.name && t.name === fn.name.text)) continue;
      const path = check.ctx.fileOf(fn.body.span).path;
      out.set(path, [...(out.get(path) ?? []), fn.body.span]);
    }
  }
  return out;
}

/**
 * Runs one task to its conclusion. Effects: runs the compiler and the
 * model; writes checks and builds under the work directory; on a change,
 * writes the new bodies into the working tree and `change.json`; on a
 * blocked task, writes `change.json` only and leaves the tree as found.
 */
export async function runTask(task: Task, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const loaded = loadProject(opts.root, task.scope);
  if ('error' in loaded) return failure(loaded.error);
  const files: ProjectFiles = loaded;
  const workDir = opts.workDir ?? join(changeDir(opts.root, task.id), 'work');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  let checks = 0;
  const check = (texts: ReadonlyMap<string, string>, runTests: boolean): CheckResult => {
    checks += 1;
    return checkProject(files, texts, { runTests, outDir: join(workDir, `check-${checks}`), budgetMs: opts.budgetMs ?? 2000, cacheDir: opts.cacheDir ?? null });
  };

  // prepare: canonical form, the baseline, the targets
  const texts0 = new Map<string, string>();
  for (const [path, text] of files.texts) texts0.set(path, canonical(path, text).text);
  const baseline = check(texts0, true);
  if (baseline.internalError) return failure('the compiler reported E0999 on the baseline; this is filed against the compiler, not the task', texts0);
  const selected = selectTargets(task, files, baseline, texts0);
  if ('error' in selected) return failure(selected.error, texts0);
  const targets = selected.targets;
  const working: Working = { texts: new Map(texts0) };
  const trace: TraceEntry[] = [];
  const history: HistoryEntry[] = [];
  const proposals: Proposal[] = [];
  const messages: string[] = [];
  let tokens = 0;
  let mechanical = 0;
  let escalationSteps = 0;
  let cause: BlockedCause | null = null;
  let modelName = opts.model.name;

  const conclude = (status: 'opened' | 'blocked', final: CheckResult | null, best: { iteration: number; diagnostics: number; texts: Map<string, string> } | null): RunResult => {
    const findings = task.kind === 'regenerate' ? audit(baseline, final) : [];
    if (task.kind === 'regenerate' && findings.length > 0) proposals.push(...proposalsFromAudit(findings, task.scope.join(', '), trace.length));
    const bodyDiff: BodyDiff[] = [];
    for (const [path, after] of working.texts) {
      const before = texts0.get(path) ?? '';
      if (before !== after) bodyDiff.push({ file: path, module: [...files.paths].find(([, p]) => p === path)?.[0] ?? '', before, after });
    }
    const change: Change = {
      schema_version: 1,
      task,
      status,
      ...(cause === null ? {} : { cause }),
      generated: { at: new Date(now()).toISOString(), model: modelName },
      interface_diff: final === null ? [] : interfaceDiffs(task.scope, baseline, final),
      ledger_delta: final === null ? [] : ledgerDelta(baseline, final),
      body_diff: status === 'opened' ? bodyDiff : [],
      trace,
      metrics: { iterations: trace.length, mechanical_repairs: mechanical, escalation_steps: escalationSteps, proposals: proposals.length, tokens },
      proposals,
      audit: findings,
      ...(status === 'blocked' ? { last_diagnostics: history[history.length - 1]?.diagnostics ?? final?.json ?? [], best_attempt: best === null ? null : { iteration: best.iteration, diagnostics: best.diagnostics, bodies: bestBodies(best.texts, targets) } } : {}),
    };
    let path: string | null = null;
    if (opts.write !== false) {
      if (status === 'opened') for (const d of bodyDiff) writeFileSync(d.file, d.after);
      path = writeChange(opts.root, change);
    }
    return { status: status === 'opened' ? 'change' : 'blocked', change, error: null, path, texts: status === 'opened' ? working.texts : texts0 };
  };

  // A ticket produces a proposal only (§2, §5).
  if (task.kind === 'ticket') {
    const ctxIn = assemble({ task, files, baseline, check: baseline, targets: [], policy: task.context_policy, history, fullHistory: false, messages: ['This is a ticket. Do not write code. Answer with one JSON object describing the interface change it needs: {"kind": one of weaken_postcondition, add_precondition, widen_effects, add_claim, add_example, new_helper, unsatisfiable; "def": qualified name; "current": text or null; "proposed": text or null; "rationale": text}.'] });
    const t0 = now();
    let answer;
    try {
      answer = await opts.model.generate({ system: ctxIn.system, prompt: ctxIn.prompt, maxTokens: 4096 });
    } catch (e) {
      return failure(`model: ${e instanceof Error ? e.message : String(e)}`, texts0);
    }
    tokens += answer.tokens;
    modelName = answer.model;
    const proposal = parseProposal(answer.text, task.target?.def ?? task.scope[0] ?? '');
    if (proposal !== null) proposals.push(proposal);
    trace.push({ iteration: 1, model: answer.model, prompt_hash: ctxIn.hash, diagnostics_before: baseline.json.length, diagnostics_after: baseline.json.length, codes_after: [], failing_tests: [], mechanical_repairs: 0, tokens: answer.tokens, ms: now() - t0, classification: proposal === null ? 'no proposal' : 'proposal', escalation: null });
    return conclude('opened', baseline, null);
  }

  // Baseline state: diagnostics may name only the targets (§4 "prepare").
  const stray = baseline.json.filter((d) => !targets.some((t) => t.name === d.location.def && t.path === d.location.file));
  if (stray.length > 0 && task.kind !== 'interface_change') {
    cause = 'baseline';
    opts.log(`onus loop: the baseline has ${stray.length} diagnostic(s) outside the targets`);
    return conclude('blocked', baseline, null);
  }
  if (targets.length === 0) return conclude('opened', baseline, null);

  // implement and regenerate start from elided bodies (§2).
  if (task.kind === 'implement' || task.kind === 'regenerate') {
    for (const target of targets) {
      const text = working.texts.get(target.path);
      const parsed = text === undefined ? null : parseModule(target.path, text).module;
      const fn = parsed === null ? undefined : fnsOf(parsed).find((f) => f.name.text === target.name);
      if (text === undefined || fn === undefined || fn.body === null || fn.body.elided) continue;
      working.texts.set(target.path, canonical(target.path, spliceItem(text, fn, elide(fn))).text);
    }
  }

  let policy: ContextPolicy = task.kind === 'regenerate' ? 'none' : task.context_policy;
  let fullHistory = false;
  let ladder = 0;
  let pendingEscalation: string | null = null;
  let current: CheckResult | null = null;
  let grew = 0;
  const seen = new Set<string>();
  const seenBodies = new Map<string, Set<string>>();
  let claimEdits = 0;
  let helperAttempts = 0;
  let best: { iteration: number; diagnostics: number; texts: Map<string, string> } | null = null;

  for (let iteration = 1; iteration <= task.budget.iterations; iteration += 1) {
    if (now() - started > task.budget.wall_ms || tokens > task.budget.tokens) {
      cause = 'budget';
      break;
    }
    const ctxIn = assemble({ task, files, baseline, check: current ?? baseline, targets, policy, history, fullHistory, messages: messages.splice(0) });
    const t0 = now();
    let answer;
    try {
      answer = await opts.model.generate({ system: ctxIn.system, prompt: ctxIn.prompt, maxTokens: 8192 });
    } catch (e) {
      return failure(`model: ${e instanceof Error ? e.message : String(e)}`, texts0);
    }
    tokens += answer.tokens;
    modelName = answer.model;
    // The exchange, for anyone reading the work directory; change.json carries the prompt hash only (§6).
    writeFileSync(join(workDir, `prompt-${iteration}.md`), `${ctxIn.system}\n\n---\n\n${ctxIn.prompt}\n`);
    writeFileSync(join(workDir, `answer-${iteration}.md`), answer.text);
    const escalation = pendingEscalation;
    pendingEscalation = null;
    const before = current?.json.length ?? baseline.json.length;
    const record = (classification: Classification, after: CheckResult | null, syntax: readonly DiagnosticJson[], failing: readonly string[], repairs: number): void => {
      const diags = after?.json ?? syntax;
      trace.push({ iteration, model: answer.model, prompt_hash: ctxIn.hash, diagnostics_before: before, diagnostics_after: diags.length, codes_after: diags.map((d) => d.code), failing_tests: failing, mechanical_repairs: repairs, tokens: answer.tokens, ms: now() - t0, classification, escalation });
      opts.log(`onus loop: iteration ${iteration}: ${classification} (${diags.length} diagnostic${diags.length === 1 ? '' : 's'}${failing.length > 0 ? `, ${failing.length} failing test${failing.length === 1 ? '' : 's'}` : ''})`);
    };

    // generate: parse the answer; unparseable output is a syntax diagnostic fed back, not a retry (§4).
    const code = extractCode(answer.text);
    const fragment = parseFragment(code);
    if (fragment.module === null || fragment.diagnostics.length > 0) {
      history.push({ iteration, diagnostics: fragment.json, failingTests: [] });
      const sig = outcomeSignature(fragment.json, []);
      const stalled = seen.has(sig);
      seen.add(sig);
      messages.push('The previous answer did not parse as Onus; the diagnostics above are about that answer, not the file. The offending lines of that answer were:');
      messages.push(...syntaxNotes(fragment));
      record(stalled ? 'stall' : 'progress', null, fragment.json, [], 0);
      if (stalled && !escalate()) break;
      continue;
    }
    const returned = fnsOf(fragment.module);
    const extra = returned.filter((fn) => !targets.some((t) => t.name === fn.name.text));
    if (extra.length > 0) {
      helperAttempts += 1;
      if (helperAttempts >= 2 || fragment.module.items.length !== returned.length) {
        for (const fn of extra) proposals.push({ kind: 'new_helper', def: `${targets[0]?.module ?? ''}.${fn.name.text}`, current: null, proposed: signatureText(fn), evidence: { counterexample: null, iterations: iteration }, rationale: 'the model needed a helper it may not introduce (loop spec §4.1 step 3 is off)' });
        cause = 'out_of_scope';
        record('unusable', current, [], [], 0);
        break;
      }
      messages.push(`The answer added ${extra.map((fn) => `\`${fn.name.text}\``).join(', ')}; the loop may not add functions. Return only the targets.`);
    }
    const next = new Map(working.texts);
    let spliced = 0;
    let repeated = false;
    for (const target of targets) {
      const fn = returned.find((f) => f.name.text === target.name);
      if (fn === undefined) {
        messages.push(`The answer did not include \`${target.name}\`; return every target.`);
        continue;
      }
      if (signatureText(fn) !== signatureText(target.decl)) {
        claimEdits += 1;
        messages.push(`The signature of \`${target.name}\` was changed; only the body may change. Keep exactly:\n${signatureText(target.decl)}`);
        if (claimEdits >= 2) proposals.push(signatureProposal(target, fn, iteration));
        continue;
      }
      if (fn.body === null || fn.body.elided) {
        messages.push(`\`${target.name}\` came back without a body.`);
        continue;
      }
      const text = next.get(target.path);
      const parsed = text === undefined ? null : parseModule(target.path, text).module;
      const cur = parsed === null ? undefined : fnsOf(parsed).find((f) => f.name.text === target.name);
      if (text === undefined || cur === undefined) continue;
      const hash = bodyHash(withBody(target.decl, fn.body));
      const hashes = seenBodies.get(target.name) ?? new Set<string>();
      if (hashes.has(hash)) repeated = true;
      hashes.add(hash);
      seenBodies.set(target.name, hashes);
      next.set(target.path, canonical(target.path, spliceItem(text, cur, withBody(cur, fn.body))).text);
      spliced += 1;
    }
    if (claimEdits >= 2) {
      cause = 'out_of_scope';
      record('unusable', current, [], [], 0);
      break;
    }
    if (spliced === 0) {
      history.push({ iteration, diagnostics: current?.json ?? [], failingTests: [] });
      record('unusable', current, [], [], 0);
      if (!escalate()) break;
      continue;
    }
    working.texts.clear();
    for (const [k, v] of next) working.texts.set(k, v);

    // check, then mechanical repair inside target bodies, at most three rounds.
    let result = check(working.texts, true);
    let repairs = 0;
    for (let round = 0; round < 3 && !result.internalError && result.diagnostics.length > 0; round += 1) {
      const spans = targetBodySpans(result, targets);
      let changed = false;
      for (const [path, inside] of spans) {
        const text = working.texts.get(path);
        if (text === undefined) continue;
        const candidates = result.diagnostics.flatMap((d) => d.repairs.filter((r) => r.confidence === 'high'));
        const applied = applyRepairs(text, candidates, (span) => result.ctx.fileOf(span).path === path && inside.some((s) => s.start <= span.start && span.end <= s.end));
        if (applied.applied === 0) continue;
        working.texts.set(path, canonical(path, applied.text).text);
        repairs += applied.applied;
        changed = true;
      }
      if (!changed) break;
      result = check(working.texts, true);
    }
    mechanical += repairs;
    if (result.internalError) {
      cause = 'compiler_bug';
      current = result;
      record('unusable', result, [], [], repairs);
      break;
    }
    current = result;
    const failing = [...(result.tests ?? new Map<string, boolean>())].filter(([, ok]) => !ok).map(([name]) => name);
    history.push({ iteration, diagnostics: result.json, failingTests: failing });
    if (best === null || result.json.length + failing.length < best.diagnostics) best = { iteration, diagnostics: result.json.length + failing.length, texts: new Map(working.texts) };

    // classify
    const sig = outcomeSignature(result.json, failing);
    const conflicts = result.diagnostics.filter((d) => d.obligation !== null && d.obligation.counterexample !== null && targets.some((t) => t.name === d.def));
    let classification: Classification;
    if (result.diagnostics.length === 0 && failing.length === 0) classification = 'green';
    else if (conflicts.length > 0 && repeated) classification = 'contract conflict';
    else if (seen.has(sig)) classification = 'stall';
    else {
      const prev = history[history.length - 2];
      const prevSize = prev === undefined ? Number.POSITIVE_INFINITY : prev.diagnostics.length + prev.failingTests.length;
      const size = result.json.length + failing.length;
      const moved = prev !== undefined && ledgerDelta(current, current).length === 0 && false;
      if (size < prevSize || moved) {
        classification = 'progress';
        grew = 0;
      } else {
        grew += 1;
        classification = grew >= 2 ? 'stall' : 'grew';
      }
    }
    seen.add(sig);
    record(classification, result, [], failing, repairs);
    if (classification === 'green') return conclude('opened', result, best);
    if (classification === 'contract conflict') {
      for (const d of conflicts) {
        const target = targets.find((t) => t.name === d.def);
        const ob = d.obligation;
        if (ob === null) continue;
        proposals.push({
          kind: ob.kind === 'ensures' ? 'weaken_postcondition' : ob.kind === 'requires' ? 'add_precondition' : 'unsatisfiable',
          def: target === undefined ? d.def ?? '' : `${target.module}.${target.name}`,
          current: `${ob.kind} ${ob.text}`,
          proposed: null,
          evidence: { counterexample: ob.counterexample, iterations: iteration },
          rationale: 'the counterexample satisfies every precondition and violates the clause, and the model proposed the same body twice: the contract is likely wrong',
        });
      }
      cause = 'contract_conflict';
      break;
    }
    if (classification === 'stall' && !escalate()) break;
  }
  if (cause === null) cause = 'budget';
  return conclude('blocked', current, best);

  /** One rung of the ladder (§4.1) per stall; false when there is none left. */
  function escalate(): boolean {
    ladder += 1;
    escalationSteps += 1;
    for (;;) {
      if (ladder === 1) {
        fullHistory = true;
        pendingEscalation = 'full diagnostic history';
        return true;
      }
      if (ladder === 2) {
        if (policy === 'scope') {
          ladder += 1;
          continue;
        }
        policy = policy === 'none' ? 'module' : 'scope';
        pendingEscalation = `context policy ${policy}`;
        return true;
      }
      if (ladder === 3 || ladder === 4) {
        // Helper introduction and an alternate model are configuration in v0 and off (loop spec §4.1, §12).
        ladder += 1;
        continue;
      }
      cause = 'stall';
      return false;
    }
  }
}

/**
 * One note per syntax diagnostic of a model answer: the line it is on and
 * the tokens the grammar admits there (§14), which is what a model that
 * does not know Onus needs to hear. The fragment has a two-line module
 * header before the answer, so its line numbers are two ahead.
 */
function syntaxNotes(fragment: Parsed): string[] {
  const lines = fragment.file.text.split('\n');
  const out: string[] = [];
  const seenLines = new Set<number>();
  for (const d of fragment.diagnostics) {
    const before = fragment.file.text.slice(0, d.span.start);
    const line = before.split('\n').length;
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    const text = lines[line - 1];
    const lineStart = before.lastIndexOf('\n') + 1;
    const legal = legalTokenNames(fragment.file, lineStart).filter((t) => t !== 'newline' && t !== 'eof');
    out.push(`line ${line - 2}: \`${text === undefined ? '' : text.trim()}\` — ${d.code} ${d.title}${d.context.length > 0 ? `: ${d.context.join('; ')}` : ''}${legal.length > 0 ? `. A line here may start with: ${legal.join(' ')}` : ''}`);
    if (out.length >= 6) break;
  }
  return out;
}

function bestBodies(texts: ReadonlyMap<string, string>, targets: readonly TargetInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of targets) {
    const text = texts.get(target.path);
    const parsed = text === undefined ? null : parseModule(target.path, text).module;
    const fn = parsed === null ? undefined : fnsOf(parsed).find((f) => f.name.text === target.name);
    if (fn !== undefined) out[`${target.module}.${target.name}`] = printItem(fn).trim();
  }
  return out;
}

function signatureProposal(target: TargetInfo, proposed: A.FnDecl, iteration: number): Proposal {
  const effects = (s: string): string => /\bmay\b([^\n{]*)/.exec(s)?.[1]?.trim() ?? '';
  const a = signatureText(target.decl);
  const b = signatureText(proposed);
  return {
    kind: effects(a) !== effects(b) ? 'widen_effects' : 'weaken_postcondition',
    def: `${target.module}.${target.name}`,
    current: a,
    proposed: b,
    evidence: { counterexample: null, iterations: iteration },
    rationale: 'the model changed the signature twice; the loop may not edit a claim, so the change is proposed instead',
  };
}

function parseProposal(answer: string, fallbackDef: string): Proposal | null {
  const m = /\{[\s\S]*\}/.exec(answer);
  if (m === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const get = (k: string): unknown => (k in parsed ? (parsed as Record<string, unknown>)[k] : undefined);
  const kind = get('kind');
  const kinds = ['weaken_postcondition', 'add_precondition', 'widen_effects', 'add_claim', 'add_example', 'new_helper', 'unsatisfiable'] as const;
  const k = kinds.find((x) => x === kind) ?? 'unsatisfiable';
  return {
    kind: k,
    def: typeof get('def') === 'string' ? String(get('def')) : fallbackDef,
    current: typeof get('current') === 'string' ? String(get('current')) : null,
    proposed: typeof get('proposed') === 'string' ? String(get('proposed')) : null,
    evidence: { counterexample: null, iterations: 1 },
    rationale: typeof get('rationale') === 'string' ? String(get('rationale')) : answer.trim(),
  };
}

/** The functions a task is about (§2), with their baseline declarations. */
function selectTargets(task: Task, files: ProjectFiles, baseline: CheckResult, texts: ReadonlyMap<string, string>): { readonly targets: TargetInfo[] } | { readonly error: string } {
  const decls = new Map<string, { fn: A.FnDecl; module: string; path: string }>();
  for (const [module, path] of files.paths) {
    const text = texts.get(path);
    const parsed = text === undefined ? null : parseModule(path, text).module;
    if (parsed === null) return { error: `${path} does not parse` };
    for (const fn of fnsOf(parsed)) decls.set(`${module}.${fn.name.text}`, { fn, module, path });
  }
  const info = (d: { fn: A.FnDecl; module: string; path: string }): TargetInfo => ({ module: d.module, name: d.fn.name.text, path: d.path, decl: elide(d.fn) });
  switch (task.kind) {
    case 'implement':
    case 'repair': {
      const def = task.target?.def ?? '';
      const d = decls.get(def);
      if (d === undefined) return { error: `target ${def} is not a function in scope` };
      if (task.kind === 'repair' && (d.fn.body === null || d.fn.body.elided)) return { error: `target ${def} has no body to repair` };
      return { targets: [info(d)] };
    }
    case 'interface_change': {
      const targets: TargetInfo[] = [];
      for (const [, d] of decls) {
        if (d.fn.body === null || d.fn.body.elided) continue;
        if (baseline.json.some((x) => x.location.def === d.fn.name.text && x.location.file === d.path)) targets.push(info(d));
      }
      return { targets };
    }
    case 'regenerate':
      return { targets: [...decls].filter(([, d]) => d.fn.body !== null && !d.fn.body.elided).map(([, d]) => info(d)) };
    case 'ticket':
      return { targets: [] };
  }
}
