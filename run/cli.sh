#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cli="$root/release/cli/linux/epi-cli"
if [ ! -x "$cli" ]; then sh "$root/run/build-cli.sh" || exit $?; fi
exec "$cli" "$@"
