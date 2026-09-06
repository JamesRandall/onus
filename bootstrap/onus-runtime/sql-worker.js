/**
 * The Postgres side of `std.sql` (impl spec §5, M12): a worker thread that
 * owns the `pg` clients and answers the main thread's requests. Onus calls
 * are synchronous, so the main thread posts a request, blocks on
 * `Atomics.wait`, and reads the reply; this worker runs the asynchronous
 * driver and signals when the reply is posted.
 */
import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
const data = workerData;
const port = data.port;
const flag = new Int32Array(data.signal);
const clients = new Map();
let nextConn = 1;
function fail(e) {
    const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null;
    return { ok: false, error: e instanceof Error ? e.message : String(e), code };
}
async function handle(req) {
    switch (req.op) {
        case 'connect': {
            const client = new pg.Client({ connectionString: req.dsn });
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
//# sourceMappingURL=sql-worker.js.map