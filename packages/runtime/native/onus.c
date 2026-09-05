/*
 * The Onus native runtime (language spec §19.1). See onus.h for the value
 * representation. Panics print the failed obligation in the same form as the
 * JavaScript runtime and exit with status 2 (§10.2).
 *
 * Union tags follow the standard library's declaration order:
 *   Result: Ok = 0, Err = 1        Option: Some = 0, None = 1
 *   io.Error: NotFound = 0, Denied = 1, Other = 2
 *   float.Class: Finite = 0, Infinite = 1, NotANumber = 2
 *   int.RangeError: NotFinite = 0, OutOfRange = 1
 */
#include "onus.h"

#include <errno.h>
#include <math.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------ */
/* Memory, panics                                                            */
/* ------------------------------------------------------------------------ */

void *onus_alloc(int64_t bytes) {
  void *p = calloc(1, (size_t)(bytes < 8 ? 8 : bytes));
  if (p == NULL) {
    fprintf(stderr, "panic: out of memory\n");
    exit(2);
  }
  return p;
}

/* `recover` frames (§10.2): a panic inside the innermost frame unwinds to it. */
typedef struct recover_frame {
  jmp_buf jb;
  struct recover_frame *prev;
  const char *kind;
  const char *text;
  const char *at;
} recover_frame;

static recover_frame *recover_top = NULL;

void onus_panic(const char *kind, const char *text, const char *at, const char *def) {
  if (recover_top != NULL) {
    recover_top->kind = kind;
    recover_top->text = text;
    recover_top->at = at;
    longjmp(recover_top->jb, 1);
  }
  fprintf(stderr, "panic: %s `%s` failed at %s in %s\n", kind, text, at, def);
  exit(2);
}

void onus_unreachable(void) {
  fprintf(stderr, "panic: unreachable\n");
  exit(2);
}

static onus_slot ptr_slot(const void *p) {
  return (onus_slot)(intptr_t)p;
}

static void *slot_ptr(onus_slot s) {
  return (void *)(intptr_t)s;
}

static double slot_double(onus_slot s) {
  double d;
  memcpy(&d, &s, sizeof d);
  return d;
}

static onus_slot double_slot(double d) {
  onus_slot s;
  memcpy(&s, &d, sizeof s);
  return s;
}

/* A variant with `n` payload slots. */
static void *onus_union(int64_t tag, int n, const onus_slot *fields) {
  onus_slot *u = onus_alloc((int64_t)(8 * (1 + n)));
  u[0] = tag;
  for (int i = 0; i < n; i++) u[1 + i] = fields[i];
  return u;
}

static void *ok(onus_slot value) {
  return onus_union(0, 1, &value);
}

static void *err(onus_slot error) {
  return onus_union(1, 1, &error);
}

typedef onus_slot (*onus_recover_fn)(void *env);
static void *ok(onus_slot value);
static void *err(onus_slot error);
static onus_slot ptr_slot(const void *p);
onus_text *onus_text_from(const char *bytes, int64_t len);

/* Runs `fn` over `env`; `Ok(value)`, or `Err(Panicked { obligation, location })` when it panicked. */
void *onus_recover(onus_slot (*fn)(void *), void *env) {
  recover_frame frame;
  frame.prev = recover_top;
  frame.kind = "";
  frame.text = "";
  frame.at = "";
  recover_top = &frame;
  if (setjmp(frame.jb) == 0) {
    onus_slot v = fn(env);
    recover_top = frame.prev;
    return ok(v);
  }
  recover_top = frame.prev;
  char obligation[512];
  snprintf(obligation, sizeof obligation, "%s %s", frame.kind, frame.text);
  onus_slot *panicked = onus_alloc(16);
  panicked[0] = ptr_slot(onus_text_from(obligation, (int64_t)strlen(obligation)));
  panicked[1] = ptr_slot(onus_text_from(frame.at, (int64_t)strlen(frame.at)));
  return err(ptr_slot(panicked));
}

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

onus_text *onus_text_from(const char *bytes, int64_t len) {
  onus_text *t = onus_alloc((int64_t)sizeof(onus_text) + len + 1);
  t->len = len;
  memcpy(t->bytes, bytes, (size_t)len);
  t->bytes[len] = '\0';
  return t;
}

onus_text *onus_rt_text_concat(onus_text *a, onus_text *b) {
  onus_text *t = onus_alloc((int64_t)sizeof(onus_text) + a->len + b->len + 1);
  t->len = a->len + b->len;
  memcpy(t->bytes, a->bytes, (size_t)a->len);
  memcpy(t->bytes + a->len, b->bytes, (size_t)b->len);
  t->bytes[t->len] = '\0';
  return t;
}

bool onus_rt_text_eq(onus_text *a, onus_text *b) {
  return a->len == b->len && memcmp(a->bytes, b->bytes, (size_t)a->len) == 0;
}

onus_slot onus_text_starts_with(onus_slot t, onus_slot prefix) {
  onus_text *a = slot_ptr(t);
  onus_text *p = slot_ptr(prefix);
  return p->len <= a->len && memcmp(a->bytes, p->bytes, (size_t)p->len) == 0;
}

onus_slot onus_bool_to_text(onus_slot b) {
  return ptr_slot(b ? onus_text_from("true", 4) : onus_text_from("false", 5));
}

/* ------------------------------------------------------------------------ */
/* Int, Float                                                                */
/* ------------------------------------------------------------------------ */

onus_slot onus_int_to_text(onus_slot x) {
#ifdef ONUS_BROKEN_INT_TO_TEXT
  return ptr_slot(onus_text_from("", 0)); /* a deliberately broken primitive, for the differential test */
#else
  char buf[32];
  int n = snprintf(buf, sizeof buf, "%lld", (long long)x);
  return ptr_slot(onus_text_from(buf, n));
#endif
}

onus_slot onus_int_floor(onus_slot bits) {
  double x = slot_double(bits);
  if (isnan(x) || isinf(x)) {
    onus_slot none[1] = {0};
    return ptr_slot(err(ptr_slot(onus_union(0, 0, none))));
  }
  double f = floor(x);
  if (f > 9007199254740991.0 || f < -9007199254740991.0) {
    onus_slot none[1] = {0};
    return ptr_slot(err(ptr_slot(onus_union(1, 0, none))));
  }
  return ptr_slot(ok((onus_slot)f));
}

onus_slot onus_float_of(onus_slot x) {
  return double_slot((double)x);
}

onus_slot onus_float_classify(onus_slot bits) {
  double x = slot_double(bits);
  onus_slot none[1] = {0};
  if (isnan(x)) return ptr_slot(onus_union(2, 0, none));
  if (isinf(x)) return ptr_slot(onus_union(1, 0, none));
  return ptr_slot(onus_union(0, 0, none));
}

/*
 * The shortest digit string that round-trips, laid out as JavaScript's
 * Number.prototype.toString lays it out (language spec §19.4: targets agree).
 */
static int shortest_digits(double x, char *digits, int *exponent) {
  char buf[40];
  for (int p = 1; p <= 17; p++) {
    snprintf(buf, sizeof buf, "%.*e", p - 1, x);
    if (strtod(buf, NULL) == x) break;
  }
  /* buf: [-]d[.ddd]e[+-]xx */
  const char *s = buf;
  if (*s == '-') s++;
  int k = 0;
  while (*s && *s != 'e') {
    if (*s != '.') digits[k++] = *s;
    s++;
  }
  digits[k] = '\0';
  int e = atoi(s + 1);
  while (k > 1 && digits[k - 1] == '0') digits[--k] = '\0';
  *exponent = e + 1; /* decimal point position: value = 0.d1d2... * 10^exponent */
  return k;
}

onus_slot onus_float_to_text(onus_slot bits) {
  double x = slot_double(bits);
  char out[64];
  if (isnan(x)) return ptr_slot(onus_text_from("NaN", 3));
  if (isinf(x)) return ptr_slot(x > 0 ? onus_text_from("Infinity", 8) : onus_text_from("-Infinity", 9));
  if (x == 0) return ptr_slot(onus_text_from("0", 1));
  char digits[32];
  int n;
  int k = shortest_digits(x, digits, &n);
  char *w = out;
  if (x < 0) *w++ = '-';
  if (k <= n && n <= 21) {
    memcpy(w, digits, (size_t)k);
    w += k;
    for (int i = 0; i < n - k; i++) *w++ = '0';
  } else if (0 < n && n <= 21) {
    memcpy(w, digits, (size_t)n);
    w += n;
    *w++ = '.';
    memcpy(w, digits + n, (size_t)(k - n));
    w += k - n;
  } else if (-6 < n && n <= 0) {
    *w++ = '0';
    *w++ = '.';
    for (int i = 0; i < -n; i++) *w++ = '0';
    memcpy(w, digits, (size_t)k);
    w += k;
  } else {
    *w++ = digits[0];
    if (k > 1) {
      *w++ = '.';
      memcpy(w, digits + 1, (size_t)(k - 1));
      w += k - 1;
    }
    w += sprintf(w, "e%c%d", n - 1 >= 0 ? '+' : '-', abs(n - 1));
  }
  *w = '\0';
  return ptr_slot(onus_text_from(out, (int64_t)(w - out)));
}

/* ------------------------------------------------------------------------ */
/* Lists                                                                     */
/* ------------------------------------------------------------------------ */

onus_list *onus_rt_list_new(int64_t len) {
  onus_list *xs = onus_alloc((int64_t)sizeof(onus_list) + 8 * (len < 1 ? 1 : len));
  xs->len = len;
  return xs;
}

int64_t onus_rt_list_len(onus_list *xs) {
  return xs->len;
}

onus_slot onus_rt_list_get(onus_list *xs, int64_t i) {
  if (i < 0 || i >= xs->len) onus_panic("requires", "0 <= i and i < len(xs: xs)", "std.list", "get");
  return xs->slots[i];
}

void onus_rt_list_set(onus_list *xs, int64_t i, onus_slot v) {
  if (i >= 0 && i < xs->len) xs->slots[i] = v;
}

onus_list *onus_rt_list_concat(onus_list *a, onus_list *b) {
  onus_list *out = onus_rt_list_new(a->len + b->len);
  memcpy(out->slots, a->slots, (size_t)(8 * a->len));
  memcpy(out->slots + a->len, b->slots, (size_t)(8 * b->len));
  return out;
}

/* std.list intrinsics, slot convention. */
onus_slot onus_list_len(onus_slot xs) {
  return onus_rt_list_len(slot_ptr(xs));
}

onus_slot onus_list_get(onus_slot xs, onus_slot i) {
  return onus_rt_list_get(slot_ptr(xs), i);
}

onus_slot onus_list_concat(onus_slot a, onus_slot b) {
  return ptr_slot(onus_rt_list_concat(slot_ptr(a), slot_ptr(b)));
}

onus_slot onus_list_append(onus_slot xs, onus_slot x) {
  onus_list *a = slot_ptr(xs);
  onus_list *out = onus_rt_list_new(a->len + 1);
  memcpy(out->slots, a->slots, (size_t)(8 * a->len));
  out->slots[a->len] = x;
  return ptr_slot(out);
}

onus_slot onus_list_replicate(onus_slot value, onus_slot n) {
  onus_list *out = onus_rt_list_new(n < 0 ? 0 : n);
  for (int64_t i = 0; i < out->len; i++) out->slots[i] = value;
  return ptr_slot(out);
}

onus_slot onus_list_slice(onus_slot xs, onus_slot lo, onus_slot hi) {
  onus_list *a = slot_ptr(xs);
  if (lo < 0 || hi > a->len || lo > hi) onus_panic("requires", "0 <= lo and lo <= hi and hi <= len(xs: xs)", "std.list", "slice");
  onus_list *out = onus_rt_list_new(hi - lo);
  memcpy(out->slots, a->slots + lo, (size_t)(8 * (hi - lo)));
  return ptr_slot(out);
}

/* ------------------------------------------------------------------------ */
/* Grids                                                                     */
/* ------------------------------------------------------------------------ */

onus_slot onus_grid_filled(onus_slot value, onus_slot width, onus_slot height) {
  if (width <= 0 || height <= 0) onus_panic("requires", "width > 0 and height > 0", "std.grid", "filled");
  onus_grid *g = onus_alloc((int64_t)sizeof(onus_grid) + 8 * width * height);
  g->width = width;
  g->height = height;
  for (int64_t i = 0; i < width * height; i++) g->cells[i] = value;
  return ptr_slot(g);
}

static void grid_bounds(onus_grid *g, int64_t x, int64_t y) {
  if (x < 0 || x >= g->width || y < 0 || y >= g->height) onus_panic("requires", "0 <= x and x < w and 0 <= y and y < h", "std.grid", "Grid");
}

onus_slot onus_grid_get(onus_slot w, onus_slot h, onus_slot grid, onus_slot x, onus_slot y) {
  (void)w;
  (void)h;
  onus_grid *g = slot_ptr(grid);
  grid_bounds(g, x, y);
  return g->cells[y * g->width + x];
}

onus_slot onus_grid_set(onus_slot w, onus_slot h, onus_slot *grid, onus_slot x, onus_slot y, onus_slot value) {
  (void)w;
  (void)h;
  onus_grid *g = slot_ptr(*grid);
  grid_bounds(g, x, y);
  g->cells[y * g->width + x] = value;
  return 0;
}

/* ------------------------------------------------------------------------ */
/* io                                                                        */
/* ------------------------------------------------------------------------ */

typedef struct {
  FILE *fp;
  onus_text *path;
} onus_file;

static onus_file **open_files = NULL;
static int open_count = 0;
static int open_cap = 0;

static void *io_error(onus_text *path) {
  onus_slot field = ptr_slot(path);
  if (errno == ENOENT) return onus_union(0, 1, &field);
  if (errno == EACCES || errno == EPERM) return onus_union(1, 1, &field);
  onus_slot detail = ptr_slot(onus_text_from(strerror(errno), (int64_t)strlen(strerror(errno))));
  return onus_union(2, 1, &detail);
}

onus_slot onus_io_create(onus_slot files, onus_slot path) {
  (void)files;
  onus_text *p = slot_ptr(path);
  FILE *fp = fopen(p->bytes, "w");
  if (fp == NULL) return ptr_slot(err(ptr_slot(io_error(p))));
  onus_file *f = onus_alloc((int64_t)sizeof(onus_file));
  f->fp = fp;
  f->path = p;
  if (open_count == open_cap) {
    open_cap = open_cap == 0 ? 8 : open_cap * 2;
    open_files = realloc(open_files, sizeof(onus_file *) * (size_t)open_cap);
  }
  open_files[open_count++] = f;
  return ptr_slot(ok(ptr_slot(f)));
}

onus_slot onus_io_write(onus_slot file, onus_slot text) {
  onus_file *f = slot_ptr(file);
  onus_text *t = slot_ptr(text);
  if (fwrite(t->bytes, 1, (size_t)t->len, f->fp) != (size_t)t->len) return ptr_slot(err(ptr_slot(io_error(f->path))));
  fflush(f->fp); /* a write is visible at once, as on the JavaScript target */
  return ptr_slot(ok(0));
}

onus_slot onus_io_get_env(onus_slot env, onus_slot name) {
  (void)env;
  onus_text *n = slot_ptr(name);
  const char *v = getenv(n->bytes);
  onus_slot none[1] = {0};
  if (v == NULL) return ptr_slot(onus_union(1, 0, none));
  onus_slot some = ptr_slot(onus_text_from(v, (int64_t)strlen(v)));
  return ptr_slot(onus_union(0, 1, &some));
}

static void close_all(void) {
  for (int i = 0; i < open_count; i++) fclose(open_files[i]->fp);
  open_count = 0;
}

/* ------------------------------------------------------------------------ */
/* Program entry                                                             */
/* ------------------------------------------------------------------------ */

static int examples_failed = 0;
static int examples_run = 0;

int onus_start(int argc, char **argv) {
  return argc > 1 && strcmp(argv[1], "--onus-examples") == 0 ? 1 : 0;
}

onus_list *onus_args(int argc, char **argv) {
  onus_list *xs = onus_rt_list_new(argc > 1 ? argc - 1 : 0);
  for (int i = 1; i < argc; i++) xs->slots[i - 1] = ptr_slot(onus_text_from(argv[i], (int64_t)strlen(argv[i])));
  return xs;
}

void *onus_root(const char *kind) {
  onus_text *t = onus_text_from(kind, (int64_t)strlen(kind));
  return t;
}

#ifndef ONUS_NO_SQL
void onus_sql_close_all(void);
#endif

int onus_finish(void *result) {
  onus_slot *r = result;
  close_all();
#ifndef ONUS_NO_SQL
  onus_sql_close_all();
#endif
  if (r != NULL && r[0] != 0) {
    fprintf(stderr, "main returned Err\n");
    return 1;
  }
  return 0;
}

void onus_report_example(const char *name, bool ok) {
  examples_run++;
  if (!ok) examples_failed++;
  printf("%s %s\n", ok ? "ok" : "FAIL", name);
}

int onus_examples_done(void) {
  close_all();
  printf("%d examples, %d failed\n", examples_run, examples_failed);
  return examples_failed == 0 ? 0 : 1;
}

/* ------------------------------------------------------------------------ */
/* std.text by code points (UTF-8 in memory), std.int/float parsing,        */
/* std.list builders, std.io read and console — milestone 15.0              */
/* ------------------------------------------------------------------------ */

static int64_t utf8_decode(const char *s, int64_t len, int64_t *i) {
  unsigned char c = (unsigned char)s[*i];
  int64_t cp;
  int n;
  if (c < 0x80) { cp = c; n = 1; }
  else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; n = 2; }
  else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; n = 3; }
  else { cp = c & 0x07; n = 4; }
  for (int k = 1; k < n; k++) {
    if (*i + k >= len) { n = k; break; }
    cp = (cp << 6) | ((unsigned char)s[*i + k] & 0x3F);
  }
  *i += n;
  return cp;
}

static int utf8_encode(int64_t cp, char *out) {
  if (cp < 0x80) { out[0] = (char)cp; return 1; }
  if (cp < 0x800) { out[0] = (char)(0xC0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
  if (cp < 0x10000) { out[0] = (char)(0xE0 | (cp >> 12)); out[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[2] = (char)(0x80 | (cp & 0x3F)); return 3; }
  out[0] = (char)(0xF0 | (cp >> 18)); out[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); out[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

static int64_t text_count(onus_text *t) {
  int64_t n = 0;
  for (int64_t i = 0; i < t->len; i++) if (((unsigned char)t->bytes[i] & 0xC0) != 0x80) n++;
  return n;
}

/* Byte offset of code point index `cp` (t->len when cp is the count). */
static int64_t byte_offset(onus_text *t, int64_t cp) {
  int64_t i = 0;
  int64_t seen = 0;
  while (i < t->len && seen < cp) {
    utf8_decode(t->bytes, t->len, &i);
    seen++;
  }
  return i;
}

static int64_t cp_index(onus_text *t, int64_t byte) {
  int64_t n = 0;
  for (int64_t i = 0; i < byte && i < t->len; i++) if (((unsigned char)t->bytes[i] & 0xC0) != 0x80) n++;
  return n;
}

static onus_slot some(onus_slot v) { return ptr_slot(onus_union(0, 1, &v)); }
static onus_slot none(void) { onus_slot z[1] = {0}; return ptr_slot(onus_union(1, 0, z)); }

onus_slot onus_text_count(onus_slot t) { return text_count(slot_ptr(t)); }

onus_slot onus_text_code_points(onus_slot t) {
  onus_text *a = slot_ptr(t);
  onus_list *out = onus_rt_list_new(text_count(a));
  int64_t i = 0;
  int64_t k = 0;
  while (i < a->len) out->slots[k++] = utf8_decode(a->bytes, a->len, &i);
  return ptr_slot(out);
}

onus_slot onus_text_of_code_points(onus_slot cps) {
  onus_list *xs = slot_ptr(cps);
  char *buf = malloc((size_t)(4 * xs->len + 1));
  int64_t n = 0;
  for (int64_t i = 0; i < xs->len; i++) n += utf8_encode(xs->slots[i], buf + n);
  onus_text *out = onus_text_from(buf, n);
  free(buf);
  return ptr_slot(out);
}

onus_slot onus_text_of_code_point(onus_slot cp) {
  char buf[4];
  int n = utf8_encode(cp, buf);
  return ptr_slot(onus_text_from(buf, n));
}

onus_slot onus_text_slice(onus_slot t, onus_slot from, onus_slot to) {
  onus_text *a = slot_ptr(t);
  int64_t lo = byte_offset(a, from);
  int64_t hi = byte_offset(a, to);
  if (hi < lo) hi = lo;
  return ptr_slot(onus_text_from(a->bytes + lo, hi - lo));
}

static int64_t find_bytes(onus_text *hay, onus_text *pin, int64_t start) {
  if (pin->len == 0) return start <= hay->len ? start : -1;
  for (int64_t i = start; i + pin->len <= hay->len; i++) {
    if (memcmp(hay->bytes + i, pin->bytes, (size_t)pin->len) == 0) return i;
  }
  return -1;
}

onus_slot onus_text_index_of(onus_slot t, onus_slot needle, onus_slot from) {
  onus_text *a = slot_ptr(t);
  int64_t at = find_bytes(a, slot_ptr(needle), byte_offset(a, from));
  return at < 0 ? none() : some(cp_index(a, at));
}

onus_slot onus_text_contains(onus_slot t, onus_slot needle) {
  return find_bytes(slot_ptr(t), slot_ptr(needle), 0) >= 0;
}

onus_slot onus_text_ends_with(onus_slot t, onus_slot suffix) {
  onus_text *a = slot_ptr(t);
  onus_text *s = slot_ptr(suffix);
  return s->len <= a->len && memcmp(a->bytes + a->len - s->len, s->bytes, (size_t)s->len) == 0;
}

onus_slot onus_text_split(onus_slot t, onus_slot sep) {
  onus_text *a = slot_ptr(t);
  onus_text *s = slot_ptr(sep);
  if (s->len == 0) {
    /* An empty separator splits into code points; an empty text is one empty part. */
    if (a->len == 0) {
      onus_list *one = onus_rt_list_new(1);
      one->slots[0] = ptr_slot(onus_text_from("", 0));
      return ptr_slot(one);
    }
    onus_list *out = onus_rt_list_new(text_count(a));
    int64_t i = 0;
    int64_t k = 0;
    while (i < a->len) {
      int64_t start = i;
      utf8_decode(a->bytes, a->len, &i);
      out->slots[k++] = ptr_slot(onus_text_from(a->bytes + start, i - start));
    }
    return ptr_slot(out);
  }
  int64_t parts = 1;
  for (int64_t i = 0; (i = find_bytes(a, s, i)) >= 0; i += s->len) parts++;
  onus_list *out = onus_rt_list_new(parts);
  int64_t k = 0;
  int64_t start = 0;
  for (;;) {
    int64_t at = find_bytes(a, s, start);
    if (at < 0) {
      out->slots[k++] = ptr_slot(onus_text_from(a->bytes + start, a->len - start));
      break;
    }
    out->slots[k++] = ptr_slot(onus_text_from(a->bytes + start, at - start));
    start = at + s->len;
  }
  return ptr_slot(out);
}

onus_slot onus_text_join(onus_slot parts, onus_slot sep) {
  onus_list *xs = slot_ptr(parts);
  onus_text *s = slot_ptr(sep);
  int64_t total = 0;
  for (int64_t i = 0; i < xs->len; i++) total += ((onus_text *)slot_ptr(xs->slots[i]))->len + (i > 0 ? s->len : 0);
  char *buf = malloc((size_t)total + 1);
  int64_t n = 0;
  for (int64_t i = 0; i < xs->len; i++) {
    if (i > 0) { memcpy(buf + n, s->bytes, (size_t)s->len); n += s->len; }
    onus_text *p = slot_ptr(xs->slots[i]);
    memcpy(buf + n, p->bytes, (size_t)p->len);
    n += p->len;
  }
  onus_text *out = onus_text_from(buf, n);
  free(buf);
  return ptr_slot(out);
}

onus_slot onus_text_repeat(onus_slot t, onus_slot n) {
  onus_text *a = slot_ptr(t);
  char *buf = malloc((size_t)(a->len * n) + 1);
  for (int64_t i = 0; i < n; i++) memcpy(buf + i * a->len, a->bytes, (size_t)a->len);
  onus_text *out = onus_text_from(buf, a->len * n);
  free(buf);
  return ptr_slot(out);
}

onus_slot onus_text_replace(onus_slot t, onus_slot from, onus_slot to) {
  if (((onus_text *)slot_ptr(from))->len == 0) return t;
  onus_slot parts = onus_text_split(t, from);
  return onus_text_join(parts, to);
}

onus_slot onus_text_compare(onus_slot a, onus_slot b) {
  onus_text *x = slot_ptr(a);
  onus_text *y = slot_ptr(b);
  int64_t n = x->len < y->len ? x->len : y->len;
  int c = memcmp(x->bytes, y->bytes, (size_t)n);
  if (c != 0) return c < 0 ? -1 : 1;
  return x->len == y->len ? 0 : (x->len < y->len ? -1 : 1);
}

onus_slot onus_int_parse(onus_slot t) {
  onus_text *a = slot_ptr(t);
  if (a->len == 0) return none();
  const char *s = a->bytes;
  int64_t i = 0;
  if (s[0] == '+' || s[0] == '-') i = 1;
  if (i >= a->len) return none();
  for (int64_t k = i; k < a->len; k++) if (s[k] < '0' || s[k] > '9') return none();
  errno = 0;
  char *end = NULL;
  long long v = strtoll(s, &end, 10);
  if (errno == ERANGE || end != s + a->len) return none();
  return some((onus_slot)v);
}

onus_slot onus_float_parse(onus_slot t) {
  onus_text *a = slot_ptr(t);
  if (a->len == 0) return none();
  const char *s = a->bytes;
  int64_t i = 0;
  if (s[0] == '+' || s[0] == '-') i = 1;
  int digits = 0;
  int64_t k = i;
  while (k < a->len && s[k] >= '0' && s[k] <= '9') { k++; digits++; }
  if (k < a->len && s[k] == '.') { k++; while (k < a->len && s[k] >= '0' && s[k] <= '9') { k++; digits++; } }
  if (digits == 0) return none();
  if (k < a->len && (s[k] == 'e' || s[k] == 'E')) {
    k++;
    if (k < a->len && (s[k] == '+' || s[k] == '-')) k++;
    int ed = 0;
    while (k < a->len && s[k] >= '0' && s[k] <= '9') { k++; ed++; }
    if (ed == 0) return none();
  }
  if (k != a->len) return none();
  char *end = NULL;
  double v = strtod(s, &end);
  if (end != s + a->len || isnan(v) || isinf(v)) return none();
  return some(double_slot(v));
}

typedef struct {
  int64_t len;
  int64_t cap;
  onus_slot *data;
} onus_builder;

onus_slot onus_list_builder(void) {
  onus_builder *b = onus_alloc((int64_t)sizeof(onus_builder));
  b->len = 0;
  b->cap = 0;
  b->data = NULL;
  return ptr_slot(b);
}

onus_slot onus_list_built(onus_slot b) { return ((onus_builder *)slot_ptr(b))->len; }

onus_slot onus_list_push(onus_slot *b, onus_slot x) {
  onus_builder *bb = slot_ptr(*b);
  if (bb->len == bb->cap) {
    bb->cap = bb->cap == 0 ? 16 : bb->cap * 2;
    bb->data = realloc(bb->data, sizeof(onus_slot) * (size_t)bb->cap);
  }
  bb->data[bb->len++] = x;
  return 0;
}

onus_slot onus_list_finish(onus_slot b) {
  onus_builder *bb = slot_ptr(b);
  onus_list *out = onus_rt_list_new(bb->len);
  if (bb->len > 0) memcpy(out->slots, bb->data, sizeof(onus_slot) * (size_t)bb->len);
  return ptr_slot(out);
}

onus_slot onus_io_read(onus_slot files, onus_slot path) {
  (void)files;
  onus_text *p = slot_ptr(path);
  FILE *fp = fopen(p->bytes, "rb");
  if (fp == NULL) return ptr_slot(err(ptr_slot(io_error(p))));
  size_t cap = 1 << 16;
  size_t n = 0;
  char *buf = malloc(cap);
  for (;;) {
    size_t got = fread(buf + n, 1, cap - n, fp);
    n += got;
    if (got == 0) break;
    if (n == cap) { cap *= 2; buf = realloc(buf, cap); }
  }
  fclose(fp);
  onus_text *out = onus_text_from(buf, (int64_t)n);
  free(buf);
  return ptr_slot(ok(ptr_slot(out)));
}

onus_slot onus_io_print(onus_slot console, onus_slot text) {
  (void)console;
  onus_text *t = slot_ptr(text);
  fwrite(t->bytes, 1, (size_t)t->len, stdout);
  return 0;
}

onus_slot onus_io_eprint(onus_slot console, onus_slot text) {
  (void)console;
  onus_text *t = slot_ptr(text);
  fwrite(t->bytes, 1, (size_t)t->len, stderr);
  return 0;
}

/* Structural equality of lists, element by element through the compiler-generated comparer (§19.1). */
bool onus_rt_list_eq(onus_list *a, onus_list *b, bool (*eq)(onus_slot, onus_slot)) {
  if (a->len != b->len) return false;
  for (int64_t i = 0; i < a->len; i++) if (!eq(a->slots[i], b->slots[i])) return false;
  return true;
}

onus_slot onus_list_at(onus_slot b, onus_slot i) {
  onus_builder *bb = slot_ptr(b);
  if (i < 0 || i >= bb->len) onus_panic("requires", "0 <= i and i < built(b: b)", "std.list", "at");
  return bb->data[i];
}

onus_slot onus_list_pop(onus_slot *b) {
  onus_builder *bb = slot_ptr(*b);
  if (bb->len == 0) return none();
  bb->len -= 1;
  return some(bb->data[bb->len]);
}
