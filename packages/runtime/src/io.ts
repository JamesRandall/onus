/**
 * `std.io` capabilities over Node APIs (impl spec §5). Root capabilities are
 * constructed only by `runMain`.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { Capability } from './capability.js';
import type { Option, Result } from './panic.js';

export type Error = { readonly tag: 'NotFound'; readonly path: string } | { readonly tag: 'Denied'; readonly path: string } | { readonly tag: 'Other'; readonly detail: string };

export class Files extends Capability {
  private constructor() {
    super('io.Files');
  }
  /** @internal */
  static root(): Files {
    return new Files();
  }
}

export class Env extends Capability {
  private constructor() {
    super('io.Env');
  }
  /** @internal */
  static root(): Env {
    return new Env();
  }
}

export class Net extends Capability {
  private constructor() {
    super('io.Net');
  }
  /** @internal */
  static root(): Net {
    return new Net();
  }
}

export class Clock extends Capability {
  private constructor() {
    super('io.Clock');
  }
  /** @internal */
  static root(): Clock {
    return new Clock();
  }
}

export class Console extends Capability {
  private constructor() {
    super('io.Console');
  }
  /** @internal */
  static root(): Console {
    return new Console();
  }
}

export class File extends Capability {
  private constructor(readonly fd: number, readonly path: string) {
    super('io.File');
  }
  /** @internal */
  static open(fd: number, path: string): File {
    return new File(fd, path);
  }
}

const openFiles: File[] = [];

function ioError(e: unknown, path: string): Error {
  const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
  if (code === 'ENOENT') return { tag: 'NotFound', path };
  if (code === 'EACCES' || code === 'EPERM') return { tag: 'Denied', path };
  return { tag: 'Other', detail: e instanceof globalThis.Error ? e.message : String(e) };
}

export function create(files: Files, path: string): Result<File, Error> {
  void files;
  try {
    const f = File.open(openSync(path, 'w'), path);
    openFiles.push(f);
    return { tag: 'Ok', value: f };
  } catch (e) {
    return { tag: 'Err', error: ioError(e, path) };
  }
}

export function write(file: File, text: string): Result<undefined, Error> {
  try {
    writeSync(file.fd, text);
    return { tag: 'Ok', value: undefined };
  } catch (e) {
    return { tag: 'Err', error: ioError(e, file.path) };
  }
}

export function read(files: Files, path: string): Result<string, Error> {
  void files;
  try {
    return { tag: 'Ok', value: readFileSync(path, 'utf8') };
  } catch (e) {
    return { tag: 'Err', error: ioError(e, path) };
  }
}

export function print(console: Console, text: string): undefined {
  void console;
  process.stdout.write(text);
  return undefined;
}

export function eprint(console: Console, text: string): undefined {
  void console;
  process.stderr.write(text);
  return undefined;
}

export function get_env(env: Env, name: string): Option<string> {
  void env;
  const v = process.env[name];
  return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}

/** Closes every file opened through `create`. Called when `main` returns (§8.3). */
export function closeAll(): void {
  for (const f of openFiles.splice(0)) {
    try {
      closeSync(f.fd);
    } catch {
      // Already closed.
    }
  }
}
