#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/server"
if [ ! -f "node_modules/.bin/tsc" ]; then
    sh "$root/run/prep-server.sh"
fi
exec npm run build
