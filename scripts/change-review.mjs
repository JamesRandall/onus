#!/usr/bin/env node
// The review artefacts of a change to self/ (.claude/skills/language-change/SKILL.md
// steps 3 and 6; docs/CHANGES.md item 186), under .onus/changes/<item>/, which
// git ignores:
//   node scripts/change-review.mjs begin <item> <module>...
//       snapshots the interface document of each module before the change
//       (before/<module>.json);
//   node scripts/change-review.mjs finish <item>
//       for every module snapshotted, writes the interface after the change as
//       JSON and as canonical text with bodies elided (after/), the §15.1
//       interface diff (<module>.diff.json), and one ledger.md over all of
//       them: every obligation added, removed, or changed in status.
// The documents come from the compiler in Onus under bootstrap/ (stage0), the
// compiler whose checks are the proof. A module is a name under self/
// (`native`) or a path.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'bootstrap', 'run_cli.js');
const [mode, item, ...modules] = process.argv.slice(2);
if ((mode !== 'begin' && mode !== 'finish') || item === undefined || (mode === 'begin' && modules.length === 0)) {
  process.stderr.write('usage: change-review.mjs begin <item> <module>... | finish <item>\n');
  process.exit(2);
}
const dir = join(root, '.onus', 'changes', item);

function sourceOf(module) {
  return module.endsWith('.onus') ? module : join(root, 'self', `${module}.onus`);
}

/** `onus interface` under stage0; `--diff` exits 1 for a breaking diff, which is still output. */
function onus(args) {
  try {
    return execFileSync(process.execPath, [cli, 'interface', ...args, '--root', join(root, 'self'), '--stdlib', join(root, 'packages', 'stdlib'), '--budget', '3000'], { encoding: 'utf8', cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (typeof e.stdout === 'string' && e.stdout.trim().length > 0) return e.stdout;
    throw e;
  }
}

if (mode === 'begin') {
  mkdirSync(join(dir, 'before'), { recursive: true });
  for (const m of modules) {
    const name = basename(sourceOf(m), '.onus');
    writeFileSync(join(dir, 'before', `${name}.json`), onus([sourceOf(m), '--json']));
    process.stdout.write(`change-review: ${item}: before/${name}.json\n`);
  }
} else {
  if (!existsSync(join(dir, 'before'))) {
    process.stderr.write(`change-review: no snapshots under ${dir}/before; run begin first\n`);
    process.exit(2);
  }
  mkdirSync(join(dir, 'after'), { recursive: true });
  const lines = [`# Ledger delta of change ${item}`, '', 'Every obligation added, removed, or changed in status, per module; a key is (definition, kind, text).', ''];
  for (const f of readdirSync(join(dir, 'before')).sort()) {
    if (!f.endsWith('.json')) continue;
    const name = basename(f, '.json');
    const source = sourceOf(name);
    const afterJson = onus([source, '--json']);
    writeFileSync(join(dir, 'after', `${name}.json`), afterJson);
    writeFileSync(join(dir, 'after', `${name}.onus.txt`), onus([source]));
    writeFileSync(join(dir, `${name}.diff.json`), onus([source, '--json', '--diff', join(dir, 'before', f)]));
    const before = JSON.parse(readFileSync(join(dir, 'before', f), 'utf8'));
    const after = JSON.parse(afterJson);
    const count = (ledger) => {
      const m = new Map();
      for (const o of ledger) {
        const k = JSON.stringify([o.def, o.kind, o.text]);
        const e = m.get(k) ?? { def: o.def, kind: o.kind, text: o.text, statuses: [] };
        e.statuses.push(o.status);
        m.set(k, e);
      }
      return m;
    };
    const b = count(before.ledger);
    const a = count(after.ledger);
    const tally = (ledger) => {
      const t = {};
      for (const o of ledger) t[o.status] = (t[o.status] ?? 0) + 1;
      return Object.entries(t).map(([k, v]) => `${v} ${k}`).join(', ');
    };
    lines.push(`## ${name}`, '', `Before: ${before.ledger.length} obligations (${tally(before.ledger) || 'none'}). After: ${after.ledger.length} (${tally(after.ledger) || 'none'}).`, '');
    let any = false;
    for (const [k, e] of a) {
      const prev = b.get(k);
      const sb = prev === undefined ? [] : [...prev.statuses].sort();
      const sa = [...e.statuses].sort();
      if (JSON.stringify(sb) === JSON.stringify(sa)) continue;
      any = true;
      const what = prev === undefined ? 'added' : sb.length === sa.length ? 'status changed' : sa.length > sb.length ? 'added (more instances)' : 'removed (fewer instances)';
      lines.push(`- ${what}: \`${e.def}\` ${e.kind} \`${e.text.replace(/\n/g, ' ')}\`: ${sb.join(', ') || '—'} → ${sa.join(', ')}`);
    }
    for (const [k, e] of b) {
      if (a.has(k)) continue;
      any = true;
      lines.push(`- removed: \`${e.def}\` ${e.kind} \`${e.text.replace(/\n/g, ' ')}\`: ${[...e.statuses].sort().join(', ')} → —`);
    }
    if (!any) lines.push('No change.');
    lines.push('');
    process.stdout.write(`change-review: ${item}: ${name}.diff.json, after/${name}.json, after/${name}.onus.txt\n`);
  }
  writeFileSync(join(dir, 'ledger.md'), `${lines.join('\n')}\n`);
  process.stdout.write(`change-review: ${item}: ledger.md\n`);
}
