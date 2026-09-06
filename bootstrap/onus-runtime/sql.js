/**
 * `std.sql` at runtime (language spec §8.1, §8.2, §18.2; impl spec §5, M12):
 * the `Db` capability over Postgres through `pg`, driven synchronously by a
 * worker thread (`sql-worker.ts`).
 *
 *   - `connect(mode: ReadOnly)` sets `default_transaction_read_only = on`
 *     for the session, verifies the setting took, and refuses a superuser
 *     role, which could not be held to it; the remaining assumption — that
 *     the role keeps the privileges seen at connect time — is the leaf the
 *     ledger records at the construction site.
 *   - `narrow`, `restrict` and `deadline` derive handles that share the
 *     connection: `restrict` sets the search path for the handle's queries,
 *     `deadline` the statement timeout.
 *   - `query` runs a `Select` and decodes each row through the decoder the
 *     compiler generated for the row type, which applies the record's
 *     refinements and reports the failing row and column as
 *     `Err(Refinement)`; a missing or ill-typed column is `Err(Malformed)`.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { Capability } from './capability.js';
/** A refinement a decoded row violates. */
export class Rejected extends globalThis.Error {
    row;
    column;
    constructor(row, column) {
        super(`row ${row}: column ${column} violates its refinement`);
        this.row = row;
        this.column = column;
    }
}
class Malformed extends globalThis.Error {
}
export class Db extends Capability {
    conn;
    mode;
    schema;
    deadlineMs;
    constructor(conn, mode, schema, deadlineMs) {
        super('sql.Db');
        this.conn = conn;
        this.mode = mode;
        this.schema = schema;
        this.deadlineMs = deadlineMs;
    }
    /** @internal */
    static open(conn, mode) {
        return new Db(conn, mode, null, null);
    }
    /** @internal */
    derive(mode, schema, deadlineMs) {
        return new Db(this.conn, mode, schema, deadlineMs);
    }
}
export function int(x) {
    return { kind: 'int', value: x };
}
export function text(x) {
    return { kind: 'text', value: x };
}
export function select(text, params, row, decode = null) {
    return { text, params, row, decode };
}
export function statement(text, params) {
    return { text, params };
}
// ---------------------------------------------------------------------------
// The synchronous bridge
// ---------------------------------------------------------------------------
let bridge = null;
function request(req) {
    if (bridge === null) {
        const channel = new MessageChannel();
        const signal = new SharedArrayBuffer(4);
        const worker = new Worker(new URL('./sql-worker.js', import.meta.url), { workerData: { port: channel.port2, signal }, transferList: [channel.port2] });
        worker.unref();
        bridge = { worker, port: channel.port1, flag: new Int32Array(signal) };
    }
    Atomics.store(bridge.flag, 0, 0);
    bridge.port.postMessage(req);
    Atomics.wait(bridge.flag, 0, 0);
    const received = receiveMessageOnPort(bridge.port);
    if (received === undefined)
        return { ok: false, error: 'no reply from the SQL worker', code: null };
    return received.message;
}
function failure(res, timeoutNanos) {
    if (res.code === '57014' && timeoutNanos !== null)
        return { tag: 'Timeout', after: timeoutNanos };
    return { tag: 'Malformed', detail: res.error };
}
function scalar(rows, column) {
    const first = rows[0];
    return first === undefined ? undefined : first[column];
}
// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
export function connect(net, dsn, mode) {
    void net;
    const opened = request({ op: 'connect', dsn });
    if (!opened.ok)
        return { tag: 'Err', error: { tag: 'Connection', detail: opened.error } };
    if (!('conn' in opened))
        return { tag: 'Err', error: { tag: 'Connection', detail: 'no connection' } };
    const conn = opened.conn;
    const run = (text) => request({ op: 'query', conn, text, params: [], schema: null, timeoutMs: null });
    if (mode.tag === 'ReadOnly') {
        const set = run('set default_transaction_read_only = on');
        if (!set.ok)
            return { tag: 'Err', error: { tag: 'Connection', detail: `cannot make the session read-only: ${set.error}` } };
        const shown = run('show default_transaction_read_only');
        if (!shown.ok || !('rows' in shown) || scalar(shown.rows, 'default_transaction_read_only') !== 'on') {
            return { tag: 'Err', error: { tag: 'Connection', detail: 'the session did not become read-only' } };
        }
        const role = run('select rolsuper from pg_roles where rolname = current_user');
        if (!role.ok || !('rows' in role))
            return { tag: 'Err', error: { tag: 'Connection', detail: 'cannot verify the role' } };
        if (scalar(role.rows, 'rolsuper') === true)
            return { tag: 'Err', error: { tag: 'Connection', detail: 'the role is a superuser; a read-only session cannot be guaranteed' } };
    }
    return { tag: 'Ok', value: Db.open(conn, mode) };
}
/** Intrinsic convention: the `const` mode parameter `m` comes first. */
export function narrow(m, db, to) {
    void m;
    return db.derive(to, db.schema, db.deadlineMs);
}
export function restrict(m, db, schema) {
    void m;
    return db.derive(db.mode, schema, db.deadlineMs);
}
export function deadline(m, db, ms) {
    void m;
    return db.derive(db.mode, db.schema, ms / 1000000);
}
export function column(raw, name, kind, row) {
    const v = raw[name];
    if (v === undefined)
        throw new Malformed(`row ${row}: column ${name} is missing`);
    switch (kind) {
        case 'Int':
        case 'Duration': {
            const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : typeof v === 'bigint' ? Number(v) : NaN;
            if (!Number.isSafeInteger(n))
                throw new Malformed(`row ${row}: column ${name} is not an integer within ±2^53`);
            return n;
        }
        case 'Float': {
            const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
            if (Number.isNaN(n))
                throw new Malformed(`row ${row}: column ${name} is not a number`);
            return n;
        }
        case 'Bool':
            if (typeof v !== 'boolean')
                throw new Malformed(`row ${row}: column ${name} is not a boolean`);
            return v;
        case 'Text':
            return typeof v === 'string' ? v : String(v);
        default:
            throw new Malformed(`row ${row}: column ${name} has a type the decoder cannot read`);
    }
}
export function query(db, statement) {
    const timeoutNanos = db.deadlineMs === null ? null : db.deadlineMs * 1000000;
    const res = request({ op: 'query', conn: db.conn, text: statement.text, params: statement.params.map((p) => p.value), schema: db.schema, timeoutMs: db.deadlineMs });
    if (!res.ok)
        return { tag: 'Err', error: failure(res, timeoutNanos) };
    if (!('rows' in res))
        return { tag: 'Ok', value: [] };
    const decode = statement.decode;
    if (decode === null)
        return { tag: 'Err', error: { tag: 'Malformed', detail: 'the row type has no decoder' } };
    const out = [];
    try {
        res.rows.forEach((raw, i) => out.push(decode(raw, i)));
    }
    catch (e) {
        if (e instanceof Rejected)
            return { tag: 'Err', error: { tag: 'Refinement', row: e.row, column: e.column } };
        if (e instanceof Malformed)
            return { tag: 'Err', error: { tag: 'Malformed', detail: e.message } };
        throw e;
    }
    return { tag: 'Ok', value: out };
}
export function execute(db, statement) {
    const timeoutNanos = db.deadlineMs === null ? null : db.deadlineMs * 1000000;
    const res = request({ op: 'query', conn: db.conn, text: statement.text, params: statement.params.map((p) => p.value), schema: db.schema, timeoutMs: db.deadlineMs });
    if (!res.ok)
        return { tag: 'Err', error: failure(res, timeoutNanos) };
    return { tag: 'Ok', value: undefined };
}
/** Closes every connection and the worker. Called when `main` returns (§8.3). */
export function closeAll() {
    if (bridge === null)
        return;
    request({ op: 'close' });
    void bridge.worker.terminate();
    bridge = null;
}
//# sourceMappingURL=sql.js.map