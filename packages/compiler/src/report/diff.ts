/**
 * Interface diffs (language spec §11.1, §15.1). Two interface documents of
 * the same module compared item by item. Compatibility is decided
 * textually in v0: a `requires` clause added or an `ensures` clause removed
 * is breaking, the reverse is compatible; a widened effect set or a changed
 * signature is breaking; new assumptions and recover sites are listed; an
 * obligation whose status left `proved` is listed as a regression. The
 * module is breaking when a public item is.
 */
import type { ContractEntry, InterfaceDocument, InterfaceItem } from './interface.js';

export interface ContractChange {
  readonly kind: ContractEntry['kind'];
  readonly text: string;
  readonly change: 'added' | 'removed';
  readonly compatibility: 'compatible' | 'breaking';
}

export interface ItemChange {
  readonly name: string;
  readonly kind: InterfaceItem['kind'];
  readonly visibility: InterfaceItem['visibility'];
  readonly signature: { readonly old: string; readonly new: string } | null;
  readonly effects: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly contracts: readonly ContractChange[];
  readonly assumes: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly recovers: { readonly added: number; readonly removed: number };
  readonly obligations: readonly { readonly kind: string; readonly text: string; readonly from: string; readonly to: string }[];
  readonly breaking: boolean;
}

export interface ItemRef {
  readonly name: string;
  readonly kind: InterfaceItem['kind'];
  readonly visibility: InterfaceItem['visibility'];
}

export interface InterfaceDiff {
  readonly module: string;
  readonly old_hash: string;
  readonly new_hash: string;
  readonly added: readonly ItemRef[];
  readonly removed: readonly ItemRef[];
  readonly changed: readonly ItemChange[];
  readonly breaking: boolean;
}

/**
 * Compares two interface documents.
 * Preconditions: both describe the same module (the names may differ only when a module was renamed, which is reported as every item removed and added).
 * Effects: none.
 */
export function interfaceDiff(before: InterfaceDocument, after: InterfaceDocument): InterfaceDiff {
  const key = (i: InterfaceItem): string => `${i.kind}:${i.name}`;
  const oldItems = new Map(before.items.map((i) => [key(i), i]));
  const newItems = new Map(after.items.map((i) => [key(i), i]));
  const ref = (i: InterfaceItem): ItemRef => ({ name: i.name, kind: i.kind, visibility: i.visibility });
  const added = after.items.filter((i) => !oldItems.has(key(i))).map(ref);
  const removed = before.items.filter((i) => !newItems.has(key(i))).map(ref);
  const changed: ItemChange[] = [];
  for (const [k, n] of newItems) {
    const o = oldItems.get(k);
    if (o === undefined) continue;
    const change = itemChange(o, n);
    if (change !== null) changed.push(change);
  }
  const breaking = removed.some((r) => r.visibility === 'pub') || changed.some((c) => c.breaking && c.visibility === 'pub');
  return { module: after.module, old_hash: before.hash, new_hash: after.hash, added, removed, changed, breaking };
}

function itemChange(o: InterfaceItem, n: InterfaceItem): ItemChange | null {
  const signature = o.signature === n.signature ? null : { old: o.signature, new: n.signature };
  const effects = { added: n.effects.filter((e) => !o.effects.includes(e)), removed: o.effects.filter((e) => !n.effects.includes(e)) };
  const contractKey = (c: ContractEntry): string => `${c.kind}:${c.text}`;
  const oldC = new Map(o.contracts.map((c) => [contractKey(c), c]));
  const newC = new Map(n.contracts.map((c) => [contractKey(c), c]));
  const contracts: ContractChange[] = [];
  for (const [k, c] of newC) if (!oldC.has(k)) contracts.push({ kind: c.kind, text: c.text, change: 'added', compatibility: c.kind === 'requires' ? 'breaking' : 'compatible' });
  for (const [k, c] of oldC) if (!newC.has(k)) contracts.push({ kind: c.kind, text: c.text, change: 'removed', compatibility: c.kind === 'ensures' ? 'breaking' : 'compatible' });
  const assumeKey = (a: InterfaceItem['assumes'][number]): string => `${a.claim}: ${a.justification}`;
  const oldA = new Set(o.assumes.map(assumeKey));
  const newA = new Set(n.assumes.map(assumeKey));
  const assumes = { added: [...newA].filter((a) => !oldA.has(a)), removed: [...oldA].filter((a) => !newA.has(a)) };
  const recovers = { added: Math.max(0, n.recovers.length - o.recovers.length), removed: Math.max(0, o.recovers.length - n.recovers.length) };
  const obligations: { kind: string; text: string; from: string; to: string }[] = [];
  for (const [k, c] of newC) {
    const prev = oldC.get(k);
    if (prev !== undefined && prev.status !== c.status) obligations.push({ kind: c.kind, text: c.text, from: prev.status, to: c.status });
  }
  const nothing = signature === null && effects.added.length === 0 && effects.removed.length === 0 && contracts.length === 0 && assumes.added.length === 0 && assumes.removed.length === 0 && recovers.added === 0 && recovers.removed === 0 && obligations.length === 0;
  if (nothing) return null;
  const breaking = signature !== null || effects.added.length > 0 || contracts.some((c) => c.compatibility === 'breaking') || obligations.some((x) => x.from === 'proved' && x.to !== 'proved');
  return { name: n.name, kind: n.kind, visibility: n.visibility, signature, effects, contracts, assumes, recovers, obligations, breaking };
}

/** A terminal rendering of a diff. Effects: none. */
export function diffText(d: InterfaceDiff): string {
  const lines = [`interface ${d.module}: ${d.breaking ? 'BREAKING' : 'compatible'} (${d.old_hash.slice(0, 11)} → ${d.new_hash.slice(0, 11)})`];
  for (const a of d.added) lines.push(`  + ${a.kind} ${a.name}`);
  for (const r of d.removed) lines.push(`  - ${r.kind} ${r.name}${r.visibility === 'pub' ? ' (pub: breaking)' : ''}`);
  for (const c of d.changed) {
    lines.push(`  ~ ${c.kind} ${c.name}${c.breaking ? ' (breaking)' : ''}`);
    if (c.signature !== null) lines.push(`      signature: ${c.signature.old}`, `              -> ${c.signature.new}`);
    if (c.effects.added.length > 0) lines.push(`      effects widened: ${c.effects.added.join(', ')}`);
    if (c.effects.removed.length > 0) lines.push(`      effects narrowed: ${c.effects.removed.join(', ')}`);
    for (const k of c.contracts) lines.push(`      ${k.change} ${k.kind} ${k.text} (${k.compatibility})`);
    for (const a of c.assumes.added) lines.push(`      new assumption: ${a}`);
    for (const a of c.assumes.removed) lines.push(`      assumption removed: ${a}`);
    if (c.recovers.added > 0) lines.push(`      ${c.recovers.added} new recover site(s)`);
    for (const o of c.obligations) lines.push(`      ${o.kind} ${o.text}: ${o.from} -> ${o.to}`);
  }
  return `${lines.join('\n')}\n`;
}
