# Storage ports and adapters

Storage is selected in tauri/src/storage/adapters.js through createStorageAdapter. The interface uses a stable session port without deciding where to write each object. The domain engine retains its persistence port, load()/save(state, previous).

## Separate storage backends

| Adapter | Deployments | Persistence and behaviour |
| --- | --- | --- |
| native-files | APK/iOS and Windows, Linux and macOS applications | Tauri commands access files through Rust. Private mobile directory, application or portable directory on desktop. Paths, locks, account datasets and offline behaviour are preserved. |
| personal-api | Personal web, dev-web and personal Node release | HTTP actions against the local Node installation, retaining its files and the active dataset shared with Tauri/CLI. No automatic localStorage selection in this deployment. |
| hosted-api | Shared web, confirmed PRO account and browser without local usage | HTTP actions against the account dataset on the server. Authentication and PRO subscription checked by the server before reading or writing. No client synchronisation queue. |
| preview | Development preview of the Tauri client in a browser | Existing localStorage simulation without synchronisation. Behaviour preserved and isolated from the new user mode. |
| browser-local | Anonymous, FREE or previously used locally on shared web | localStorage for this origin and browser. Separate account datasets, durable journal and PRO-only synchronisation. |

The first three modes and the simulation existed before this extraction. browser-local is the new user mode. The CLI retains its Node file modules and the same JSON protocol; it does not use the graphical interface's session façade. The server still uses web/file-storage.js for persistence and SQLite for accounts and synchronisation exchanges.

## Contracts

- **SessionPort**: open(options) returns domain engine actions with the same return values and notifications, plus file imports/exports where available. HTTP adapters execute these actions on the server; local adapters inject their persistence into the client engine.
- **DatasetPort**: context, prepare, activate, logout and confirmSync for storage that supports synchronisation. Separates account selection from persistence and its token. Shared web adds select(info) after entitlements are confirmed.
- **PersistencePort**: load, save, exportFiles, importFiles, pendingTransactions, archiveTransactions and integrateTransactions for complete local data. The engine requires only load/save, with transaction integration as an additional capability. APIs do not simulate snapshot saving: concurrency guarantees remain on the server.

The kind, remote and synchronizes properties express adapter capabilities. Account login, merge dialogues, generation safeguards and PRO transaction transfers remain separate. Another backend implements the same contracts and joins the composition without scattering storage branches throughout the interface.

## Shared web selection

| Situation | Result |
| --- | --- |
| Anonymous visit without saving | Browser adapter; visiting alone sets no flag. |
| First anonymous save | Browser adapter; local usage recorded durably. |
| Confirmed FREE account, even without data | Browser adapter; local usage recorded immediately. No server data access or transfer between browsers. |
| Confirmed PRO account without local usage | Hosted API adapter. Other PRO browsers in API mode access the same server dataset. |
| PRO account with recorded local usage | Browser adapter retained; initial reconciliation followed by existing PRO synchronisation. |
| FREE to PRO upgrade | Remains local; remote data reconciled as in installed applications. |
| PRO API to FREE downgrade in an open screen | The account's last loaded state becomes a browser dataset and local usage is recorded. Server files are retained but inaccessible on FREE. |
| Subscription verification unavailable | Does not confirm FREE or accidentally create a flag. The server returns entitlementVerified: false for fallback entitlements; an API outage causes no implicit switch. |

Automatic selection applies only to the hosted build. Native builds and personal web retain their behaviour.

The epi-browser-storage-v1 document contains the usageLocal flag, selection and generation, account data, journals, deletions and recovery copies. Existing data also prevents an automatic switch if a flag has been removed manually. A new account never inherits another account's local data. After linking, logout deselects the account and locks its data without deleting it.

## Durability and limitations

A browser mutation writes data and journal in a single localStorage.setItem. Quota exhaustion or unavailable storage fails the action without reporting success or replacing the previous document. Writes check the dataset, generation and loaded state; concurrent changes trigger a reload rather than an overwrite. Web Locks serialise mutations between tabs where available; other browsers retain optimistic checks without guaranteed serialisation between processes.

The journal uses the same paths, UUIDs, versions and transaction names as Node/Rust files. Deletions prevent old writes from reappearing. ZIPs include preferences, notifications, pending weigh-ins, views and history; validated incoming entries are replayed and queued again. The first transfer retains the reviewed remote revision. Repairing the same account preserves newer local writes and deletions.

Local data is subject to browser quota and clearing, browser profile and web origin; this mode provides neither an external backup nor encryption. Journals and recovery copies also consume quota. FREE shares nothing between browsers. PRO retains the entitlements and synchronisation of other local clients. The shared API avoids a client queue; an already displayed screen still needs reloading to reflect a remote change.

Tests cover selection, restart, account separation, quotas, concurrency, exchanges with Node storage and compiled hosted-client flows in Chrome. Executables and physical devices require their own validation; this refactoring does not change Rust code.
