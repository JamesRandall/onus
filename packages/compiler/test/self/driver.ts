/**
 * How the differential tests run a program of `self/` (impl spec M15.5): as
 * the JavaScript `onus build` emits, under node, or — with
 * `ONUS_SELF_NATIVE=1` — as the executable `onus build --target native`
 * produces, so that the same comparisons against the TypeScript compiler
 * hold for the compiler in Onus running natively. The native build needs
 * `clang`; without it the native mode is an error rather than a silent
 * fallback, since a run that claims to be native must be one.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import type { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, findClang } from '../../src/codegen/native-build.js';
import { toText } from '../../src/report/diagnostic.js';

export interface SelfDriver {
  /** The executable to spawn: node, or the native program. */
  readonly cmd: string;
  /** Arguments before the program's own: the launcher under node, nothing natively. */
  readonly prefix: readonly string[];
  readonly native: boolean;
}

/** Whether the tests run the programs of `self/` natively. Effects: reads the environment. */
export function selfNative(): boolean {
  return process.env['ONUS_SELF_NATIVE'] === '1';
}

/**
 * Builds the checked program `ctx` into `outDir` for the mode in force and
 * returns how to run it.
 * Preconditions: `ctx` ran the pipeline to `paths` without diagnostics.
 * Effects: writes `outDir`; natively, spawns `clang`. Throws when the build
 * fails or when the native mode has no `clang`.
 */
export function selfDriver(ctx: Context, outDir: string, what: string): SelfDriver {
  if (selfNative()) {
    if (findClang() === null) throw new Error(`ONUS_SELF_NATIVE=1 needs clang on PATH to build ${what}`);
    const r = buildNative(ctx, { outDir });
    const diags = ctx.sink.all().map((d) => toText(ctx, d));
    if (r.exe === null) throw new Error(`native build of ${what} failed:\n${diags.join('\n')}`);
    return { cmd: r.exe, prefix: [], native: true };
  }
  const built = emitAll(ctx, { outDir, ts: false });
  if (built.launcher === null) throw new Error(`no launcher for ${what}`);
  return { cmd: process.execPath, prefix: [built.launcher], native: false };
}

/** Runs the driver with `args` after its prefix. Effects: spawns a process. */
export function runDriver(driver: SelfDriver, args: readonly string[], options: SpawnSyncOptions & { encoding: 'utf8' }): SpawnSyncReturns<string> {
  return spawnSync(driver.cmd, [...driver.prefix, ...args], options);
}
