#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd) || exit 1
if [ ! -f "$root/tmp/prep/linux.ok" ]; then
    sh "$root/run/prep/linux.sh" || exit $?
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$root/tauri/src-tauri/target/desktop"
cd "$root/tauri" || exit 1
exec npm run tauri -- dev "$@"
