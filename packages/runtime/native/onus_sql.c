/*
 * `std.sql` for the native target over libpq (language spec §8.1, §8.2,
 * §18.2; impl spec M12). Mirrors the JavaScript runtime's sql.ts:
 *
 *   - `connect(mode: ReadOnly)` sets `default_transaction_read_only = on`,
 *     verifies it, and refuses a superuser role;
 *   - `narrow`, `restrict`, `deadline` derive handles sharing the connection;
 *   - `query` runs a `Select` and decodes rows through the compiler-generated
 *     decoder, which returns NULL and the rejected column on a refinement
 *     failure; a missing or ill-typed column is `Err(Malformed)`.
 *
 * Union tags: Result Ok = 0, Err = 1; sql.Error Connection = 0, Refinement = 1,
 * Timeout = 2, Malformed = 3; DbMode ReadOnly = 0, ReadWrite = 1.
 */
#include <libpq-fe.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "onus.h"

typedef struct {
  PGconn *conn;
  int64_t mode;
  onus_text *schema;
  int64_t deadline_ms;
} onus_db;

typedef struct {
  int64_t kind; /* 0 int, 1 text */
  onus_slot value;
} onus_param;

typedef onus_slot (*onus_decoder)(void *raw, onus_text **column);

typedef struct {
  onus_text *text;
  onus_list *params;
  onus_decoder decode;
} onus_select;

typedef struct {
  onus_text *text;
  onus_list *params;
} onus_statement;

typedef struct {
  PGresult *res;
  int row;
} onus_raw_row;

static PGconn **conns = NULL;
static int conn_count = 0;
static int conn_cap = 0;
static const char *malformed = NULL;

static onus_slot ptr_slot(const void *p) {
  return (onus_slot)(intptr_t)p;
}

static void *slot_ptr(onus_slot s) {
  return (void *)(intptr_t)s;
}

static onus_slot double_slot(double d) {
  onus_slot s;
  memcpy(&s, &d, sizeof s);
  return s;
}

static void *variant(int64_t tag, int n, const onus_slot *fields) {
  onus_slot *u = onus_alloc((int64_t)(8 * (1 + n)));
  u[0] = tag;
  for (int i = 0; i < n; i++) u[1 + i] = fields[i];
  return u;
}

static onus_slot ok(onus_slot value) {
  return ptr_slot(variant(0, 1, &value));
}

static onus_slot err(onus_slot error) {
  return ptr_slot(variant(1, 1, &error));
}

static onus_slot text_slot(const char *s) {
  return ptr_slot(onus_text_from(s, (int64_t)strlen(s)));
}

static onus_slot err_connection(const char *detail) {
  onus_slot d = text_slot(detail);
  return err(ptr_slot(variant(0, 1, &d)));
}

static onus_slot err_refinement(int64_t row, onus_text *column) {
  onus_slot fields[2] = {row, ptr_slot(column)};
  return err(ptr_slot(variant(1, 2, fields)));
}

static onus_slot err_timeout(int64_t after_nanos) {
  return err(ptr_slot(variant(2, 1, &after_nanos)));
}

static onus_slot err_malformed(const char *detail) {
  onus_slot d = text_slot(detail);
  return err(ptr_slot(variant(3, 1, &d)));
}

/* ------------------------------------------------------------------------ */
/* Statements and parameters                                                 */
/* ------------------------------------------------------------------------ */

onus_slot onus_sql_int(onus_slot x) {
  onus_param *p = onus_alloc((int64_t)sizeof(onus_param));
  p->kind = 0;
  p->value = x;
  return ptr_slot(p);
}

onus_slot onus_sql_text(onus_slot t) {
  onus_param *p = onus_alloc((int64_t)sizeof(onus_param));
  p->kind = 1;
  p->value = t;
  return ptr_slot(p);
}

onus_slot onus_sql_select(onus_slot text, onus_slot params, onus_slot row, onus_slot decoder) {
  (void)row;
  onus_select *s = onus_alloc((int64_t)sizeof(onus_select));
  s->text = slot_ptr(text);
  s->params = slot_ptr(params);
  s->decode = (onus_decoder)(intptr_t)decoder;
  return ptr_slot(s);
}

onus_slot onus_sql_statement(onus_slot text, onus_slot params) {
  onus_statement *s = onus_alloc((int64_t)sizeof(onus_statement));
  s->text = slot_ptr(text);
  s->params = slot_ptr(params);
  return ptr_slot(s);
}

/* ------------------------------------------------------------------------ */
/* Connections                                                               */
/* ------------------------------------------------------------------------ */

static onus_db *derive(onus_db *db, int64_t mode, onus_text *schema, int64_t deadline_ms) {
  onus_db *out = onus_alloc((int64_t)sizeof(onus_db));
  out->conn = db->conn;
  out->mode = mode;
  out->schema = schema;
  out->deadline_ms = deadline_ms;
  return out;
}

static int simple(PGconn *conn, const char *sql, char *value, size_t cap) {
  PGresult *r = PQexec(conn, sql);
  ExecStatusType st = PQresultStatus(r);
  int okay = st == PGRES_COMMAND_OK || st == PGRES_TUPLES_OK;
  if (okay && value != NULL && st == PGRES_TUPLES_OK && PQntuples(r) > 0) {
    strncpy(value, PQgetvalue(r, 0, 0), cap - 1);
    value[cap - 1] = '\0';
  } else if (value != NULL) value[0] = '\0';
  PQclear(r);
  return okay;
}

onus_slot onus_sql_connect(onus_slot net, onus_slot dsn, onus_slot mode) {
  (void)net;
  onus_text *d = slot_ptr(dsn);
  onus_slot *m = slot_ptr(mode);
  int64_t tag = m == NULL ? 1 : m[0];
  PGconn *conn = PQconnectdb(d->bytes);
  if (PQstatus(conn) != CONNECTION_OK) {
    onus_slot e = err_connection(PQerrorMessage(conn));
    PQfinish(conn);
    return e;
  }
  if (tag == 0) {
    char value[16];
    if (!simple(conn, "set default_transaction_read_only = on", NULL, 0)) {
      PQfinish(conn);
      return err_connection("cannot make the session read-only");
    }
    if (!simple(conn, "show default_transaction_read_only", value, sizeof value) || strcmp(value, "on") != 0) {
      PQfinish(conn);
      return err_connection("the session did not become read-only");
    }
    if (!simple(conn, "select rolsuper from pg_roles where rolname = current_user", value, sizeof value)) {
      PQfinish(conn);
      return err_connection("cannot verify the role");
    }
    if (strcmp(value, "t") == 0) {
      PQfinish(conn);
      return err_connection("the role is a superuser; a read-only session cannot be guaranteed");
    }
  }
  if (conn_count == conn_cap) {
    conn_cap = conn_cap == 0 ? 4 : conn_cap * 2;
    conns = realloc(conns, sizeof(PGconn *) * (size_t)conn_cap);
  }
  conns[conn_count++] = conn;
  onus_db *db = onus_alloc((int64_t)sizeof(onus_db));
  db->conn = conn;
  db->mode = tag;
  db->schema = NULL;
  db->deadline_ms = -1;
  return ok(ptr_slot(db));
}

onus_slot onus_sql_narrow(onus_slot m, onus_slot db, onus_slot to) {
  (void)m;
  onus_db *d = slot_ptr(db);
  onus_slot *mode = slot_ptr(to);
  return ptr_slot(derive(d, mode == NULL ? d->mode : mode[0], d->schema, d->deadline_ms));
}

onus_slot onus_sql_restrict(onus_slot m, onus_slot db, onus_slot schema) {
  (void)m;
  onus_db *d = slot_ptr(db);
  return ptr_slot(derive(d, d->mode, slot_ptr(schema), d->deadline_ms));
}

onus_slot onus_sql_deadline(onus_slot m, onus_slot db, onus_slot ms) {
  (void)m;
  onus_db *d = slot_ptr(db);
  return ptr_slot(derive(d, d->mode, d->schema, ms / 1000000));
}

void onus_sql_close_all(void) {
  for (int i = 0; i < conn_count; i++) PQfinish(conns[i]);
  conn_count = 0;
}

/* ------------------------------------------------------------------------ */
/* Queries                                                                   */
/* ------------------------------------------------------------------------ */

static PGresult *run(onus_db *db, onus_text *text, onus_list *params, onus_slot *error) {
  char buf[128];
  if (db->schema != NULL) {
    snprintf(buf, sizeof buf, "set search_path to \"%s\"", db->schema->bytes);
    if (!simple(db->conn, buf, NULL, 0)) {
      *error = err_malformed("cannot set the search path");
      return NULL;
    }
  }
  snprintf(buf, sizeof buf, "set statement_timeout = %lld", (long long)(db->deadline_ms < 0 ? 0 : (db->deadline_ms < 1 ? 1 : db->deadline_ms)));
  simple(db->conn, buf, NULL, 0);
  int n = (int)params->len;
  const char **values = onus_alloc((int64_t)(sizeof(char *) * (n < 1 ? 1 : n)));
  for (int i = 0; i < n; i++) {
    onus_param *p = slot_ptr(params->slots[i]);
    if (p->kind == 0) {
      char *s = onus_alloc(32);
      snprintf(s, 32, "%lld", (long long)p->value);
      values[i] = s;
    } else values[i] = ((onus_text *)slot_ptr(p->value))->bytes;
  }
  PGresult *res = PQexecParams(db->conn, text->bytes, n, NULL, values, NULL, NULL, 0);
  ExecStatusType st = PQresultStatus(res);
  if (st != PGRES_TUPLES_OK && st != PGRES_COMMAND_OK) {
    const char *state = PQresultErrorField(res, PG_DIAG_SQLSTATE);
    if (state != NULL && strcmp(state, "57014") == 0 && db->deadline_ms >= 0) *error = err_timeout(db->deadline_ms * 1000000);
    else *error = err_malformed(PQresultErrorMessage(res));
    PQclear(res);
    return NULL;
  }
  return res;
}

/* Reads one column of the current row as the Onus primitive `kind` (0 Int, 1 Text, 2 Float, 3 Bool). */
onus_slot onus_sql_column(onus_slot raw, onus_slot name, onus_slot kind) {
  onus_raw_row *r = slot_ptr(raw);
  onus_text *n = slot_ptr(name);
  int col = PQfnumber(r->res, n->bytes);
  if (col < 0 || PQgetisnull(r->res, r->row, col)) {
    malformed = "a column is missing or null";
    return 0;
  }
  const char *v = PQgetvalue(r->res, r->row, col);
  switch (kind) {
    case 0: {
      char *end;
      long long x = strtoll(v, &end, 10);
      if (*end != '\0' || x > 9007199254740991LL || x < -9007199254740991LL) {
        malformed = "a column is not an integer within the safe range";
        return 0;
      }
      return (onus_slot)x;
    }
    case 1:
      return ptr_slot(onus_text_from(v, (int64_t)strlen(v)));
    case 2: {
      char *end;
      double x = strtod(v, &end);
      if (*end != '\0') {
        malformed = "a column is not a number";
        return 0;
      }
      return double_slot(x);
    }
    case 3:
      return strcmp(v, "t") == 0 ? 1 : 0;
    default:
      malformed = "a column has a type the decoder cannot read";
      return 0;
  }
}

onus_slot onus_sql_query(onus_slot db, onus_slot select) {
  onus_db *d = slot_ptr(db);
  onus_select *s = slot_ptr(select);
  onus_slot error = 0;
  PGresult *res = run(d, s->text, s->params, &error);
  if (res == NULL) return error;
  int n = PQntuples(res);
  onus_list *out = onus_rt_list_new(n);
  for (int i = 0; i < n; i++) {
    onus_raw_row raw = {res, i};
    onus_text *column = NULL;
    malformed = NULL;
    onus_slot record = s->decode == NULL ? 0 : s->decode(&raw, &column);
    if (malformed != NULL) {
      PQclear(res);
      return err_malformed(malformed);
    }
    if (record == 0) {
      PQclear(res);
      return column == NULL ? err_malformed("the row type has no decoder") : err_refinement(i, column);
    }
    out->slots[i] = record;
  }
  PQclear(res);
  return ok(ptr_slot(out));
}

onus_slot onus_sql_execute(onus_slot db, onus_slot statement) {
  onus_db *d = slot_ptr(db);
  onus_statement *s = slot_ptr(statement);
  onus_slot error = 0;
  PGresult *res = run(d, s->text, s->params, &error);
  if (res == NULL) return error;
  PQclear(res);
  return ok(0);
}
