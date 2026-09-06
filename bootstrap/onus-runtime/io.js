/**
 * `std.io` capabilities over Node APIs (impl spec §5). Root capabilities are
 * constructed only by `runMain`.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { Capability } from './capability.js';
export class Files extends Capability {
    constructor() {
        super('io.Files');
    }
    /** @internal */
    static root() {
        return new Files();
    }
}
export class Env extends Capability {
    constructor() {
        super('io.Env');
    }
    /** @internal */
    static root() {
        return new Env();
    }
}
export class Net extends Capability {
    constructor() {
        super('io.Net');
    }
    /** @internal */
    static root() {
        return new Net();
    }
}
/** `io.now`: nanoseconds since the program started, monotonic (docs/CHANGES.md item 183). */
export function now(clock) {
    void clock;
    return Math.round(performance.now() * 1_000_000);
}
export class Clock extends Capability {
    constructor() {
        super('io.Clock');
    }
    /** @internal */
    static root() {
        return new Clock();
    }
}
export class Console extends Capability {
    constructor() {
        super('io.Console');
    }
    /** @internal */
    static root() {
        return new Console();
    }
}
export class Process extends Capability {
    constructor() {
        super('io.Process');
    }
    /** @internal */
    static root() {
        return new Process();
    }
}
/** Runs `program` with `args`, feeding `stdin`; Err when it cannot start or exceeds `timeout_ms`. */
export function run(process, program, args, stdin, timeout_ms) {
    void process;
    const r = spawnSync(program, args, { input: stdin, encoding: 'utf8', timeout: timeout_ms });
    if (r.error !== undefined) {
        const code = 'code' in r.error && typeof r.error.code === 'string' ? r.error.code : '';
        if (code === 'ETIMEDOUT')
            return { tag: 'Err', error: { tag: 'Other', detail: `\`${program}\` did not finish within ${timeout_ms} ms` } };
        if (code === 'ENOENT')
            return { tag: 'Err', error: { tag: 'NotFound', path: program } };
        return { tag: 'Err', error: { tag: 'Other', detail: r.error.message } };
    }
    return { tag: 'Ok', value: { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } };
}
export class File extends Capability {
    fd;
    path;
    constructor(fd, path) {
        super('io.File');
        this.fd = fd;
        this.path = path;
    }
    /** @internal */
    static open(fd, path) {
        return new File(fd, path);
    }
}
const openFiles = [];
function ioError(e, path) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
    if (code === 'ENOENT')
        return { tag: 'NotFound', path };
    if (code === 'EACCES' || code === 'EPERM')
        return { tag: 'Denied', path };
    return { tag: 'Other', detail: e instanceof globalThis.Error ? e.message : String(e) };
}
export function create(files, path) {
    void files;
    try {
        const f = File.open(openSync(path, 'w'), path);
        openFiles.push(f);
        return { tag: 'Ok', value: f };
    }
    catch (e) {
        return { tag: 'Err', error: ioError(e, path) };
    }
}
export function write(file, text) {
    try {
        writeSync(file.fd, text);
        return { tag: 'Ok', value: undefined };
    }
    catch (e) {
        return { tag: 'Err', error: ioError(e, file.path) };
    }
}
/** Creates `path` and any missing parents; Ok when it already exists. */
/** `io.exec`: the program on this process's own standard streams; its exit status, -1 for a signal (docs/CHANGES.md item 184). */
export function exec(process, program, args) {
    void process;
    const r = spawnSync(program, args, { stdio: 'inherit' });
    if (r.error !== undefined) {
        const code = 'code' in r.error && typeof r.error.code === 'string' ? r.error.code : '';
        if (code === 'ENOENT')
            return { tag: 'Err', error: { tag: 'NotFound', path: program } };
        return { tag: 'Err', error: { tag: 'Other', detail: r.error.message } };
    }
    return { tag: 'Ok', value: r.status ?? -1 };
}
export function mkdir(files, path) {
    void files;
    try {
        mkdirSync(path, { recursive: true });
        return { tag: 'Ok', value: undefined };
    }
    catch (e) {
        return { tag: 'Err', error: { tag: 'Other', detail: e instanceof globalThis.Error ? e.message : String(e) } };
    }
}
export function read(files, path) {
    void files;
    try {
        return { tag: 'Ok', value: readFileSync(path, 'utf8') };
    }
    catch (e) {
        return { tag: 'Err', error: ioError(e, path) };
    }
}
export function print(console, text) {
    void console;
    process.stdout.write(text);
    return undefined;
}
export function eprint(console, text) {
    void console;
    process.stderr.write(text);
    return undefined;
}
export function get_env(env, name) {
    void env;
    const v = process.env[name];
    return v === undefined ? { tag: 'None' } : { tag: 'Some', value: v };
}
/** Closes every file opened through `create`. Called when `main` returns (§8.3). */
export function closeAll() {
    for (const f of openFiles.splice(0)) {
        try {
            closeSync(f.fd);
        }
        catch {
            // Already closed.
        }
    }
}
//# sourceMappingURL=io.js.map