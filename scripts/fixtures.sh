#!/usr/bin/env bash
# The fixture suite (impl spec §10; docs/CHANGES.md items 198–200):
# `run_fixtures.js`, built from `self/fixtures.onus` by the bootstrap chain,
# over every fixture directory's `fixtures.json` under test/. The
# runner is bootstrap/run_fixtures.js (stage0) unless ONUS_FIXTURES names
# another, such as a chain's stage2 for the acceptance step of
# .claude/skills/language-change/SKILL.md; the compiler the command-line
# cases run is the run_cli.js beside the runner, and ONUS_NATIVE_CLI names
# the compiler built natively for the release case (a chain's
# native/native/cli), else that case is skipped. Extra arguments go to the
# runner (`--update` rewrites the expectation files). Runs from the
# repository root.
#   scripts/fixtures.sh [runner-args...]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
runner=${ONUS_FIXTURES:-bootstrap/run_fixtures.js}
cli=$(dirname "$runner")/run_cli.js
if [ -n "${ONUS_NATIVE_CLI:-}" ]; then set -- --native-cli "$ONUS_NATIVE_CLI" "$@"; fi
tests=test
exec node "$runner" \
  "$tests/syntax" "$tests/roundtrip" "$tests/checker" "$tests/paths" "$tests/verify" \
  "$tests/examples" "$tests/codegen" "$tests/stdlib" "$tests/native" "$tests/next" "$tests/sql" "$tests/cli" "$tests/zones" \
  --root "$root" --cli "$cli" --stdlib packages/stdlib --out .onus-tmp/fixtures "$@"
