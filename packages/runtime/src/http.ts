/**
 * `std.http` (language spec §19.1; docs/CHANGES.md item 196): one request,
 * one response, over the network capability. The runtime is synchronous, so
 * the request runs in a child node process doing `fetch`; the request
 * travels on its standard input, never on a command line, and the answer
 * comes back as one JSON line.
 */
import { spawnSync } from 'node:child_process';
import type { Net, Error as IoError } from './io.js';
import type { Result } from './panic.js';

export interface Response {
  readonly status: number;
  readonly body: string;
}

const CHILD = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const req = JSON.parse(input);
  const headers = {};
  for (const line of req.headers) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  try {
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
    if (req.timeout > 0) init.signal = AbortSignal.timeout(req.timeout);
    const res = await fetch(req.url, init);
    const body = await res.text();
    process.stdout.write(JSON.stringify({ status: res.status, body }));
  } catch (e) {
    const name = e !== null && typeof e === 'object' && 'name' in e ? String(e.name) : '';
    const message = e !== null && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
    const cause = e !== null && typeof e === 'object' && 'cause' in e && e.cause !== null && typeof e.cause === 'object' && 'message' in e.cause ? ': ' + String(e.cause.message) : '';
    process.stdout.write(JSON.stringify({ error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', detail: message + cause }));
  }
});
`;

/** `http.request`: the response, or `NotFound` for an unreachable host and `Other` for a request that did not complete. */
export function request(net: Net, method: string, url: string, headers: readonly string[], body: string, timeout_ms: number): Result<Response, IoError> {
  void net;
  const r = spawnSync(process.execPath, ['-e', CHILD], { input: JSON.stringify({ method, url, headers, body, timeout: timeout_ms }), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeout_ms > 0 ? timeout_ms + 5000 : undefined });
  if (r.error !== undefined) return { tag: 'Err', error: { tag: 'Other', detail: `http: ${r.error.message}` } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { tag: 'Err', error: { tag: 'Other', detail: `http: ${(r.stderr ?? '').trim() || 'no response'}` } };
  }
  if (typeof parsed !== 'object' || parsed === null) return { tag: 'Err', error: { tag: 'Other', detail: 'http: no response' } };
  if ('error' in parsed) {
    if (parsed.error === 'timeout') return { tag: 'Err', error: { tag: 'Other', detail: `the request to ${url} did not complete within ${timeout_ms} ms` } };
    return { tag: 'Err', error: { tag: 'NotFound', path: url } };
  }
  const status = 'status' in parsed && typeof parsed.status === 'number' ? parsed.status : 0;
  const text = 'body' in parsed && typeof parsed.body === 'string' ? parsed.body : '';
  return { tag: 'Ok', value: { status, body: text } };
}
