#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
flag="$root/tmp/prep/cli-linux.ok"
rm -f -- "$flag"
sh "$root/run/prepare.sh" --node-only
mkdir -p -- "$(dirname -- "$flag")"
printf 'ok\n' > "$flag"
