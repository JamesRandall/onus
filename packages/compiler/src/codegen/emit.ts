/**
 * Code generation (impl spec §6): one lowering, two emitters. `emitModule`
 * lowers a module to the target-neutral form (`lower.ts`, `ir.ts`) and
 * renders it as JavaScript (`js.ts`); the native emitter renders the same
 * form. The lowering decides everything about what the code does; an emitter
 * decides only how its target spells it.
 */
import type { Context } from '../context.js';
import type { DefId, ModuleRecord } from '../resolve/defs.js';
import type * as A from '../syntax/ast.js';
import { emitJs } from './js.js';
import { lowerModule } from './lower.js';

export interface EmitOptions {
  readonly ts: boolean;
  /** Module specifier for the runtime package. */
  readonly runtime: string;
  /** Emit each `verify` block as an exported Bool-returning function (`onus test --assumptions`, §20.2). */
  readonly verify?: boolean;
  /** Negate the guards of this property's generators (`onus test --mutate`, §20.4). */
  readonly negateGuard?: DefId;
}

/** An emitted `verify` function and what the launcher must supply to it. */
export interface VerifyEmit {
  /** Exported JavaScript name. */
  readonly name: string;
  /** Ledger key (§20.3). */
  readonly key: string;
  readonly claim: string;
  /** Qualified name of the function holding the `assume`. */
  readonly def: string;
  readonly at: string;
  readonly params: readonly { readonly name: string; readonly capability: DefId; readonly node: A.NodeId }[];
}

export interface EmittedModule {
  readonly module: ModuleRecord;
  readonly code: string;
  readonly verifies: readonly VerifyEmit[];
  /** A vitest file for the module's examples, properties and laws, or null when it has none. */
  readonly tests: string | null;
  /** Root capabilities of `main`, when the module declares one. */
  readonly main: { readonly roots: Readonly<Record<string, string>>; readonly args: string } | null;
}

/**
 * Emits one module as JavaScript (or TypeScript under `--emit ts`).
 * Preconditions: all passes through `paths` ran without diagnostics.
 * Effects: none (returns text).
 */
export function emitModule(ctx: Context, m: ModuleRecord, opts: EmitOptions): EmittedModule {
  return emitJs(ctx, lowerModule(ctx, m, opts.negateGuard === undefined ? { verify: opts.verify === true } : { verify: opts.verify === true, negateGuard: opts.negateGuard }), opts);
}
