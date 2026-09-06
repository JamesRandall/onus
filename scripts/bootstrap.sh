#!/usr/bin/env bash
# The bootstrap chain (impl spec M15.4; .claude/skills/language-change/SKILL.md):
# stage0 builds the compiler (`self/cli.onus`, the `onus` command line in
# Onus) into stage1 with `onus build`, stage1 builds it into stage2, stage2
# into stage3, and stage2 must equal stage3 file for file. stage0 is
# bootstrap/ when it exists, otherwise the TypeScript compiler.
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
