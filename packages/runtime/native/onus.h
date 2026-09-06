/*
 * The Onus native runtime (language spec §19.1; impl spec M11): the primitive
 * surface generated LLVM IR links against. Values cross this boundary as
 * 64-bit slots: an Int or Duration as itself, a Float as its IEEE bits, a
 * Bool as 0 or 1, everything else as a pointer. Aggregates are arrays of
 * slots: a record's fields; a variant's tag then its fields; a list's length
 * then its elements.
 *
 * v0 limits: allocation is never freed (the spec's free-at-scope-exit is a
 * later item); Text is UTF-8 bytes without grapheme tables, so the
 * grapheme-based operations are not provided and the compiler refuses
 * programs reaching them (E0800).
 */
#ifndef ONUS_H
#define ONUS_H

#include <stdbool.h>
#include <stdint.h>

typedef int64_t onus_slot;

typedef struct {
  int64_t len;
  char bytes[];
} onus_text;

typedef struct {
  int64_t len;
  onus_slot slots[];
} onus_list;

typedef struct {
  int64_t width;
  int64_t height;
  onus_slot cells[];
} onus_grid;

void *onus_alloc(int64_t bytes);
void onus_panic(const char *kind, const char *text, const char *at, const char *def) __attribute__((noreturn));
void onus_unreachable(void) __attribute__((noreturn));

onus_text *onus_text_from(const char *bytes, int64_t len);
/* Value construction shared with onus_lib.c: slots, unions, and the prelude's Option and Result. */
onus_slot onus_ptr_slot(const void *p);
void *onus_slot_ptr(onus_slot s);
void *onus_union_new(int64_t tag, int n, const onus_slot *fields);
onus_slot onus_some(onus_slot v);
onus_slot onus_none(void);
onus_slot onus_ok(onus_slot v);
onus_slot onus_err(onus_slot e);
onus_slot onus_io_error_for(const char *path);
onus_text *onus_rt_text_concat(onus_text *a, onus_text *b);
bool onus_rt_text_eq(onus_text *a, onus_text *b);

onus_list *onus_rt_list_new(int64_t len);
int64_t onus_rt_list_len(onus_list *xs);
onus_slot onus_rt_list_get(onus_list *xs, int64_t i);
void onus_rt_list_set(onus_list *xs, int64_t i, onus_slot v);
onus_list *onus_rt_list_concat(onus_list *a, onus_list *b);
bool onus_rt_list_eq(onus_list *a, onus_list *b, bool (*eq)(onus_slot, onus_slot));

onus_list *onus_args(int argc, char **argv);
int onus_start(int argc, char **argv);
int onus_finish(void *result);
void onus_report_example(const char *name, bool ok);
int onus_examples_done(void);
void *onus_root(const char *kind);

#endif
