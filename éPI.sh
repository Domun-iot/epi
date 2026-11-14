#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
epi="$root/release/linux/epi"
if ! sh "$root/run/check-linux-build.sh" desktop; then
    sh "$root/run/build-linux.sh" --portable || exit $?
fi
cd "$root" || exit 1
exec "$epi" "$@"
