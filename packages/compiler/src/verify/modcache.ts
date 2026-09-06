/**
 * The module verification cache (impl spec §7.3).
 *
 * Verifying a module means building and discharging a condition for each
 * of its obligations, and the answers depend only on the module's canonical
 * text, the modules it imports (transitively), the solver and the budget.
 * So a module whose key was verified before, by this compiler, without a
 * diagnostic, need not be verified again: its obligations take the statuses
 * stored then. The key names the compiler (`ts` here, `self` for the
 * compiler in Onus), so the two never replay each other's results and the
 * differential between them stays a real comparison.
 *
 * An entry holds, in creation order, the final status and provenance of
 * every obligation of the module. A module is stored only when its
 * verification reported no diagnostic; a hit therefore reports none either,
 * the panic and const-fn rules being deterministic on statuses.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Context } from '../context.js';
import type { Obligation } from '../contracts/obligations.js';
import type { ModuleId } from '../resolve/defs.js';

/** Bumped when the entry format or the meaning of a key changes. */
export const FORMAT = 1;

export interface CachedStatus {
  readonly status: Obligation['status'];
  readonly by: string | null;
}

export interface ModuleEntry {
  readonly format: number;
  readonly obligations: readonly CachedStatus[];
}

/**
 * The cache key of every loaded module, computed bottom-up over the import
 * graph (a cycle is E0101, so the recursion ends). A module whose canonical
 * text is unknown (a syntax error) gets no key and is never cached.
 * Effects: none.
 */
export function moduleKeys(ctx: Context, compiler: string, solverVersion: string, budgetMs: number): Map<ModuleId, string> {
  const keys = new Map<ModuleId, string>();
  const visiting = new Set<ModuleId>();
  const keyOf = (id: ModuleId): string | null => {
    const known = keys.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const rec = ctx.resolve.moduleOf(id);
    const text = ctx.canonical.get(rec.file);
    if (text === undefined) return null;
    const parts: string[] = [`onus-modcache ${FORMAT}`, compiler, solverVersion, String(budgetMs), rec.name];
    for (const imp of rec.imports) {
      const k = keyOf(imp.module);
      if (k === null) return null;
      parts.push(`${ctx.resolve.moduleOf(imp.module).name} ${k}`);
    }
    parts.push(text);
    const key = bytesToHex(blake3(new TextEncoder().encode(parts.join('\n'))));
    keys.set(id, key);
    return key;
  };
  for (const m of ctx.resolve.modules) keyOf(m.id);
  return keys;
}

export class ModuleCache {
  constructor(private readonly dir: string | null) {}

  /** The stored entry for `key`, or null when there is none, the directory is disabled, or the entry is unreadable. Effects: reads a file. */
  get(key: string): ModuleEntry | null {
    if (this.dir === null) return null;
    const path = join(this.dir, `${key}.module.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (isEntry(parsed) && parsed.format === FORMAT) return parsed;
    } catch {
      // A corrupt entry is treated as a miss.
    }
    return null;
  }

  /** Stores the statuses of a module's obligations. Effects: writes a file. */
  set(key: string, obligations: readonly Obligation[]): void {
    if (this.dir === null) return;
    mkdirSync(this.dir, { recursive: true });
    const entry: ModuleEntry = { format: FORMAT, obligations: obligations.map((o) => ({ status: o.status, by: o.by })) };
    writeFileSync(join(this.dir, `${key}.module.json`), JSON.stringify(entry));
  }
}

const STATUSES = new Set(['pending', 'proved', 'checked', 'assumed', 'failed']);

function isEntry(v: unknown): v is ModuleEntry {
  if (typeof v !== 'object' || v === null || !('format' in v) || !('obligations' in v)) return false;
  const obligations: unknown = v.obligations;
  return typeof v.format === 'number' && Array.isArray(obligations) && obligations.every(isStatus);
}

function isStatus(o: unknown): o is CachedStatus {
  if (typeof o !== 'object' || o === null || !('status' in o) || !('by' in o)) return false;
  const status: unknown = o.status;
  const by: unknown = o.by;
  return typeof status === 'string' && STATUSES.has(status) && (typeof by === 'string' || by === null);
}
