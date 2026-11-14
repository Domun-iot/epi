#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tools="$HOME/.local/share/epi-dev"
sdk="$tools/android-sdk"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

android_only=false
desktop_only=false
node_only=false
accept_licenses=false
for option in "$@"; do
    case "$option" in
        --android-only) android_only=true ;;
        --desktop-only) desktop_only=true ;;
        --node-only) node_only=true ;;
        --accept-android-licenses) accept_licenses=true ;;
        *) printf 'Option inconnue : %s\n' "$option" >&2; exit 1 ;;
    esac
done
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    printf 'Ce script requiert Linux x86_64.\n' >&2
    exit 1
fi

set -- ca-certificates curl xz-utils
if ! "$node_only"; then
    set -- "$@" build-essential
    if ! "$desktop_only"; then
        set -- "$@" unzip openjdk-17-jdk-headless
    fi
    if ! "$android_only"; then
        set -- "$@" pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev \
            libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev bluez patchelf file
    fi
fi
missing=''
for package in "$@"; do
    if [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]; then
        missing="$missing $package"
    fi
done
if [ -n "$missing" ]; then
    # Les noms proviennent uniquement de la liste de paquets ci-dessus.
    set -- $missing
    if [ "$(id -u)" -ne 0 ]; then
        sudo apt-get update
        sudo apt-get install -y "$@"
    else
        apt-get update
        apt-get install -y "$@"
    fi
fi

mkdir -p "$tools" "$HOME/.local/bin"
stage=$(mktemp -d "$tools/download.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
if ! command -v node >/dev/null || ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"; then
    base=https://nodejs.org/dist/latest-v22.x
    curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
    archive=$(awk '$2 ~ /-linux-x64\.tar\.xz$/ { print $2; exit }' "$stage/SHASUMS256.txt")
    test -n "$archive"
    curl -fsSL --retry 3 "$base/$archive" -o "$stage/$archive"
    (cd "$stage" && awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$stage/$archive" -C "$stage"
    version_dir="$tools/${archive%.tar.xz}"
    if [ ! -x "$version_dir/bin/node" ]; then
        mv "$stage/${archive%.tar.xz}" "$version_dir"
    fi
    ln -sfn "$version_dir/bin/node" "$HOME/.local/bin/node"
    ln -sfn "$version_dir/bin/npm" "$HOME/.local/bin/npm"
    ln -sfn "$version_dir/bin/npx" "$HOME/.local/bin/npx"
fi

if "$node_only"; then exit 0; fi

if ! command -v rustup >/dev/null; then
    curl -fsSL --retry 3 https://sh.rustup.rs -o "$stage/rustup-init.sh"
    sh "$stage/rustup-init.sh" -y --default-toolchain stable
fi
if ! "$desktop_only"; then
    rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

    manager="$sdk/cmdline-tools/latest/bin/sdkmanager"
    if [ ! -x "$manager" ]; then
        curl -fsSL --retry 3 https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip -o "$stage/android.zip"
        unzip -q "$stage/android.zip" -d "$stage"
        mkdir -p "$sdk/cmdline-tools"
        mv "$stage/cmdline-tools" "$sdk/cmdline-tools/latest"
    fi
    export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
    export ANDROID_HOME="$sdk"
    set -- --install platform-tools 'platforms;android-34' 'platforms;android-37.0' 'build-tools;36.0.0' 'ndk;28.2.13676358'
    if "$accept_licenses"; then
        yes | "$manager" "$@"
    else
        "$manager" "$@"
    fi
    if [ ! -x "$sdk/platform-tools/adb" ] || [ ! -f "$sdk/platforms/android-34/android.jar" ] ||
        [ ! -f "$sdk/platforms/android-37.0/android.jar" ] ||
        [ ! -x "$sdk/build-tools/36.0.0/apksigner" ] || [ ! -f "$sdk/ndk/28.2.13676358/source.properties" ]; then
        printf 'Paquets Android manquants. Relance prepare et accepte les licences requises.\n' >&2
        exit 1
    fi

fi

cd "$root/tauri"
if ! node node_modules/@tauri-apps/cli/tauri.js --version >/dev/null 2>&1; then
    npm ci
fi
