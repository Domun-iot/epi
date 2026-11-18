# Developing and building éPI

This repository contains the CLI, Tauri application, web client, synchronisation API and public website. Payments are handled by an external service. This documentation covers sources, tests and local artefacts.

## Prerequisites

Clone the repository and run commands from its root. Node.js 24 supports all JavaScript components; the server requires at least 22.13 (`node:sqlite`), web/Tauri at least 20.19. npm and Cargo lockfiles are versioned. Use `npm ci` to reproduce dependencies.

The `run/prep/` scripts prepare Node.js, Rust, system dependencies and Android tools as required by the target. Read scripts before running them: they may install tools and request sudo or UAC. Markers are stored in `tmp/prep/`.

| Target | Windows preparation | Linux preparation |
| --- | --- | --- |
| Desktop interface | `run\prep\windows.bat` | `sh run/prep/linux.sh` or `sh run/prep/ubuntu.sh` |
| Android | `run\prep\android.bat` | `sh run/prep/android.sh` |
| CLI | `run\prep\cli.bat` | `sh run/prep/cli.sh` |
| Web | `run\prep\web.bat` | `sh run/prep/web.sh` |
| API | `run\prep\server.bat` | `sh run/prep/server.sh` |

## Development and tests

The `run/dev/{cli,tauri,web,server}.sh` launchers and `.bat` equivalents start development versions. The CLI scans Bluetooth on Windows. The web client supports screen development without Bluetooth capture. `www/` runs independently with `npm --prefix www start`.

```sh
npm --prefix cli test
npm --prefix tauri test
npm --prefix tauri run test:ui
npm --prefix server test
npm --prefix www test
node --test shared/*.test.cjs shared/scales/*.test.cjs web/*.test.js
```

Interface tests use Playwright and Chromium. Install the test browser with `cd tauri && npx playwright install chromium` if necessary, then return to the root. Local tests replace account and catalogue services with test doubles. Application clients configure the account service in `tauri/src/service.js`; check this before manual testing. Use only fictional profiles and a temporary directory for tests.

## Local service configuration

Defaults are intended for development: API on 8787 (`server/config.js`), personal web on 3000 (`web/config.js`), hosted client files on 3001 (`EPI_WEB_PORT`) and public website on 3002 (`EPI_WWW_PORT`). For the hosted client, supply the same `EPI_WEB_PORT` to the API process and static file server. Installation-specific settings and operational tools are kept outside this public repository.

## Artefacts by target

CLI and web builds bundle a `legal/` directory with éPI licences, third-party notices and the relevant component inventory. The Tauri frontend also includes these files in its web resources. Keep this directory with the artefacts. npm notices are collected from installed versions matching the lockfile; run `npm ci` before building.

The CLI copies the full licence of the Node distribution used for the SEA binary, including embedded component notices. If that distribution places `LICENSE` somewhere other than alongside `node` or at its installation root, set `EPI_NODE_LICENSE` to that complete file before building.

| Target | Command | Output |
| --- | --- | --- |
| Windows desktop | `run\build\windows.bat` | `release/windows/`: EXE, MSI, standalone binary |
| Linux DEB | `sh run/build/ubuntu.sh` | `release/linux/`: binary and DEB |
| Linux AppImage | `sh run/build/linux.sh` | `release/linux/`: binary and AppImage |
| CLI | `sh run/build/cli.sh` or `run\build\cli.bat` | `release/cli/<platform>/epi-cli[.exe]` |
| Personal web | `sh run/build/web.sh` or `run\build\web.bat` | `release/web/` |
| Hosted web client | `node web/build.mjs --hosted` | `release/web/` with hosted adapter |
| API | `sh run/build/server.sh` or `run\build\server.bat` | `server/dist/` |
| Android debug | `sh run/build/android.sh` or `run\build\android.bat` | `release/android/epi-debug.apk` |
| Android release | Same scripts with `--release` | `release/android/epi-release-unsigned.apk` |
| Android AAB | Same scripts with `--play` | `release/android/epi-play.aab` |

Desktop scripts accept `--portable` to produce only the binary. The Linux launcher accepts `deb`, `rpm`, `appimage`; the Windows launcher accepts `nsis`, `msi`. Build on the target system with native tools. `sh run/build/all.sh` and `run\build\all.bat` run through their system's targets and display a report; a failed target does not validate its old artefacts.

Android builds use JDK 17, Android SDK, NDK and Rust. Release variants include ARM64 and x86-64. Debug builds use Gradle's development signature. Linux desktop builds require the WebKit/GTK and Bluetooth dependencies described in preparation scripts. The Linux CLI binary does not provide Windows scanning.

## Local Android signing

A release APK must be signed before installation. Keep the key and password outside the repository; back up both in an independent vault. Updates require the same signing key as the existing installation.

On Windows, `run\build\sign-android.ps1` uses a PKCS12 keystore in `%USERPROFILE%\epi-keys`, alias `epi-upload`, and a DPAPI-protected password file. `-KeyDirectory` selects another directory. To create your own key, adapt the script's public `-dname` identity, then use `-CreateKey` once. Reuse that key afterwards. The DPAPI XML is readable only by the same user on the same computer; it does not replace a portable backup. The script checks the APK signature, ZIP alignment and AAB signature.

On Linux, create your own key outside the repository and use JDK and Android SDK tools. Example with passwords prompted by the tools:

```sh
keytool -genkeypair -storetype PKCS12 -keystore /private/path/upload.p12 -alias epi-upload -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Example Developer'
zipalign -f -P 16 4 release/android/epi-release-unsigned.apk release/android/epi-release-aligned.apk
apksigner sign --ks /private/path/upload.p12 --ks-key-alias epi-upload --out release/android/epi-release.apk release/android/epi-release-aligned.apk
apksigner verify --verbose --print-certs release/android/epi-release.apk
zipalign -c -P 16 4 release/android/epi-release.apk
jarsigner -keystore /private/path/upload.p12 -signedjar release/android/epi-play-signed.aab release/android/epi-play.aab epi-upload
jarsigner -verify release/android/epi-play-signed.aab
```

Add the JDK and SDK `build-tools/<version>` directory to PATH. The certificate name above is fictional. Never put passwords in versioned commands or replace an existing key just to rebuild.

## macOS and iOS

The supplied desktop launchers target Windows and Linux. On macOS, use the Tauri CLI from `tauri/`, with Rust, Xcode and Apple tools:

```sh
cd tauri
npm ci
npm run tauri -- build
npm run tauri -- ios init
npm run tauri -- ios build
```

The iOS target requires developer-specific Apple signing configuration. These commands do not constitute hardware validation: check Bluetooth support and permissions on the target device. See also [startup checks](TEST-DEMARRAGE.md).

## Architecture and licence

See [README](../README.md), [CLI](../cli/README.md), [API](../server/README.md), [storage](ARCHITECTURE-STOCKAGE.md), [accounts](COMPTES-ET-DONNEES.md), [synchronisation](SYNCHRONISATION.md) and [BLE protocols](BALANCES-BLE.md). Original éPI code is distributed under LGPL-3.0-only; third-party assets retain their licences and attributions. See [LICENSE](../LICENSE).
