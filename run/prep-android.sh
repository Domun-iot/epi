#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
flag="$root/tmp/prep/android-linux.ok"
rm -f -- "$flag"
sh "$root/scripts/prepare.sh" --android-only "$@"
mkdir -p "$root/tmp/prep"
: > "$flag"
