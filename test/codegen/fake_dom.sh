#!/bin/sh
# Runs a JavaScript program against the fake document beside this script
# (docs/CHANGES.md item 208): `sh fake_dom.sh node <program.js> [args...]`.
here=$(cd "$(dirname "$0")" && pwd)
shift
exec node "$here/fake_dom.mjs" "$@"
