#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cli="$root/release/cli/linux/epi-cli"
if ! sh "$root/scripts/check-linux-build.sh" cli; then
    sh "$root/run/build/cli.sh" || exit $?
fi
exec "$cli" "$@"
