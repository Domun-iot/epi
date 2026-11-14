#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
if [ ! -f "$root/tmp/prep/android-linux.ok" ]; then
    sh "$root/run/prep-android.sh" || exit "$?"
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
exec node "$root/tauri/desktop.mjs" android "$@"
