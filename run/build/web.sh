#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [ ! -f "$root/tmp/prep/web-linux.ok" ]; then
    sh "$root/run/prep/web.sh"
fi
export PATH="$HOME/.local/bin:$PATH"
npm --prefix "$root/tauri" ci --include=dev --no-audit --no-fund
exec node "$root/web/build.mjs"
