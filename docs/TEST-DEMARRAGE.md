# Checking éPI startup

From the repository root, run `node scripts/test-launchers.cjs`. The test executes the platform's production launchers in temporary directories whose paths contain spaces. It covers missing, current and stale binaries, and a failed build with an old binary still present. It checks the working directory, forwarding an argument containing spaces and the CLI exit code. The fixture must produce 48 weigh-ins and retain that total on a second run.

To exercise shell scripts on Windows too, use Git Bash by setting `$env:EPI_SMOKE_BASH = 'C:/Program Files/Git/bin/bash.exe'` before rerunning the command. Executables and builds in this suite are simulated.

## Testing on Linux

1. In a terminal, create a separate data directory with `export EPI_DATA_DIR="$(mktemp -d)"`, then run `sh run/fixture.sh`.
2. Run `sh éPI.sh`, close the application, then run `sh run/dev/tauri.sh`. In each window, check styling on startup, select the `test` profile and verify the 48 weigh-ins.
3. Run `sh run/cli.sh --help` and `sh run/dev/cli.sh --help`. Each command must display help and exit with code 0.
4. Install the `.deb` package or run the AppImage on a compatible distribution. Check startup from a directory outside the repository with the same `EPI_DATA_DIR`, then open the test profile.

## Packages and scales

- On Windows, validate the MSI or NSIS installer on a test machine or VM. Open éPI from its shortcut, import a test data ZIP and check styling and the 48 weigh-ins.
- On a test Android device, install the APK with `adb install -r release/android/epi-debug.apk`. Open éPI from the Android launcher, accept Bluetooth permissions, import the test ZIP and check the same profile.
- On Windows, run `run\cli.bat --identify --seconds 30`, then `run\dev\cli.bat --identify --seconds 30`. Wake the scale during each listening period and check that an advertisement matches it. Identification mode checks reception without saving a weigh-in.
