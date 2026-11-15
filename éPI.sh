#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec sh "$root/run/tauri.sh" "$@"
