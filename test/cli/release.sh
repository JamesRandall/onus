#!/bin/sh
# The released compiler needs no repository (docs/CHANGES.md item 180): the
# native `onus` given as the first argument runs with clang (and z3 when
# present) alone on the path — no node, no ONUS_STDLIB, no ONUS_RUNTIME —
# checks and builds Mandelbrot for both targets, and the two builds write
# the same image. Run from the repository root; the second argument is a
# fresh working directory.
#   sh release.sh <native onus> <work dir>
set -e
onus=$1
work=$2
node_bin=$(command -v node)
bin="$work/bin"
mkdir -p "$bin" "$work/home" "$work/js-run" "$work/native-run"
ln -s "$(command -v clang)" "$bin/clang"
if command -v z3 > /dev/null 2>&1; then ln -s "$(command -v z3)" "$bin/z3"; fi
cp examples/mandelbrot/mandelbrot.onus "$work/home/"
export PATH="$bin:/usr/bin:/bin"
unset ONUS_STDLIB ONUS_RUNTIME
if command -v node > /dev/null 2>&1; then echo "node is on the path"; exit 1; fi
cd "$work/home"
"$onus" --version | sed 's/[0-9][0-9.]*$/<version>/'
"$onus" check mandelbrot.onus && echo "checked"
"$onus" build mandelbrot.onus --out out
test -f out/onus-runtime/index.js && echo "js runtime written"
grep -c 'from "./onus-runtime/index.js"' out/mandelbrot.js
grep -c 'from "../onus-runtime/index.js"' out/std/int.js
"$onus" build mandelbrot.onus --out out --target native 2> /dev/null
test -f out/native/runtime/onus.c && echo "c runtime written"
test -f out/native/runtime/blake3/blake3.c && echo "blake3 written"
cd "$work/js-run" && "$node_bin" ../home/out/run_mandelbrot.js && echo "js ran"
cd "$work/native-run" && ../home/out/native/mandelbrot && echo "native ran"
cmp "$work/js-run/mandelbrot.pgm" "$work/native-run/mandelbrot.pgm" && echo "same image"
