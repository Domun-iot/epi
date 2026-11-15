#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd) || exit 1
if [ ! -f "$root/tmp/prep/cli-linux.ok" ]; then
    sh "$root/run/prep/cli.sh" || exit $?
fi
export PATH="$HOME/.local/bin:$PATH"
exec node "$root/cli/index.cjs" "$@"
