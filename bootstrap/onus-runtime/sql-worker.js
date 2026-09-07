/**
 * The Postgres side of `std.sql` (impl spec §5, M12): a worker thread that
 * owns the `pg` clients and answers the main thread's requests. Onus calls
 * are synchronous, so the main thread posts a request, blocks on
 * `Atomics.wait`, and reads the reply; this worker runs the asynchronous
 * driver and signals when the reply is posted. The worker signals once on
 * starting, before any request, so the main thread can tell a worker that
 * never started from a slow reply; `pg` is imported on the first connect,
 * so a runtime installed without it answers that connect with the reason
 * rather than dying before it can answer (docs/CHANGES.md item 199).
 */
import { parentPort, workerData } from 'node:worker_threads';
const data = workerData;
const port = data.port;
const flag = new Int32Array(data.signal);
const clients = new Map();
let nextConn = 1;
let driver = null;
/** The `pg` driver, imported on first use; throws with the resolution error when it is not installed. */
async function pgDriver() {
    if (driver === null) {
        const loaded = await import('pg');
        if (typeof loaded !== 'object' || loaded === null || !('default' in loaded))
            throw new Error('the pg package has no default export');
        driver = loaded.default;
    }
    return driver;
}
function fail(e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null;
    return { ok: false, error: e instanceof Error ? e.message : String(e), code };
}
async function handle(req) {
    switch (req.op) {
        case 'connect': {
            const driverModule = await pgDriver();
            const client = new driverModule.Client({ connectionString: req.dsn });
            await client.connect();
            const conn = nextConn++;
            clients.set(conn, client);
            return { ok: true, conn };
        }
        case 'query': {
            const client = clients.get(req.conn);
            if (client === undefined)
                return { ok: false, error: 'connection is closed', code: null };
            if (req.schema !== null)
                await client.query(`set search_path to "${req.schema.replace(/"/g, '""')}"`);
            await client.query(`set statement_timeout = ${req.timeoutMs === null ? 0 : Math.max(1, Math.floor(req.timeoutMs))}`);
            const r = await client.query({ text: req.text, values: [...req.params], rowMode: 'array' });
            const names = r.fields.map((f) => f.name);
            const rows = r.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
            return { ok: true, rows, rowCount: r.rowCount ?? rows.length };
        }
        case 'close': {
            for (const c of clients.values())
                await c.end().catch(() => undefined);
            clients.clear();
            return { ok: true };
        }
    }
}
port.on('message', (req) => {
    void handle(req)
        .catch(fail)
        .then((res) => {
        port.postMessage(res);
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
    });
});
void parentPort;
// Started: the main thread's first wait ends here, before any request is answered.
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
//# sourceMappingURL=sql-worker.js.map