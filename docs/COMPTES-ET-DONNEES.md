# Accounts and datasets

Installed applications and personal web work without an account. Shared web supports anonymous and FREE use in the browser; remote storage requires a PRO login checked by the server before any read or write. PRO views and imports/exports use the same permissions everywhere. Synchronisation between installations or browsers is exclusively PRO. See [storage ports and adapters](ARCHITECTURE-STOCKAGE.md) for shared web selection rules.

## Local organisation

The root is still determined by EPI_DATA_DIR, a data directory found by searching upwards from the program, or the user directory. Detection recognises the old devices/measures/profiles trio, local, accounts and installation markers. A directory containing only the server's SQLite database is not a client data directory.

- local/ contains the anonymous dataset.
- accounts/<UUID>/ contains files, preferences, notifications and journals for that account alone.
- installation.json contains the active account, permanent account-mode lock, selected dataset generation, accounts whose first synchronisation has been validated, and window preferences. This information is neither exported nor synchronised.
- backups/ contains recovery copies from migrations, linking and replacements.

The UUID comes from the stable server identifier; an email address is never a directory name. Old data contents migrate to local with a backup and recovery journal. Use applications rebuilt for this organisation after migration; older versions do not recognise these subdirectories.

## Login and offline operation

The selected dataset and online token are independent. At startup, the last active account opens its local dataset even without a network connection. An expired token prevents exchanges but does not deselect the data. Previously verified PRO entitlements remain available locally until expiry.

Explicit logout removes the token and active selection without deleting files. Once an account has been linked to the installation, the application requires a new login: it never recreates an anonymous dataset by default, even if account directories have been removed. Switching accounts opens only the corresponding directory.

The interface lock does not encrypt files. An operating system user with sufficient permissions can read backups and directories.

## First linking and upgrading to PRO

On FREE, initial linking transfers the anonymous dataset into the account directory without consulting or downloading synchronisation data. Writes remain local; the queue is not sent to the server.

On first PRO linking, or the first FREE to PRO upgrade, the client reads an authenticated account snapshot. If both sides contain data, it presents weigh-in counts and date ranges, then offers to merge, use remote data or cancel. An empty remote account allows automatic linking. Another account's data never takes part.

Preparation uses a temporary directory. A merge starts from the remote snapshot, then integrates local writes and their current state according to their versions. Deletions remain in the journal to prevent an old write from returning. An intentional restoration receives a new modification date. A backup of the replaced dataset remains available. A replacement journal allows an interrupted switch to finish.

The first upload depends on the remote revision presented, retained in configuration even after restart. If the server has changed, files remain pending and the choice is offered again. Cancelling publishes nothing. Acknowledgements move only confirmed transactions into the same account's archive.

## Operation isolation

An interprocess lock shared by Node, the CLI and Tauri protects migrations, switches and writes. An active owner causes concurrent operations to be refused; an abandoned lock is recovered after checking the owning process. The personal web service retains this lock during asynchronous file operations.

Each asynchronous task retains the account and dataset generation that started it. An old response cannot update the new account; file commands reject a stale generation, including replacement within the same account. Temporary interface data and Bluetooth logs are separated during a switch.

On hosted web, the server checks the token on every request and selects accounts/<UUID> itself. No browser-supplied identifier can select another directory. PRO web writes join the same journal as other clients. Synchronisation calls are refused on FREE. Hosted files are removed when the account is permanently purged.

A manual PRO reload/synchronisation and completion of a ZIP import can repair the cache from the same account's complete snapshot, independently of old acknowledgements. Merging retains newer local changes and deletions. This repair does not repeat the initial linking choice and preserves the current account's dialogues.

## Verification

Test suites cover migration and recovery, data discovery, FREE linking, initial PRO synchronisation, merging and replacement, two-account isolation, expiry, offline logout, stale generations, deletions and restoration, web access without a token, FREE/PRO entitlements and Chrome interactions. Physical scale tests and newly installed packages remain separate from automated tests.
