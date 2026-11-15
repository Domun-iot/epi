#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
flag="$root/tmp/prep/web-linux.ok"
rm -f -- "$flag"
sh "$root/scripts/prepare.sh" --node-only
mkdir -p -- "$(dirname -- "$flag")"
printf 'ok\n' > "$flag"
