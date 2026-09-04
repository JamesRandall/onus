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

void onus_panic(const char *kind, const char *text, const char *at, const char *def) {
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

int onus_finish(void *result) {
  onus_slot *r = result;
  close_all();
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
