/**
 * The program root (language spec §8.3): constructs the root capabilities
 * `main` names, calls it, closes resources, and turns its `Result` or a
 * `Panic` into an exit status with the failed obligation in the report.
 */
import * as io from './io.js';
import * as sql from './sql.js';
import { Panic, type Result } from './panic.js';

export type RootKind = 'Files' | 'Env' | 'Net' | 'Clock' | 'Console';

export interface MainSpec {
  /** Parameter name → root capability kind, for every capability parameter of `main`. */
  readonly roots: Readonly<Record<string, RootKind>>;
  /** The name of the `List[Text]` arguments parameter. */
  readonly args: string;
}

function root(kind: RootKind): io.Files | io.Env | io.Net | io.Clock | io.Console {
  switch (kind) {
    case 'Console':
      return io.Console.root();
    case 'Files':
      return io.Files.root();
    case 'Env':
      return io.Env.root();
    case 'Net':
      return io.Net.root();
    case 'Clock':
      return io.Clock.root();
  }
}

export function runMain(main: (params: Record<string, unknown>) => Result<unknown, unknown>, spec: MainSpec, argv: readonly string[]): number {
  const params: Record<string, unknown> = { [spec.args]: argv };
  for (const [name, kind] of Object.entries(spec.roots)) params[name] = root(kind);
  try {
    const r = main(params);
    if (r.tag === 'Err') {
      process.stderr.write(`main returned Err: ${JSON.stringify(r.error)}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof Panic) {
      process.stderr.write(`panic: ${e.message}\n`);
      return 2;
    }
    throw e;
  } finally {
    io.closeAll();
    sql.closeAll();
  }
}
