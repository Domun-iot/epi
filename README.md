# éPI

éPI receives Bluetooth weigh-ins from Xiaomi scales, Weight Scale-compatible scales and several families that broadcast measurements over BLE. See the [BLE scales and protocols catalogue](docs/BALANCES-BLE.md).

| Version | Start command |
| --- | --- |
| Tauri release | `run\tauri.bat` on Windows or `sh run/tauri.sh` on Linux. `éPI.bat` and `sh éPI.sh` remain available at the root. |
| Tauri development | `run\dev\tauri.bat` on Windows or `sh run/dev/tauri.sh` on Linux |
| CLI release | `run\cli.bat` on Windows or `sh run/cli.sh` on Linux. The launcher rebuilds the release if missing or if its sources or build configuration are newer. |
| CLI development | `run\dev\cli.bat` on Windows or `sh run/dev/cli.sh` on Linux |
| Web release | `run\web.bat` on Windows or `sh run/web.sh` on Linux. Runs `npm start` from the release. |
| Web development | `run\dev\web.bat` on Windows or `sh run/dev/web.sh` on Linux. Vite opens the local address in the default browser (default port 1421). |
| CLI tests | `npm --prefix cli test` |
| Tauri domain tests | `npm --prefix tauri test` |
| Interactive tests | `npm --prefix tauri run test:ui` |

[Startup tests](docs/TEST-DEMARRAGE.md) cover launchers and describe checks on installed packages.

## Web version

Run `run\web.bat` or `sh run/web.sh` from the repository. The launcher builds the web version if missing or if its sources are newer. To prepare or build manually, use `run\prep\web.bat` and `run\build\web.bat` on Windows, or `sh run/prep/web.sh` and `sh run/build/web.sh` on Linux. The build runs preparation if its marker is missing.

On Windows, the web build stops processes running this repository's `tauri/node_modules/@esbuild/win32-x64/esbuild.exe` before `npm ci`, then waits for them to exit and release the file.

Copy `release/web/` to a Linux or Windows server, then run `npm start` there. The server needs Node.js 20.19 or later and npm. The release includes the server and static files; no npm installation is needed.

To install éPI from a browser, open the web version over HTTPS or locally on `localhost`, then use the browser menu.

- In desktop Chrome or Edge and Chrome on Android, choose **Install** or **Add to Home Screen**, depending on the version.
- In Safari on iPhone or iPad, use **Share → Add to Home Screen**, then enable **Open as Web App** if offered.
- In Safari on Mac (macOS Sonoma or later), use **File → Add to Dock**.

The installed web application opens in its own window and still uses the éPI server to access data.

Edit `config.js` at the release root and restart the server after changes.

```js
export default {
  host: '127.0.0.1',
  port: 3000,
};
```

Rebuilding preserves configuration and data. To reuse a custom directory previously set through `dataDir`, provide its absolute path in `EPI_DATA_DIR` at startup.

The personal web release and `dev-web` select the same dataset as other desktop versions. Bluetooth capture remains available in installed applications. On a personal web installation, browsers use that installation's active dataset. Public web remote storage uses an authenticated PRO session and a separate directory per account. **Reload** rereads files, including changes made in Tauri or the CLI. To allow network access, select the required listening interface. The personal release must not be exposed directly to the Internet. Build the public multi-account application with `node web/build.mjs --hosted`. The hosted version also supports anonymous browser use. FREE requires this local storage and shares no data between browsers. A confirmed PRO account uses the API directly if the browser has no recorded local usage; otherwise, it retains browser storage with PRO synchronisation. [Storage ports and adapters](docs/ARCHITECTURE-STOCKAGE.md) explain selection and limitations.

## Manual entry

In Tauri (desktop and Android) and web applications, **Enter** at the top right of measurements saves a weight in kg or lb, with an editable date/time and optional body fat percentage. The weigh-in belongs to the active profile. Without a profile, weight alone is accepted; entering body fat opens profile creation for the required calculations. The entry is preserved during creation.

These records use the same storage, exports and synchronisation as Bluetooth weigh-ins. Their device section shows **Manual entry**: JSON retains `device.source: "manual"` without creating a scale in the device list. The original percentage is retained in `measures.fatPercent`. If impedance is missing, calculations seek an equivalent impedance that reproduces this percentage using the usual average of formulae, rounded to one decimal place. The search is bounded to 1–3000 Ω and 48 iterations per monotonic interval. A solution is saved only in `calculations.impedanceOhms`; received impedance always takes priority. If no solution exists within these limits, the percentage is retained and calculated impedance remains absent. Other methods and their averages are not replaced by the entered value.

## Data

On desktop, the CLI, Tauri and web server use `EPI_DATA_DIR` when set to an absolute path. Relative paths are rejected to prevent different datasets depending on the working directory. Otherwise, they look for a `data/` root recognised by the old `devices/`, `measures/`, `profiles/` dataset, the new `local/` subdirectory, account directories or installation configuration. The search proceeds upwards to the filesystem root from the executable, AppImage or web server directory.

If no shared directory is found, they use or create the common user data directory: `%APPDATA%\eu.domun.epi\data` on Windows, or `${XDG_DATA_HOME:-$HOME/.local/share}/eu.domun.epi/data` on Linux.

The root contains `local/` for anonymous data, `accounts/<UUID>/` per account, and `installation.json` for the active account and installation preferences. Old root-level data migrates once to `local/`, with a recovery backup. On mobile, Tauri uses its private directory. Within each dataset, the three subdirectories and JSON are identical across platforms. A first installation without an account uses anonymous data. After linking, the application remembers the last active account and retains offline local access even when the token expires. Explicit logout deselects that dataset and requires a new login to reopen the application; account data remains separate. Anonymous data can be linked to an account, with merge/replacement choices when PRO remote data exists. On FREE, it remains local: no synchronisation transfer occurs. The last loaded profile, BLE filter and pending weigh-ins are saved in `data/prefs/global.json`. Visible columns and grouped or expanded display are saved in `data/prefs/profil-<name>.json` for each custom profile.

In Tauri and on the web server, the ZIP contains data files under `data/`, including global and profile preferences, view configurations, notifications, the journal, outgoing queue, incoming transactions, archived transactions and their index where present. Import merges files and UUIDs with local data, preserving existing files. Older ZIPs with profiles, devices and weigh-ins directly at the root remain readable. Profiles and scales are stored under their UUIDs. New weigh-ins are filed in the profile UUID directory and named after their UTC timestamp, for example `2026-11-15T06-47-43.567Z.json`. Each weigh-in retains its own UUID and associated UUIDs in `profile.uuid` and `device.uuid`, with information available at measurement time. If the profile directory and timestamp match an existing weigh-in, import keeps the existing file. Older filenames remain readable. On desktop, if the CLI writes while the interface is open, reload or restart the interface to read the changes.

### Transaction journal

The CLI, Tauri and web server add a JSON file to `data/transactions/` for each journalled write. The name combines a UTC timestamp and UUID. The envelope contains `uuid`, `type` and `data`. A `create` or `update` operation contains the relative path and JSON document. A `delete` operation contains the path. A `batch` operation groups several operations. `data/transactions.index` contains UUIDs, one per line.

The Node.js `replayTransactions(dataDir)` function in `shared/transactions.cjs` processes `data/transactions.incoming/` in filename order. It archives unseen transactions under their original names and removes duplicates from the queue. This function handles the manual replay queue. At startup, Tauri and web versions logged into an éPI account retrieve server transactions in creation order, archive integrated transactions in `data/transactions.sent/` and acknowledge integrated or already present UUIDs. If a forced shutdown leaves `data/transactions.replay.lock`, delete it after checking that replay has stopped.

[Synchronisation behaviour and edge cases](docs/SYNCHRONISATION.md) describes transaction flows between installations, acknowledgement scope and unresolved issues.

To try the history, run `run\fixture.bat` on Windows or `sh run/fixture.sh` on Linux (Node.js required). The fixture adds 48 fictional weigh-ins over 24 months for profile `test`, with 1–8 weigh-ins per month. Over the final six months, weight gradually falls by about 10%, with occasional increases. The fixture preserves the profile and history if already present, and creates a `test` device only if none is registered. It uses the usual data directory. Set `EPI_DATA_DIR` to generate the dataset separately.

## Building

On an x64 PC, choose the preparation script for the build.

| Target | Preparation |
| --- | --- |
| Windows 10/11 | `run\prep\windows.bat` |
| Ubuntu and AppImage on Ubuntu/Debian | `sh run/prep/linux.sh` or `sh run/prep/ubuntu.sh` |
| Android from Windows | `run\prep\android.bat` |
| Android from Ubuntu/Debian | `sh run/prep/android.sh` |
| CLI | `run\prep\cli.bat` on Windows or `sh run/prep/cli.sh` on Linux |

Interface preparation installs Node.js, Rust and required npm dependencies. CLI preparation installs Node.js and checks for the C# compiler and WinRT references on Windows. Android preparation adds the JDK and SDK/NDK and asks you to accept required licences. On Windows, it also checks Developer Mode and offers to open settings. System components may require UAC elevation on Windows or `sudo` on Linux. No Git installer is launched.

You can run a build script or development launcher directly. If its target marker is missing from `tmp/prep/`, it runs the corresponding preparation. Each preparation checks prerequisites and reuses installed tools. Success is recorded in `tmp/prep/`, a local Git-ignored directory. To recheck prerequisites, rerun preparation or delete the target marker before the next build.

`run\tauri.bat` and `sh run/tauri.sh` open the standalone binary in `release/windows/` or `release/linux/`. If missing, they run the desktop build with `--portable`. Both rebuild when sources or build configuration are newer. `run\dev\tauri.bat` and `sh run/dev/tauri.sh` start development through `tauri dev`.

| Platform | Build | Output |
| --- | --- | --- |
| Windows | `run\build\windows.bat` | `release/windows/` contains `epi.exe` and NSIS (EXE) and MSI installers. |
| Ubuntu | `sh run/build/ubuntu.sh` | `release/linux/` contains the `epi` binary and `.deb` package. |
| Linux, AppImage | `sh run/build/linux.sh` | `release/linux/` contains the `epi` binary and AppImage. |
| Android | `run\build\android.bat` or `sh run/build/android.sh` | `release/android/epi-debug.apk` |
| CLI | `run\build\cli.bat` or `sh run/build/cli.sh` | `release/cli/windows/` or `release/cli/linux/`. One file per platform, `epi-cli.exe` on Windows and `epi-cli` on Linux, with embedded Node.js. CLI Bluetooth scanning is available on Windows. |

The CLI development launcher uses Node.js to execute sources.

On Windows, enable [Developer Mode](https://learn.microsoft.com/windows/advanced-settings/developer-mode) so Tauri can create symbolic links for its Android libraries.

The Windows Android build places the Rust cache in `%LOCALAPPDATA%\epi-dev\cargo-target\android\<repository-id>` to avoid NDK linker errors when the repository path contains an accent, such as `éPI`. Each repository location has its own cache. The launcher also permits this path in Gradle with `android.overridePathCheck=true`. Set `CARGO_TARGET_DIR` to choose another directory; its absolute path must contain ASCII characters only.

Without options, the APK uses the Gradle debug signing key. For a production APK, use `run\build\android.bat --release` (or `sh run/build/android.sh --release`), then `run\build\sign-android.ps1` on Windows: the installable file is `release/android/epi-release.apk`. Artefact creation and local signing are described in the [build guide](docs/BUILD.md). Bluetooth requires Android 8.0 or later.

On Linux, `sh run/build/all.sh` builds the AppImage, Ubuntu `.deb`, Android, CLI, Web and server in sequence. It continues after errors, reports each target and returns a failure code if any target fails. On Windows, use `run\build\all.bat`.

Desktop launchers accept `--portable` to build only the binary and one or more format names, for example `sh run/build/linux.sh rpm`.

The AppImage runs directly on compatible distributions with the same architecture. Tauri recommends building on the oldest supported distribution, such as Ubuntu 22.04 or Debian 12. The build machine's glibc version may exclude older distributions. BlueZ must be available on the machine running éPI for Bluetooth scales. [Tauri AppImage limitations](https://v2.tauri.app/distribute/appimage/#limitations)

On Android, transfer the APK to the phone and open it in the file manager. If prompted, allow installation from that manager. Launch éPI and grant Bluetooth permission. The SDK provides `adb` in `platform-tools`, under `%LOCALAPPDATA%\epi-dev\android-sdk` on Windows or `~/.local/share/epi-dev/android-sdk` on Linux. With USB debugging enabled and the phone authorised, use `adb install -r release/android/epi-debug.apk`. To produce an Android AAB, use the `--play` build described in the [build guide](docs/BUILD.md).

On iOS, from `tauri/` on macOS with Xcode, run `npm ci`, `npm run tauri -- ios init`, then `npm run tauri -- ios build`. Grant Bluetooth permission. CoreBluetooth identifies devices by a local UUID. On iPhone, pair the scale again if imported records come from a PC.

The [detailed CLI documentation](cli/README.md) describes measurements, reception and composition methods. The [plan and inventory](docs/SPECIFICATIONS.md) describe their implementation in the interface.

## Builds

See the [build guide for all targets](docs/BUILD.md).

## Licence

Original éPI code is licensed under [GNU LGPL version 3](LICENSE) (`LGPL-3.0-only`).
The éPI, Domun and Logisan logos and trademarks belong to Baptiste Pillot and are not covered by the code's LGPL v3 licence.
Third-party assets retain their licences and attributions.
[Third-party credits and sources](THIRD_PARTY.md) distinguish code adaptations, protocol references, scientific formulae and dependencies.
