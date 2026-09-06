/*
 * The rest of the primitive surface for the native target (spec §19.1;
 * docs/CHANGES.md item 175): `Text` with the Unicode 16.0 tables of
 * unicode_tables.h (grapheme clusters per UAX #29, default case conversion
 * with SpecialCasing and Final_Sigma, JavaScript's `trim` set), `Bytes`,
 * `hash.blake3_hex` over the reference implementation in blake3/, the
 * `Process` capability's `run` over posix_spawn, `io.mkdir`, and `TypeInfo`.
 * Every function takes and returns 64-bit slots like the rest of onus.c.
 */
#include "onus.h"
#include "unicode_tables.h"
#include "blake3/blake3.h"

#include <errno.h>
#ifndef __wasi__
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#ifndef __wasi__
#include <sys/wait.h>
#endif
#include <time.h>
#include <unistd.h>

#ifndef __wasi__
extern char **environ;
#endif

/* ---------------------------------------------------------------------------
 * UTF-8
 * ------------------------------------------------------------------------- */

/* The code point at `*i`, advancing `*i`; malformed bytes read as U+FFFD one byte at a time. */
static uint32_t utf8_next(const unsigned char *s, int64_t len, int64_t *i) {
  unsigned char c = s[*i];
  if (c < 0x80) {
    *i += 1;
    return c;
  }
  int n = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
  if (n == 1 || *i + n > len) {
    *i += 1;
    return 0xFFFD;
  }
  uint32_t cp = c & (n == 2 ? 0x1F : n == 3 ? 0x0F : 0x07);
  for (int k = 1; k < n; k++) cp = (cp << 6) | (s[*i + k] & 0x3F);
  *i += n;
  return cp;
}

static int utf8_put(uint32_t cp, char *out) {
  if (cp < 0x80) {
    out[0] = (char)cp;
    return 1;
  }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6));
    out[1] = (char)(0x80 | (cp & 0x3F));
    return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12));
    out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F));
    return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18));
  out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
  out[3] = (char)(0x80 | (cp & 0x3F));
  return 4;
}

/* A growing byte buffer. */
typedef struct {
  char *data;
  int64_t len;
  int64_t cap;
} buf;

static void buf_push(buf *b, const char *bytes, int64_t n) {
  if (b->len + n > b->cap) {
    int64_t cap = b->cap == 0 ? 64 : b->cap;
    while (cap < b->len + n) cap *= 2;
    char *data = onus_alloc(cap);
    if (b->len > 0) memcpy(data, b->data, (size_t)b->len);
    b->data = data;
    b->cap = cap;
  }
  memcpy(b->data + b->len, bytes, (size_t)n);
  b->len += n;
}

static void buf_push_cp(buf *b, uint32_t cp) {
  char tmp[4];
  int n = utf8_put(cp, tmp);
  buf_push(b, tmp, n);
}

static onus_slot buf_text(buf *b) {
  return onus_ptr_slot(onus_text_from(b->data == NULL ? "" : b->data, b->len));
}

/* The code points of a text, as an array the caller owns. */
static uint32_t *decode_all(onus_text *t, int64_t *count) {
  uint32_t *cps = onus_alloc((int64_t)sizeof(uint32_t) * (t->len + 1));
  int64_t i = 0;
  int64_t n = 0;
  while (i < t->len) cps[n++] = utf8_next((const unsigned char *)t->bytes, t->len, &i);
  *count = n;
  return cps;
}

/* ---------------------------------------------------------------------------
 * Table lookups
 * ------------------------------------------------------------------------- */

static int urange_value(const onus_urange *t, int n, uint32_t cp) {
  int lo = 0;
  int hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (cp < t[mid].lo) hi = mid - 1;
    else if (cp > t[mid].hi) lo = mid + 1;
    else return t[mid].v;
  }
  return 0;
}

static int umap_find(const onus_umap *t, int n, uint32_t cp, uint32_t *to) {
  int lo = 0;
  int hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (cp < t[mid].cp) hi = mid - 1;
    else if (cp > t[mid].cp) lo = mid + 1;
    else {
      *to = t[mid].to;
      return 1;
    }
  }
  return 0;
}

static const onus_uspecial *uspecial_find(const onus_uspecial *t, int n, uint32_t cp) {
  int lo = 0;
  int hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (cp < t[mid].cp) hi = mid - 1;
    else if (cp > t[mid].cp) lo = mid + 1;
    else return &t[mid];
  }
  return NULL;
}

/* ---------------------------------------------------------------------------
 * Text
 * ------------------------------------------------------------------------- */




/* JavaScript's `trim`: WhiteSpace and LineTerminator code points at both ends. */
onus_slot onus_text_trim(onus_slot t) {
  onus_text *a = onus_slot_ptr(t);
  int64_t n = 0;
  uint32_t *cps = decode_all(a, &n);
  int64_t start = 0;
  while (start < n && urange_value(onus_space, onus_space_n, cps[start]) != 0) start++;
  int64_t end = n;
  while (end > start && urange_value(onus_space, onus_space_n, cps[end - 1]) != 0) end--;
  buf b = {NULL, 0, 0};
  for (int64_t i = start; i < end; i++) buf_push_cp(&b, cps[i]);
  return buf_text(&b);
}

static int is_cased(uint32_t cp) { return urange_value(onus_cased, onus_cased_n, cp) != 0; }
static int is_case_ignorable(uint32_t cp) { return urange_value(onus_caseign, onus_caseign_n, cp) != 0; }

/* Final_Sigma (SpecialCasing): a cased letter precedes, skipping case-ignorables, and none follows. */
static int final_sigma(const uint32_t *cps, int64_t n, int64_t i) {
  int64_t j = i - 1;
  while (j >= 0 && is_case_ignorable(cps[j])) j--;
  if (j < 0 || !is_cased(cps[j])) return 0;
  int64_t k = i + 1;
  while (k < n && is_case_ignorable(cps[k])) k++;
  return !(k < n && is_cased(cps[k]));
}

static onus_slot convert_case(onus_slot t, int to_lower) {
  int64_t n = 0;
  uint32_t *cps = decode_all(onus_slot_ptr(t), &n);
  buf b = {NULL, 0, 0};
  for (int64_t i = 0; i < n; i++) {
    uint32_t cp = cps[i];
    if (to_lower && cp == 0x03A3) {
      buf_push_cp(&b, final_sigma(cps, n, i) ? 0x03C2 : 0x03C3);
      continue;
    }
    const onus_uspecial *sp = to_lower ? uspecial_find(onus_lower_special, onus_lower_special_n, cp) : uspecial_find(onus_upper_special, onus_upper_special_n, cp);
    if (sp != NULL) {
      for (int k = 0; k < sp->n; k++) buf_push_cp(&b, sp->to[k]);
      continue;
    }
    uint32_t to = cp;
    if (to_lower) umap_find(onus_lower, onus_lower_n, cp, &to);
    else umap_find(onus_upper, onus_upper_n, cp, &to);
    buf_push_cp(&b, to);
  }
  return buf_text(&b);
}

onus_slot onus_text_lower(onus_slot t) { return convert_case(t, 1); }
onus_slot onus_text_upper(onus_slot t) { return convert_case(t, 0); }

/* Grapheme cluster boundaries (UAX #29, Unicode 16.0): `breaks[i]` is set when a cluster starts at code point `i`. */
enum { GCB_OTHER = 0, GCB_CR, GCB_LF, GCB_CONTROL, GCB_EXTEND, GCB_ZWJ, GCB_RI, GCB_PREPEND, GCB_SPACINGMARK, GCB_L, GCB_V, GCB_T, GCB_LV, GCB_LVT };

static void grapheme_breaks(const uint32_t *cps, int64_t n, unsigned char *breaks) {
  int prev = GCB_OTHER;
  int ri_run = 0;      /* regional indicators in the current run */
  int pict_state = 0;  /* 1 after Extended_Pictographic (Extend*), 2 after its ZWJ */
  int incb_state = 0;  /* 1 after an InCB Consonant, 2 once a Linker followed it */
  for (int64_t i = 0; i < n; i++) {
    uint32_t cp = cps[i];
    int cur = urange_value(onus_gcb, onus_gcb_n, cp);
    int pict = urange_value(onus_extpict, onus_extpict_n, cp) != 0;
    int incb = urange_value(onus_incb, onus_incb_n, cp);
    int brk;
    if (i == 0) brk = 1; /* GB1 */
    else if (prev == GCB_CR && cur == GCB_LF) brk = 0; /* GB3 */
    else if (prev == GCB_CONTROL || prev == GCB_CR || prev == GCB_LF) brk = 1; /* GB4 */
    else if (cur == GCB_CONTROL || cur == GCB_CR || cur == GCB_LF) brk = 1; /* GB5 */
    else if (prev == GCB_L && (cur == GCB_L || cur == GCB_V || cur == GCB_LV || cur == GCB_LVT)) brk = 0; /* GB6 */
    else if ((prev == GCB_LV || prev == GCB_V) && (cur == GCB_V || cur == GCB_T)) brk = 0; /* GB7 */
    else if ((prev == GCB_LVT || prev == GCB_T) && cur == GCB_T) brk = 0; /* GB8 */
    else if (cur == GCB_EXTEND || cur == GCB_ZWJ) brk = 0; /* GB9 */
    else if (cur == GCB_SPACINGMARK) brk = 0; /* GB9a */
    else if (prev == GCB_PREPEND) brk = 0; /* GB9b */
    else if (incb == 1 && incb_state == 2) brk = 0; /* GB9c */
    else if (pict && prev == GCB_ZWJ && pict_state == 2) brk = 0; /* GB11 */
    else if (prev == GCB_RI && cur == GCB_RI && (ri_run % 2) == 1) brk = 0; /* GB12, GB13 */
    else brk = 1; /* GB999 */
    breaks[i] = (unsigned char)brk;
    /* State for the rules that look further back. */
    if (cur == GCB_RI) ri_run += 1;
    else ri_run = 0;
    if (pict) pict_state = 1;
    else if (pict_state == 1 && cur == GCB_EXTEND) pict_state = 1;
    else if (pict_state == 1 && cur == GCB_ZWJ) pict_state = 2;
    else pict_state = 0;
    if (incb == 1) incb_state = 1;
    else if (incb_state >= 1 && incb == 3) incb_state = 2;
    else if (incb_state >= 1 && incb == 2) { /* InCB Extend keeps the state */ }
    else incb_state = 0;
    prev = cur;
  }
}

onus_slot onus_text_graphemes(onus_slot t) {
  int64_t n = 0;
  uint32_t *cps = decode_all(onus_slot_ptr(t), &n);
  unsigned char *breaks = onus_alloc(n + 1);
  grapheme_breaks(cps, n, breaks);
  int64_t count = 0;
  for (int64_t i = 0; i < n; i++) count += breaks[i];
  onus_list *out = onus_rt_list_new(count);
  int64_t w = 0;
  int64_t i = 0;
  while (i < n) {
    int64_t j = i + 1;
    while (j < n && !breaks[j]) j++;
    buf b = {NULL, 0, 0};
    for (int64_t k = i; k < j; k++) buf_push_cp(&b, cps[k]);
    out->slots[w++] = buf_text(&b);
    i = j;
  }
  return onus_ptr_slot(out);
}

onus_slot onus_text_len(onus_slot t) {
  int64_t n = 0;
  uint32_t *cps = decode_all(onus_slot_ptr(t), &n);
  unsigned char *breaks = onus_alloc(n + 1);
  grapheme_breaks(cps, n, breaks);
  int64_t count = 0;
  for (int64_t i = 0; i < n; i++) count += breaks[i];
  return count;
}

/* ---------------------------------------------------------------------------
 * Bytes: the same layout as a text, a length and the bytes.
 * ------------------------------------------------------------------------- */

onus_slot onus_text_bytes(onus_slot t) { return t; }
onus_slot onus_bytes_len(onus_slot b) { return ((onus_text *)onus_slot_ptr(b))->len; }
onus_slot onus_bytes_get(onus_slot b, onus_slot i) { return (unsigned char)((onus_text *)onus_slot_ptr(b))->bytes[i]; }

/* ---------------------------------------------------------------------------
 * Hashing
 * ------------------------------------------------------------------------- */

onus_slot onus_hash_blake3_hex(onus_slot t) {
  onus_text *a = onus_slot_ptr(t);
  blake3_hasher h;
  blake3_hasher_init(&h);
  blake3_hasher_update(&h, a->bytes, (size_t)a->len);
  uint8_t out[BLAKE3_OUT_LEN];
  blake3_hasher_finalize(&h, out, BLAKE3_OUT_LEN);
  char hex[BLAKE3_OUT_LEN * 2];
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < BLAKE3_OUT_LEN; i++) {
    hex[2 * i] = digits[out[i] >> 4];
    hex[2 * i + 1] = digits[out[i] & 15];
  }
  return onus_ptr_slot(onus_text_from(hex, BLAKE3_OUT_LEN * 2));
}

/* ---------------------------------------------------------------------------
 * Processes and directories
 * ------------------------------------------------------------------------- */

static onus_slot other_error(const char *detail) {
  onus_slot d = onus_ptr_slot(onus_text_from(detail, (int64_t)strlen(detail)));
  return onus_ptr_slot(onus_union_new(2, 1, &d));
}

#ifndef __wasi__
static int64_t now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
#endif

#ifdef __wasi__
/* `io.run` under WASI: there are no processes; every call is Err(Other). */
onus_slot onus_io_run(onus_slot process, onus_slot program, onus_slot args, onus_slot stdin_text, onus_slot timeout_ms) {
  (void)process; (void)program; (void)args; (void)stdin_text; (void)timeout_ms;
  return onus_err(other_error("processes are not available on this target"));
}
#else
/* `io.run`: the program with its arguments, fed `stdin`, both streams captured; Err when it cannot start or overruns `timeout_ms` (0: no limit). */
onus_slot onus_io_run(onus_slot process, onus_slot program, onus_slot args, onus_slot stdin_text, onus_slot timeout_ms) {
  (void)process;
  onus_text *prog = onus_slot_ptr(program);
  onus_list *xs = onus_slot_ptr(args);
  onus_text *input = onus_slot_ptr(stdin_text);
  char **argv = onus_alloc((int64_t)sizeof(char *) * (xs->len + 2));
  argv[0] = prog->bytes;
  for (int64_t i = 0; i < xs->len; i++) argv[i + 1] = ((onus_text *)onus_slot_ptr(xs->slots[i]))->bytes;
  argv[xs->len + 1] = NULL;
  int in[2], out[2], errp[2];
  if (pipe(in) != 0 || pipe(out) != 0 || pipe(errp) != 0) return onus_err(other_error(strerror(errno)));
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, in[0], 0);
  posix_spawn_file_actions_adddup2(&fa, out[1], 1);
  posix_spawn_file_actions_adddup2(&fa, errp[1], 2);
  posix_spawn_file_actions_addclose(&fa, in[1]);
  posix_spawn_file_actions_addclose(&fa, out[0]);
  posix_spawn_file_actions_addclose(&fa, errp[0]);
  pid_t pid;
  int rc = posix_spawnp(&pid, prog->bytes, &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  close(in[0]);
  close(out[1]);
  close(errp[1]);
  if (rc != 0) {
    close(in[1]);
    close(out[0]);
    close(errp[0]);
    errno = rc;
    if (rc == ENOENT) return onus_err(onus_io_error_for(prog->bytes));
    return onus_err(other_error(strerror(rc)));
  }
  buf so = {NULL, 0, 0};
  buf se = {NULL, 0, 0};
  int64_t written = 0;
  int64_t deadline = timeout_ms > 0 ? now_ms() + timeout_ms : 0;
  int open_out = 1, open_err = 1;
  int open_in = input->len > 0;
  if (!open_in) close(in[1]);
  int timed_out = 0;
  char chunk[65536];
  while (open_out || open_err || open_in) {
    struct pollfd fds[3];
    int nfds = 0;
    int io = -1, ie = -1, ii = -1;
    if (open_out) { fds[nfds].fd = out[0]; fds[nfds].events = POLLIN; io = nfds++; }
    if (open_err) { fds[nfds].fd = errp[0]; fds[nfds].events = POLLIN; ie = nfds++; }
    if (open_in) { fds[nfds].fd = in[1]; fds[nfds].events = POLLOUT; ii = nfds++; }
    int wait = -1;
    if (deadline > 0) {
      int64_t left = deadline - now_ms();
      if (left <= 0) { timed_out = 1; break; }
      wait = (int)left;
    }
    int ready = poll(fds, (nfds_t)nfds, wait);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ready == 0) { timed_out = 1; break; }
    if (io >= 0 && (fds[io].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t got = read(out[0], chunk, sizeof chunk);
      if (got <= 0) { open_out = 0; close(out[0]); } else buf_push(&so, chunk, got);
    }
    if (ie >= 0 && (fds[ie].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t got = read(errp[0], chunk, sizeof chunk);
      if (got <= 0) { open_err = 0; close(errp[0]); } else buf_push(&se, chunk, got);
    }
    if (ii >= 0 && (fds[ii].revents & (POLLOUT | POLLERR | POLLHUP))) {
      if (fds[ii].revents & (POLLERR | POLLHUP)) { open_in = 0; close(in[1]); }
      else {
        ssize_t put = write(in[1], input->bytes + written, (size_t)(input->len - written));
        if (put < 0) { open_in = 0; close(in[1]); }
        else {
          written += put;
          if (written >= input->len) { open_in = 0; close(in[1]); }
        }
      }
    }
  }
  if (timed_out) {
    kill(pid, SIGKILL);
    if (open_in) close(in[1]);
    if (open_out) close(out[0]);
    if (open_err) close(errp[0]);
    int st;
    waitpid(pid, &st, 0);
    buf msg = {NULL, 0, 0};
    char num[32];
    snprintf(num, sizeof num, "%lld", (long long)timeout_ms);
    buf_push(&msg, "`", 1);
    buf_push(&msg, prog->bytes, prog->len);
    buf_push(&msg, "` did not finish within ", 24);
    buf_push(&msg, num, (int64_t)strlen(num));
    buf_push(&msg, " ms", 3);
    buf_push(&msg, "", 0);
    onus_slot d = buf_text(&msg);
    return onus_err(onus_ptr_slot(onus_union_new(2, 1, &d)));
  }
  int st = 0;
  waitpid(pid, &st, 0);
  int64_t status = WIFEXITED(st) ? WEXITSTATUS(st) : -1;
  onus_slot *rec = onus_alloc(3 * (int64_t)sizeof(onus_slot));
  rec[0] = status;
  rec[1] = buf_text(&so);
  rec[2] = buf_text(&se);
  return onus_ok(onus_ptr_slot(rec));
}

#endif

/* `io.mkdir`: creates the directory and any missing parents; Ok when it already exists. */
onus_slot onus_io_mkdir(onus_slot files, onus_slot path) {
  (void)files;
  onus_text *p = onus_slot_ptr(path);
  char *copy = onus_alloc(p->len + 1);
  memcpy(copy, p->bytes, (size_t)p->len);
  copy[p->len] = '\0';
  for (int64_t i = 1; i <= p->len; i++) {
    if (copy[i] == '/' || copy[i] == '\0') {
      char saved = copy[i];
      copy[i] = '\0';
      if (mkdir(copy, 0777) != 0 && errno != EEXIST) return onus_err(other_error(strerror(errno)));
      copy[i] = saved;
    }
  }
  return onus_ok(0);
}

/* ---------------------------------------------------------------------------
 * TypeInfo: a record of the type's name and its fields, as the emitter lays it out.
 * ------------------------------------------------------------------------- */

onus_slot onus_typeinfo_name(onus_slot t) { return ((onus_slot *)onus_slot_ptr(t))[0]; }
onus_slot onus_typeinfo_fields(onus_slot t) { return ((onus_slot *)onus_slot_ptr(t))[1]; }
