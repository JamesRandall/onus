#!/bin/sh
# `self/bundle.onus` is generated (docs/CHANGES.md item 180) from the
# standard library, the JavaScript runtime and the C runtime; it must be what
# `scripts/bundle.mjs` produces from the tree now, so that the compiler built
# from `self/` carries the current library and runtimes. Run from the
# repository root; the argument is a fresh working directory.
#   sh bundle.sh <work dir>
set -e
node scripts/bundle.mjs "$1/bundle.onus"
cmp "$1/bundle.onus" self/bundle.onus && echo "self/bundle.onus is current"
