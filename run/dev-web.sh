#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$root/tmp/prep/web-linux.ok" ]; then
    sh "$root/run/prep-web.sh"
fi
export PATH="$HOME/.local/bin:$PATH"
cd "$root/tauri"
if [ ! -f node_modules/vite/bin/vite.js ]; then
    npm ci --include=dev --no-audit --no-fund
fi
exec npm run dev -- --mode web "$@"
