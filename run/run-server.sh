#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root/server"
if [ ! -f "dist/index.js" ]; then
    sh "$root/run/build-server.sh"
fi
exec npm start
