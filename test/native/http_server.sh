#!/bin/sh
# Runs a program against a local HTTP server (the `std.http` fixture,
# docs/CHANGES.md item 196): starts the server beside this script, hands the
# program its URL as the last argument, and stops it afterwards.
#   sh http_server.sh <program> [args...]
here=$(cd "$(dirname "$0")" && pwd)
node "$here/http_server.mjs" > "$PWD/server.url" 2> "$PWD/server.err" < /dev/null &
pid=$!
i=0
while [ ! -s "$PWD/server.url" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
url=$(cat "$PWD/server.url")
"$@" "$url"
status=$?
kill $pid
exit $status
