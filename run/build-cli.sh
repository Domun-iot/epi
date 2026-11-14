#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$root/tmp/prep/cli-linux.ok" ]; then
    sh "$root/run/prep-cli.sh"
fi
export PATH="$HOME/.local/bin:$PATH"
npm --prefix "$root/cli" ci --include=dev --no-audit --no-fund
exec node "$root/cli/build.cjs"
