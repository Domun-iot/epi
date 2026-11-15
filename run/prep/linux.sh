#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
flag="$root/tmp/prep/linux.ok"
rm -f -- "$flag"
sh "$root/scripts/prepare.sh" --desktop-only "$@"
mkdir -p "$root/tmp/prep"
: > "$flag"
