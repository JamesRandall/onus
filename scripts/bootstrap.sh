#!/usr/bin/env bash
# The bootstrap chain (impl spec M15.4; .claude/skills/language-change/SKILL.md):
# stage0 builds the compiler (`self/cli.onus`, the `onus` command line in
# Onus) into stage1 with `onus build`, stage1 builds it into stage2, stage2
# into stage3, and stage2 must equal stage3 file for file. stage0 is
# bootstrap/ when it exists, otherwise the TypeScript compiler.
#
# The native stage (impl spec M15.5): stage2 builds the compiler for the
# native target, and that executable — with neither node nor TypeScript —
# must build the compiler for the JavaScript target to the same files as
# stage2, and for the native target to the same LLVM IR stage2 emitted for
# it. Skipped with a notice when `clang` is not on PATH.
#   scripts/bootstrap.sh [out-dir]      (default .onus-tmp/bootstrap)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/.onus-tmp/bootstrap}
stdlib=$root/packages/stdlib
runtime=$root/packages/runtime/dist/index.js
budget=${ONUS_BUDGET:-3000}
entry=$root/self/cli.onus
rm -rf "$out"
mkdir -p "$out"

# stage <n> <launcher of the previous stage, or "ts">
stage() {
  local n=$1 prev=$2
  echo "bootstrap: stage$n"
  if [ "$prev" = ts ]; then
    (cd "$root" && node packages/compiler/dist/cli/main.js build "$entry" --out "$out/stage$n" --root "$root/self" --stdlib "$stdlib" --budget "$budget")
  else
    if ! node "$prev" build "$entry" --out "$out/stage$n" --root "$root/self" --stdlib "$stdlib" --budget "$budget" --runtime "$runtime" > "$out/stage$n.diagnostics"; then
      echo "bootstrap: stage$n failed:"
      head -20 "$out/stage$n.diagnostics"
      exit 1
    fi
  fi
}

if [ -f "$root/bootstrap/run_cli.js" ]; then stage0=$root/bootstrap/run_cli.js; else stage0=ts; fi
stage 1 "$stage0"
stage 2 "$out/stage1/run_cli.js"
stage 3 "$out/stage2/run_cli.js"
if diff -r "$out/stage2" "$out/stage3" > "$out/diff.txt"; then
  echo "bootstrap: fixed point reached; stage2 is $out/stage2"
else
  echo "bootstrap: stage2 and stage3 differ:"
  head -40 "$out/diff.txt"
  exit 1
fi

if ! command -v clang > /dev/null 2>&1; then
  echo "bootstrap: clang is not on PATH; the native stage is skipped"
  exit 0
fi
echo "bootstrap: native"
if ! node "$out/stage2/run_cli.js" build "$entry" --out "$out/native" --root "$root/self" --stdlib "$stdlib" --budget "$budget" --runtime "$runtime" --target native > "$out/native.diagnostics"; then
  echo "bootstrap: the native build failed:"
  head -20 "$out/native.diagnostics"
  exit 1
fi
native=$out/native/native/cli
# The native compiler runs with node and clang's directory alone on PATH (z3 beside them when present): no node, no TypeScript.
z3dir=$(dirname "$(command -v z3 || echo /nonexistent/z3)")
bare_path=$(dirname "$(command -v clang)"):$z3dir:/usr/bin:/bin
if ! env PATH="$bare_path" "$native" build "$entry" --out "$out/stage4" --root "$root/self" --stdlib "$stdlib" --budget "$budget" --runtime "$runtime" > "$out/stage4.diagnostics"; then
  echo "bootstrap: the native compiler failed to build the compiler for JavaScript:"
  head -20 "$out/stage4.diagnostics"
  exit 1
fi
if ! diff -r "$out/stage2" "$out/stage4" > "$out/diff-native.txt"; then
  echo "bootstrap: the native compiler's JavaScript build differs from stage2's:"
  head -40 "$out/diff-native.txt"
  exit 1
fi
if ! env PATH="$bare_path" "$native" build "$entry" --out "$out/native2" --root "$root/self" --stdlib "$stdlib" --budget "$budget" --runtime "$runtime" --target native > "$out/native2.diagnostics"; then
  echo "bootstrap: the native compiler failed to build the compiler natively:"
  head -20 "$out/native2.diagnostics"
  exit 1
fi
if ! cmp -s "$out/native/native/program.ll" "$out/native2/native/program.ll"; then
  echo "bootstrap: the native compiler's LLVM IR for itself differs from stage2's"
  exit 1
fi
echo "bootstrap: native stage agrees; the native compiler is $native"

