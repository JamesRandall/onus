/**
 * `std.io` capabilities over Node APIs (impl spec §5). Root capabilities are
 * constructed only by `runMain`.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
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

/** `io.now`: nanoseconds since the program started, monotonic (docs/CHANGES.md item 183). */
export function now(clock: Clock): number {
  void clock;
  return Math.round(performance.now() * 1_000_000);
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

export class Process extends Capability {
  private constructor() {
    super('io.Process');
  }
  /** @internal */
  static root(): Process {
    return new Process();
  }
}

/** What a program left behind (`std.io.Output`). */
export interface Output {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `program` with `args`, feeding `stdin`; Err when it cannot start or exceeds `timeout_ms`. */
export function run(process: Process, program: string, args: readonly string[], stdin: string, timeout_ms: number): Result<Output, Error> {
  void process;
  const r = spawnSync(program, args, { input: stdin, encoding: 'utf8', timeout: timeout_ms });
  if (r.error !== undefined) {
    const code = 'code' in r.error && typeof r.error.code === 'string' ? r.error.code : '';
    if (code === 'ETIMEDOUT') return { tag: 'Err', error: { tag: 'Other', detail: `\`${program}\` did not finish within ${timeout_ms} ms` } };
    if (code === 'ENOENT') return { tag: 'Err', error: { tag: 'NotFound', path: program } };
    return { tag: 'Err', error: { tag: 'Other', detail: r.error.message } };
  }
  return { tag: 'Ok', value: { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } };
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

/** Creates `path` and any missing parents; Ok when it already exists. */
/** `io.exec`: the program on this process's own standard streams; its exit status, -1 for a signal (docs/CHANGES.md item 184). */
export function exec(process: Process, program: string, args: readonly string[]): Result<number, Error> {
  void process;
  const r = spawnSync(program, args, { stdio: 'inherit' });
  if (r.error !== undefined) {
    const code = 'code' in r.error && typeof r.error.code === 'string' ? r.error.code : '';
    if (code === 'ENOENT') return { tag: 'Err', error: { tag: 'NotFound', path: program } };
    return { tag: 'Err', error: { tag: 'Other', detail: r.error.message } };
  }
  return { tag: 'Ok', value: r.status ?? -1 };
}

/** `io.remove_all`: a file, or a directory and everything under it; Ok when nothing is there (docs/CHANGES.md item 188). */
export function remove_all(files: Files, path: string): Result<undefined, Error> {
  void files;
  try {
    rmSync(path, { recursive: true, force: true });
    return { tag: 'Ok', value: undefined };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : '';
    if (code === 'EACCES' || code === 'EPERM') return { tag: 'Err', error: { tag: 'Denied', path } };
    return { tag: 'Err', error: { tag: 'Other', detail: e instanceof Error ? e.message : String(e) } };
  }
}

/** `io.list_dir`: a directory's names in code point order, `.` and `..` excluded (docs/CHANGES.md item 188). */
export function list_dir(files: Files, path: string): Result<readonly string[], Error> {
  void files;
  try {
    const names = readdirSync(path);
    names.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    return { tag: 'Ok', value: names };
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : '';
    if (code === 'ENOENT') return { tag: 'Err', error: { tag: 'NotFound', path } };
    if (code === 'EACCES' || code === 'EPERM') return { tag: 'Err', error: { tag: 'Denied', path } };
    return { tag: 'Err', error: { tag: 'Other', detail: e instanceof Error ? e.message : String(e) } };
  }
}

export function mkdir(files: Files, path: string): Result<undefined, Error> {
  void files;
  try {
    mkdirSync(path, { recursive: true });
    return { tag: 'Ok', value: undefined };
  } catch (e) {
    return { tag: 'Err', error: { tag: 'Other', detail: e instanceof globalThis.Error ? e.message : String(e) } };
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
