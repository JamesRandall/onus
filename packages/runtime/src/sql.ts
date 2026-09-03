/**
 * `std.sql` at runtime. v0 ships no database driver: `connect` reports a
 * `Connection` error and nothing else can be reached without a `Db`. The
 * static guarantees of §8 do not depend on this module doing anything.
 */
import { Capability } from './capability.js';
import type { Net } from './io.js';
import { Panic, type Result } from './panic.js';
import type { TypeInfo } from './values.js';

export type DbMode = { readonly tag: 'ReadOnly' } | { readonly tag: 'ReadWrite' };
export type Error =
  | { readonly tag: 'Connection'; readonly detail: string }
  | { readonly tag: 'Refinement'; readonly row: number; readonly column: string }
  | { readonly tag: 'Timeout'; readonly after: number }
  | { readonly tag: 'Malformed'; readonly detail: string };

export class Db extends Capability {
  private constructor(readonly mode: DbMode) {
    super('sql.Db');
  }
}

export interface Param {
  readonly kind: 'int' | 'text';
  readonly value: number | string;
}
export interface Select<T> {
  readonly text: string;
  readonly params: readonly Param[];
  readonly row: TypeInfo;
  readonly __row?: T;
}
export interface Statement {
  readonly text: string;
  readonly params: readonly Param[];
}

export function int(x: number): Param {
  return { kind: 'int', value: x };
}
export function text(x: string): Param {
  return { kind: 'text', value: x };
}
export function select<T>(text: string, params: readonly Param[], row: TypeInfo): Select<T> {
  return { text, params, row };
}
export function statement(text: string, params: readonly Param[]): Statement {
  return { text, params };
}
export function connect(net: Net, dsn: string, mode: DbMode): Result<Db, Error> {
  void net;
  void mode;
  return { tag: 'Err', error: { tag: 'Connection', detail: `no SQL driver in v0 (dsn ${dsn})` } };
}
const unreachable = { kind: 'assumed', text: 'a Db exists', at: 'std.sql', def: 'sql' } as const;
/** Intrinsic convention: the `const` mode parameter `m` comes first. */
export function narrow(m: DbMode, db: Db, to: DbMode): Db {
  void m;
  void to;
  return db;
}
export function restrict(m: DbMode, db: Db, schema: string): Db {
  void m;
  void schema;
  return db;
}
export function deadline(m: DbMode, db: Db, ms: number): Db {
  void m;
  void ms;
  return db;
}
export function query<T>(db: Db, statement: Select<T>): Result<readonly T[], Error> {
  void db;
  void statement;
  throw new Panic(unreachable, 'sql.query without a driver');
}
export function execute(db: Db, statement: Statement): Result<undefined, Error> {
  void db;
  void statement;
  throw new Panic(unreachable, 'sql.execute without a driver');
}
