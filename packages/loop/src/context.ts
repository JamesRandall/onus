/**
 * What the model sees (docs/onus-loop-v0.md §3), assembled from compiler
 * output: the targets in canonical Onus with bodies elided, the interfaces
 * of every module in scope and every import, sibling bodies as the context
 * policy allows, every diagnostic of the last check, failing examples, the
 * counterexample, and the standard library entries the targets' types
 * select. Never a prose conventions document. The one fixed text is a
 * short description of Onus syntax, which is language knowledge, not
 * behaviour.
 */
import { b3, interfaceText, printItem, type DiagnosticJson, type ast as A } from '@onus/compiler';
import { elide } from './edit.js';
import type { CheckResult, ProjectFiles } from './project.js';
import type { ContextPolicy, Task } from './task.js';

export interface TargetInfo {
  readonly module: string;
  readonly name: string;
  readonly path: string;
  /** The declaration with its body elided, from the baseline: the signature the body must fit. */
  readonly decl: A.FnDecl;
}

export interface HistoryEntry {
  readonly iteration: number;
  readonly diagnostics: readonly DiagnosticJson[];
  readonly failingTests: readonly string[];
}

export interface AssembleInput {
  readonly task: Task;
  readonly files: ProjectFiles;
  readonly baseline: CheckResult;
  readonly check: CheckResult;
  readonly targets: readonly TargetInfo[];
  readonly policy: ContextPolicy;
  readonly history: readonly HistoryEntry[];
  /** Escalation step 1: every earlier iteration's diagnostics, not only the last. */
  readonly fullHistory: boolean;
  /** Feedback from the loop itself: a changed signature, a missing function, unparseable output. */
  readonly messages: readonly string[];
}

export interface ModelContext {
  readonly system: string;
  readonly prompt: string;
  readonly hash: string;
}

export const SYSTEM = `You write function bodies in Onus, a language in which a model writes bodies, a human owns the contracts, and the compiler is the only checker.

Rules:
- Write only the bodies of the functions listed under "Targets". Return each target function complete, signature and body, inside one fenced code block marked onus, and nothing else.
- Never change a signature, contract (requires, ensures, decreases), effect list (may ...), claim, type, example or property. Never add functions, types or imports.
- Use only what the interfaces shown declare. Bodies of imports are not available and not needed.
- Every obligation must be proved or checked: satisfy every ensures on every path, establish every requires at every call, keep loop invariants, and give every loop a decreases measure.
- Prefer the simplest body that satisfies the contracts.

Onus syntax notes:
- Statements end at a newline. A block is { ... }. Comments start with --.
- let x: T = e   var x: T = e   x = e   return e
- if c { ... } else { ... }
- match e { Variant(field: pattern) => expr, _ => expr }; union values are built as Variant(field: value); records as Name { field: value }; a record is copied with { r with field: value }
- for i in lo ..< hi { ... } iterates a half-open range; loop while c decreases m { ... } is a while loop with a measure; both take invariant e clauses after the header.
- Calls name every argument: f(a: 1, b: 2). Results are Ok(value: v) and Err(error: e); options Some(value: v) and None. try e unwraps a Result or Option or returns early.
- Arithmetic on Int is checked; / and % are integer operations; comparison is == != < <= > >=; Bool uses and, or, not.
- A closure is fn(x: T) -> U { ... }. Text concatenation is ++.`;

function fnsOf(m: A.Module): A.FnDecl[] {
  return m.items.filter((i): i is A.FnDecl => i.kind === 'FnDecl');
}

const STD_BY_MENTION: readonly { readonly module: string; readonly pattern: RegExp }[] = [
  { module: 'std.text', pattern: /\bText\b/ },
  { module: 'std.list', pattern: /\bList\b/ },
  { module: 'std.grid', pattern: /\bGrid\b|\bgrid\./ },
  { module: 'std.map', pattern: /\bMap\b|\bmap\./ },
  { module: 'std.bytes', pattern: /\bBytes\b/ },
  { module: 'std.io', pattern: /\bio\./ },
  { module: 'std.sql', pattern: /\bsql\./ },
  { module: 'std.float', pattern: /\bFloat\b/ },
  { module: 'std.int', pattern: /\bInt\b/ },
];

/** Assembles the model context. Effects: none. */
export function assemble(input: AssembleInput): ModelContext {
  const { task, check, baseline, targets, policy } = input;
  const t = check.ctx.resolve;
  const sections: string[] = [];
  const targetNames = new Set(targets.map((x) => `${x.module}.${x.name}`));

  // 1. Targets: signatures, contracts, and the examples and properties that mention them.
  const targetTexts: string[] = [];
  for (const target of targets) {
    targetTexts.push(printItem(elide(target.decl)).trim());
    const mod = baseline.ctx.resolve.modules.find((m) => m.name === target.module);
    if (mod === undefined) continue;
    for (const item of mod.module.items) {
      if (item.kind !== 'ExampleDecl' && item.kind !== 'PropertyDecl') continue;
      const text = printItem(item).trim();
      if (item.name.text === target.name || text.includes(`${target.name}(`)) targetTexts.push(text);
    }
  }
  sections.push(`## Task\n\n${task.kind}${task.description === null ? '' : `: ${task.description}`}\n\n## Targets\n\n\`\`\`onus\n${targetTexts.join('\n\n')}\n\`\`\``);

  // 2. Interfaces of every module in scope and every import, bodies elided.
  const interfaceTexts: string[] = [];
  const seen = new Set<string>();
  const wanted: string[] = [...task.scope];
  for (const name of task.scope) {
    const mod = t.modules.find((m) => m.name === name);
    if (mod === undefined) continue;
    for (const imp of mod.imports) wanted.push(t.moduleOf(imp.module).name);
  }
  for (const name of wanted) {
    if (seen.has(name)) continue;
    seen.add(name);
    const mod = t.modules.find((m) => m.name === name);
    if (mod === undefined || mod.isStd) continue;
    interfaceTexts.push(interfaceText(check.ctx, mod.id).trim());
  }
  if (interfaceTexts.length > 0) sections.push(`## Interfaces\n\n\`\`\`onus\n${interfaceTexts.join('\n\n')}\n\`\`\``);

  // 3. Sibling bodies, per policy.
  if (policy !== 'none') {
    const bodies: string[] = [];
    const modules = policy === 'module' ? new Set(targets.map((x) => x.module)) : new Set(task.scope);
    for (const mod of t.modules) {
      if (!modules.has(mod.name)) continue;
      for (const fn of fnsOf(mod.module)) {
        if (targetNames.has(`${mod.name}.${fn.name.text}`) || fn.body === null || fn.body.elided) continue;
        bodies.push(printItem(fn).trim());
      }
    }
    if (bodies.length > 0) sections.push(`## Other functions in scope (for reference)\n\n\`\`\`onus\n${bodies.join('\n\n')}\n\`\`\``);
  }

  // 4. Diagnostics of the last check (every one, as JSON), and earlier ones under full history.
  const last = input.history[input.history.length - 1];
  const relevant = (d: DiagnosticJson): boolean => !(d.code === 'E0115' && d.location.def !== null && targets.some((x) => x.name === d.location.def));
  if (last !== undefined) {
    const shown = last.diagnostics.filter(relevant);
    if (shown.length > 0) sections.push(`## Diagnostics from the last check (${shown.length})\n\n${shown.map((d) => JSON.stringify(d)).join('\n')}`);
    else if (last.failingTests.length === 0 && input.history.length > 0) sections.push('## Diagnostics from the last check\n\nnone');
    if (last.failingTests.length > 0) {
      const bodies: string[] = [];
      for (const name of last.failingTests) {
        const short = name.split('.').pop() ?? name;
        for (const mod of baseline.ctx.resolve.modules) {
          for (const item of mod.module.items) {
            if ((item.kind === 'ExampleDecl' || item.kind === 'PropertyDecl') && `${mod.name}.${item.name.text}` === name) bodies.push(printItem(item).trim());
            else if (item.kind === 'ImplDecl' && short.startsWith('law ')) bodies.push(printItem(item).trim());
          }
        }
      }
      sections.push(`## Failing examples and properties (${last.failingTests.length})\n\n${last.failingTests.join('\n')}\n\n\`\`\`onus\n${bodies.join('\n\n')}\n\`\`\``);
    }
  }
  if (input.fullHistory && input.history.length > 1) {
    const earlier = input.history.slice(0, -1).map((h) => `iteration ${h.iteration}: ${h.diagnostics.filter(relevant).map((d) => `${d.code} ${d.title}${d.obligation === undefined ? '' : ` (${d.obligation.kind} ${d.obligation.text})`}`).join('; ') || 'no diagnostics'}${h.failingTests.length > 0 ? `; failing: ${h.failingTests.join(', ')}` : ''}`);
    sections.push(`## Earlier iterations\n\n${earlier.join('\n')}`);
  }

  // 5. Counterexamples: the task's, and those of the last diagnostics.
  const counterexamples: string[] = [];
  if (task.counterexample !== null) counterexamples.push(`from ${task.origin?.kind ?? 'the task'}${task.target?.obligation === null || task.target === null ? '' : ` against \`${task.target.obligation}\``}: ${JSON.stringify(task.counterexample)}`);
  for (const d of last?.diagnostics ?? []) {
    if (d.obligation !== undefined && d.obligation.counterexample !== null) counterexamples.push(`against \`${d.obligation.kind} ${d.obligation.text}\` in ${d.location.def ?? '?'}: ${JSON.stringify(d.obligation.counterexample)}`);
  }
  if (counterexamples.length > 0) sections.push(`## Counterexamples\n\n${counterexamples.join('\n')}`);

  // 6. Standard library entries, selected by the types the targets mention.
  const mention = targetTexts.join('\n');
  const stdTexts: string[] = [];
  for (const { module, pattern } of STD_BY_MENTION) {
    if (!pattern.test(mention)) continue;
    const mod = t.modules.find((m) => m.name === module);
    if (mod !== undefined) stdTexts.push(interfaceText(check.ctx, mod.id).trim());
  }
  if (stdTexts.length > 0) sections.push(`## Standard library\n\n\`\`\`onus\n${stdTexts.join('\n\n')}\n\`\`\``);

  // 7. The loop's own feedback.
  if (input.messages.length > 0) sections.push(`## Notes from the loop\n\n${input.messages.map((m) => `- ${m}`).join('\n')}`);

  const prompt = sections.join('\n\n');
  return { system: SYSTEM, prompt, hash: b3(`${SYSTEM}\n${prompt}`) };
}
