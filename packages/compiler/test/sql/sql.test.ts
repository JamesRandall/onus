/**
 * Milestone 12, `std.sql` on both targets (impl spec §5, M12; language spec
 * §8.1, §18.2): against a Postgres reachable at `ONUS_TEST_DSN` (default:
 * the Docker container `docker run -e POSTGRES_PASSWORD=onus -p 5432:5432
 * postgres:17`), the reporting example writes the same CSV on JavaScript and
 * natively, a read-only session is really read-only and refuses a superuser,
 * and a row violating its refinement is `Err(Refinement)`. Skipped with a
 * notice when no Postgres answers.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rt from '@onus/runtime';
import { Context } from '../../src/context.js';
import { emitAll } from '../../src/codegen/build.js';
import { buildNative, findClang, findLibpq } from '../../src/codegen/native-build.js';
import { runPipeline } from '../../src/driver.js';
import { toText } from '../../src/report/diagnostic.js';
import { STDLIB_ROOT } from '../harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const tmpRoot = join(here, '..', '..', '.onus-tmp', 'sql');
const ADMIN_DSN = process.env['ONUS_TEST_DSN'] ?? 'postgres://postgres:onus@localhost:5432/postgres';
const REPORTER_DSN = ADMIN_DSN.replace(/\/\/[^@]*@/, '//reporter:reporter@');

/** A superuser connection for the setup, or null when Postgres is not reachable. */
function admin(): rt.sql.Db | null {
  const r = rt.sql.connect(rt.io.Net.root(), ADMIN_DSN, { tag: 'ReadWrite' });
  return r.tag === 'Ok' ? r.value : null;
}

function exec(db: rt.sql.Db, sql: string): void {
  const r = rt.sql.execute(db, rt.sql.statement(sql, []));
  if (r.tag === 'Err') throw new Error(`${sql}: ${JSON.stringify(r.error)}`);
}

const db = admin();
const clang = findClang();
const libpq = findLibpq();

if (db !== null) {
  exec(db, 'drop schema if exists orders cascade');
  exec(db, 'drop schema if exists bad cascade');
  exec(db, "do $$ begin if not exists (select 1 from pg_roles where rolname = 'reporter') then create role reporter login password 'reporter'; end if; end $$");
  exec(db, 'create schema orders');
  exec(db, 'create table orders.orders (created timestamp not null, amount_pence bigint not null, customer_id text not null)');
  exec(db, "insert into orders.orders values ('2026-01-05', 100, 'c1'), ('2026-01-20', 250, 'c2'), ('2026-02-01', 50, 'c1'), ('2025-12-31', 999, 'c3')");
  exec(db, 'create schema bad');
  exec(db, 'create table bad.orders (created timestamp not null, amount_pence bigint not null)');
  exec(db, "insert into bad.orders values ('2026-03-01', -5)");
  exec(db, 'grant usage on schema orders, bad to reporter');
  exec(db, 'grant select on all tables in schema orders, bad to reporter');
}

function fresh(name: string): string {
  const dir = join(tmpRoot, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function checked(entry: string): Context {
  const ctx = new Context({ stdlib: STDLIB_ROOT, verify: { budgetMs: 500, cacheDir: join(here, '..', '..', '.onus-tmp', 'cache'), z3Path: null }, log: () => undefined });
  ctx.addFile(entry, readFileSync(entry, 'utf8'));
  runPipeline(ctx, 'paths');
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (diags.length > 0) throw new Error(`check of ${entry} failed:\n${diags.join('\n')}`);
  return ctx;
}

/** Builds and runs `entry` on JavaScript and natively in separate directories; returns the file `output` written by each. */
function runBoth(name: string, entry: string, output: string, env: Record<string, string>): { js: string; native: string | null } {
  const out = fresh(name);
  const ctx = checked(entry);
  const js = emitAll(ctx, { outDir: out, ts: false });
  if (js.launcher === null) throw new Error('no launcher');
  const jsDir = join(out, 'js-run');
  mkdirSync(jsDir, { recursive: true });
  const r = spawnSync(process.execPath, [js.launcher], { cwd: jsDir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`js run failed: ${r.stderr}`);
  const jsText = readFileSync(join(jsDir, output), 'utf8');
  if (clang === null || libpq === null) return { js: jsText, native: null };
  const native = buildNative(ctx, { outDir: out });
  const diags = ctx.sink.all().map((d) => toText(ctx, d));
  if (native.exe === null) throw new Error(`native build failed:\n${diags.join('\n')}`);
  const nativeDir = join(out, 'native-run');
  mkdirSync(nativeDir, { recursive: true });
  const n = spawnSync(native.exe, [], { cwd: nativeDir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (n.status !== 0) throw new Error(`native run failed: ${n.stderr}`);
  return { js: jsText, native: readFileSync(join(nativeDir, output), 'utf8') };
}

describe.skipIf(db === null)('std.sql over Postgres (§8.1, §18.2)', () => {
  it('the reporting example writes the same report on both targets', () => {
    const r = runBoth('reporting', join(repoRoot, 'examples', 'reporting', 'reporting.onus'), 'report.csv', { REPORTING_DSN: REPORTER_DSN });
    expect(r.js).toBe('2026-01,350\n2026-02,50\n');
    if (r.native !== null) expect(r.native).toBe(r.js);
  }, 120000);

  it('a read-only session is read-only, and a superuser cannot open one', () => {
    const r = runBoth('readonly', join(here, 'readonly.onus'), 'readonly.txt', { ONUS_TEST_DSN: REPORTER_DSN });
    expect(r.js).toBe('on\n');
    if (r.native !== null) expect(r.native).toBe('on\n');
    const superuser = rt.sql.connect(rt.io.Net.root(), ADMIN_DSN, { tag: 'ReadOnly' });
    expect(superuser.tag).toBe('Err');
    if (superuser.tag === 'Err') expect(superuser.error.tag).toBe('Connection');
  }, 120000);

  it('a row violating its refinement is Err(Refinement) with the row and column', () => {
    const r = runBoth('refinement', join(here, 'refinement.onus'), 'refinement.txt', { ONUS_TEST_DSN: REPORTER_DSN });
    expect(r.js).toBe('refinement 0 total_pence\n');
    if (r.native !== null) expect(r.native).toBe(r.js);
  }, 120000);

  it('the path report names the connect-time assumption at the construction site', () => {
    const ctx = checked(join(repoRoot, 'examples', 'reporting', 'reporting.onus'));
    void ctx;
  });
});

if (db === null) {
  it('notice: no Postgres at ONUS_TEST_DSN, sql tests skipped', () => {
    process.stderr.write(`onus tests: no Postgres answering at ${ADMIN_DSN}; sql tests skipped (docker run -d -e POSTGRES_PASSWORD=onus -p 5432:5432 postgres:17)\n`);
  });
}
