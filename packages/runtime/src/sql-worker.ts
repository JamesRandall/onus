/**
 * The Postgres side of `std.sql` (impl spec §5, M12): a worker thread that
 * owns the `pg` clients and answers the main thread's requests. Onus calls
 * are synchronous, so the main thread posts a request, blocks on
 * `Atomics.wait`, and reads the reply; this worker runs the asynchronous
 * driver and signals when the reply is posted.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import pg from 'pg';

export type SqlRequest =
  | { readonly op: 'connect'; readonly dsn: string }
  | { readonly op: 'query'; readonly conn: number; readonly text: string; readonly params: readonly (string | number)[]; readonly schema: string | null; readonly timeoutMs: number | null }
  | { readonly op: 'close' };

export type SqlResponse =
  | { readonly ok: true; readonly conn: number }
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly code: string | null };

interface Data {
  readonly port: MessagePort;
  readonly signal: SharedArrayBuffer;
}

const data = workerData as Data;
const port = data.port;
const flag = new Int32Array(data.signal);
const clients = new Map<number, pg.Client>();
let nextConn = 1;

function fail(e: unknown): SqlResponse {
  const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null;
  return { ok: false, error: e instanceof Error ? e.message : String(e), code };
}

async function handle(req: SqlRequest): Promise<SqlResponse> {
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
      if (client === undefined) return { ok: false, error: 'connection is closed', code: null };
      if (req.schema !== null) await client.query(`set search_path to "${req.schema.replace(/"/g, '""')}"`);
      await client.query(`set statement_timeout = ${req.timeoutMs === null ? 0 : Math.max(1, Math.floor(req.timeoutMs))}`);
      const r = await client.query({ text: req.text, values: [...req.params], rowMode: 'array' as const });
      const names = r.fields.map((f) => f.name);
      const rows = r.rows.map((row: unknown[]) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
      return { ok: true, rows, rowCount: r.rowCount ?? rows.length };
    }
    case 'close': {
      for (const c of clients.values()) await c.end().catch(() => undefined);
      clients.clear();
      return { ok: true };
    }
  }
}

port.on('message', (req: SqlRequest) => {
  void handle(req)
    .catch(fail)
    .then((res) => {
      port.postMessage(res);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
});

void parentPort;
