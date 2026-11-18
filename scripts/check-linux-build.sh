#!/bin/sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd "$root" || exit 1

case "$1" in
    desktop)
        exe=release/linux/epi
        set -- shared tauri/index.html tauri/package.json tauri/package-lock.json \
            tauri/vite.config.js tauri/desktop.mjs tauri/src tauri/domain tauri/public \
            tauri/src-tauri/Cargo.toml tauri/src-tauri/Cargo.lock tauri/src-tauri/build.rs \
            tauri/src-tauri/tauri.conf.json tauri/src-tauri/tauri.linux.conf.json \
            tauri/src-tauri/capabilities tauri/src-tauri/icons tauri/src-tauri/src \
            run/build/linux.sh
        ;;
    cli)
        exe=release/cli/linux/epi-cli
        set -- shared cli/*.cjs cli/package.json cli/package-lock.json run/build/cli.sh
        ;;
    web)
        exe=release/web/build.ok
        for file in build.ok package.json config.js server.js actions.js session-api.js public/index.html; do
            [ -f "release/web/$file" ] || exit 1
        done
        set -- shared tauri/index.html tauri/package.json tauri/package-lock.json \
            tauri/vite.config.js tauri/src tauri/domain tauri/public web run/build/web.sh
        ;;
    *) exit 1 ;;
esac

set -- "$@" LICENSE COPYING COPYING.LESSER THIRD_PARTY.md licenses scripts/build-notices.cjs
case "$exe" in *.ok) ;; *) [ -x "$exe" ] || exit 1 ;; esac
for input do
    case "$input" in cli/*.test.cjs) continue ;; esac
    [ -e "$input" ] || continue
    newer=$(find "$input" -newer "$exe" -print -quit) || exit 1
    [ -z "$newer" ] || exit 1
done
