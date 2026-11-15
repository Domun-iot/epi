#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
if ! sh "$root/run/check-linux-build.sh" web; then
    sh "$root/run/build-web.sh"
fi
export PATH="$HOME/.local/bin:$PATH"
cd "$root/release/web"
exec npm start -- "$@"
