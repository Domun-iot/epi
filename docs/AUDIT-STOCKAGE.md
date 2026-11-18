# éPI storage audit — 17 November 2026

Audit conducted after account datasets were introduced and before web client publication. Fixes include regression tests. No test accounts or datasets are created in production.

## Variant scope

| Variant | Root and access | Verification |
| --- | --- | --- |
| Installed or portable Windows, Tauri | Absolute EPI_DATA_DIR, upward data discovery from the program, otherwise application directory; invoke to Rust | Windows Rust tests and Chrome scenarios simulating native commands |
| Linux package or AppImage | Same selection; APPIMAGE starts from the original file rather than temporary mount | Platform branches reviewed, discovery and shell launchers tested; no Linux package run on a target distribution |
| macOS Tauri | macOS application directory or portable/explicit root | Paths and shared logic reviewed; no macOS machine used |
| Android and iOS | Private application directory; no shared desktop root | Offline Android aarch64 Rust compilation succeeded; iOS branch reviewed without build or hardware test |
| Development CLI and standalone executable | Common desktop root; binary directory for SEA | CLI and launcher tests, paths with spaces, active dataset selection/generation |
| Personal web, Vite development and Node release | Local installation; /api/session file endpoint; initial anonymous use allowed | Local API tests, actual release built and started with temporary data |
| Hosted web | Server accounts/<UUID> root; API verifies account on every access | HTTP, Chrome and actual hosted release tests with two isolated fictional accounts |
| Browser interface preview | Per-browser simulation storage; no transaction transfers | Interface tests; remote repair and synchronisation remain disabled |

Personal and hosted web remain two build modes from the same code. The hosted server never exposes the personal web installation manager.

## Covered scenarios

- Old, new, accounts-only, missing, locked or explicitly configured roots; explicit path priority and refusal of relative paths ambiguous between launchers.
- First startup without an account; anonymous data; FREE linking without cloud access; PRO linking with empty or populated remote accounts; count and period comparison; merge, replacement and cancellation.
- FREE to PRO upgrade, return to FREE, PRO expiry during a request, token expiry, network failure and reconnection; offline access to the last local dataset and durable explicit logout.
- A to B then A, multiple tabs, saving/import/export in flight, delayed responses, cancelled Google login, credential persistence failure, closure and restart.
- ZIP and history import, duplicates, invalid fields, unsafe paths and symbolic links; concurrent versions, deletion followed by an old write, intentional restoration.
- Interrupted migration or linking, switch recovery, another process's lock, dead owner, simultaneous lock claims, backup and restoration.
- Durable web writes with SQLite publication temporarily unavailable; recovery through another client's download after restart; complete snapshot independent of existing acknowledgements.
- Deployment interrupted before or after build moves; restoration of scripts, markers and old artefacts; preservation of active data.

## Defects found and fixed

| Priority | Defect | Fix |
| --- | --- | --- |
| P1 | First approved remote revision lost on restart before upload. | Revision retained in installation configuration; only acknowledgement for the same account and generation can remove it. |
| P1 | PRO entitlements could expire after initial authorisation of a slow or queued request. | Checks during processing, before mutation and after export. |
| P1 | Google cancellation or an old account response could complete a late login. | Interaction epochs, request cancellation, checks after each wait, failed-account cleanup. |
| P1 | A token that could not be erased could reopen a dataset after explicit logout. | In-memory authentication removed even if storage fails; locked installation does not automatically reuse the token. |
| P1 | Shutdown between publishing a new account directory and selection could leave incomplete linking. | Recovery journal also used for first linking, backups and container checks. |
| P1 | Some CLI reads migrated identities without the installation lock. | Reads/migrations/writes grouped under one lock. |
| P1 | Two recovery processes could delete a recent abandoned-lock claim. | Immutable recovery tickets and non-blocking selection; Node re-entrancy restricted to the same asynchronous context. |
| P1 | Interruption between moving a build and updating a flag could break rollback. | Restoration based on existing backups; replacement intent recorded before moving. |
| P2 | Failed SQLite publication reported failure after a successful web write. | Saved state returned with synchronisation pending; journal recovered on the next web request or native download. |
| P2 | Archives could contain invalid operations despite a valid UUID. | Operations, values, paths and duplicates validated before any history write. |
| P2 | Old interface/session files and BOM JSON were not all included in the initial journal. | Complete baseline and consistent normalisation; window preferences excluded from exchanges. |
| P2 | An account containing only pending weigh-ins appeared empty. | Detect this data without counting it as saved weigh-ins. |
| P2 | Restoring an old cache could retain acknowledgements hiding newer server data. | Explicit repair from the same account's complete snapshot, merging versions and preserving deletions. |
| P2 | Late installation failure could leave new deployment markers. | Marker restoration alongside scripts and injected-failure tests. |

Account banners, details, forms and BLE logs are also removed from the interface on account switch. Persisted BLE logs remain attached to their dataset. Same-account repair preserves useful views and dialogues.

## Verification results

| Suite | Result |
| --- | --- |
| Windows Rust | 29/29 |
| Android aarch64 compilation check | Passed offline with installed NDK |
| CLI | 19/19 |
| Node account/file management | 17/17, including an actual Windows junction created outside the sandbox |
| Node interprocess lock | 7/7, including simultaneous claims and independent asynchronous contexts |
| Node journal | 8/8 |
| Server API and hosted sessions | 20/20 |
| Installation and rollback | 4/4 |
| Selection and repair controller | 10/10 |
| Chrome interface | 91/91 |
| Windows and Git Bash launchers | 16 simulated variants and 2 fixture flows |
| Actual web releases built | Hosted and personal started with isolated temporary storage |

The final logout sequencing fix invalidates an in-progress transition, waits for completion, then locks data; another account arriving during that wait cannot be logged out by the old request.

## Validation limitations

Android compilation validates mobile and Unix storage paths; it is not a user test on a phone. The Windows junction test ran with host permissions and passed.

Automated tests do not replace trials with a real scale, installed APK, Linux package, macOS or iOS. Local Chrome execution checks the compiled client and HTTP flows, not physical mobile WebView specifics. Local files are unencrypted: application locking does not protect against an operating system user with disk access.

The protocol retains time-based version comparison; severely skewed clocks remain a limitation. Backups and journals need a retention policy. Operator server restoration must consider both SQLite and account files; deployment never automatically overwrites active data with an old backup.
