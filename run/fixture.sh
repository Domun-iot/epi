#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
export PATH="$HOME/.local/bin:$PATH"
exec node "$root/../scripts/fixture.cjs"
