# éPI data synchronisation

## Multi-account behaviour since 17 November 2026

The [accounts and datasets guide](COMPTES-ET-DONNEES.md) describes current behaviour: local UUID directories, offline access to the last dataset, locking after explicit logout, linking and initial PRO synchronisation with merge choices, authenticated web sessions, generation checks and deletion tracking. Synchronisation remains prohibited on FREE. The client receives new transactions on each periodic pass; manual reload uploads then downloads.

The following sections preserve the historical study of 15 November. Defect findings, particularly the shared directory between accounts and missing tombstones, describe the version studied then and are superseded by the mechanisms above. Device clocks, file-level granularity and journal growth remain protocol limitations.

## Historical study

Repository state on 15 November 2026, commit `cbc2fb4`. The study covers Tauri, the web session server, CLI journal and synchronisation API. The version actually deployed in production remains to be checked.

## Account and synchronisation scope

Synchronisation connects installations logged into the **same éPI account**. The API derives the account and device from the `Authorization: Bearer` token. Password and Google login both issue an éPI token. The browser or WebView retains its session and a stable `deviceId` in `localStorage`. A new login from the same device to the same account replaces its token. Revocation and expiry after 30 days of inactivity preserve device receipts. [Account client](../tauri/src/account.js) · [API](../server/api.ts) · [SQLite storage](../server/store.ts)

Tauri writes to the installation data directory. On web, the browser uses `/api/session`, which opens a file dataset for the web process. The éPI API, configured at `https://epi.domun.eu`, retains transactions per account in SQLite. Simulation mode uses browser storage without file synchronisation. The CLI feeds the local journal. Tauri or web can send these writes when sharing the directory. [Client services](../tauri/src/service.js) · [Web session](../web/session-api.js) · [CLI storage](../cli/storage.cjs)

Transfers cover journalled writes: profiles, scales, weigh-ins, views, preferences and notifications. Global preference or notification writes may carry a complete document containing, as applicable, a pending weigh-in, restoration data or window settings. Login performs no initial inventory of existing files. Data predating the journal needs another recovery route, such as ZIP import into an empty directory, which journals added files. [Tauri storage](../tauri/src-tauri/src/storage.rs) · [Web storage](../web/file-storage.js)

## Format and storage

A transaction contains `uuid`, `type` and `data`. The UUID identifies the write independently of profile, scale or weigh-in UUIDs. `create` and `update` contain a relative path and complete JSON value. `delete` contains the path. `batch` groups operations, each with its type and path. Names encode UTC creation time to six decimal places and the UUID, for example `2026-11-15T14-30-00.123456Z-12345678-1234-4234-8234-123456789abc.json`. The sender ensures monotonically increasing timestamps within its process. [Node.js journal](../shared/transactions.cjs) · [Tauri journal](../tauri/src-tauri/src/transactions.rs)

| File or directory | Role |
| --- | --- |
| `data/transactions/` | Upload queue. Operations have already been written to domain files. |
| `data/transactions.sent/` | Archive of confirmed local and integrated remote transactions. |
| `data/transactions.index` | Known UUIDs, one per line. On API receipt, presence in the index or either directory above is sufficient to acknowledge a UUID. |
| `data/transactions.incoming/` | Manual Node.js replay queue. `replayTransactions(dataDir)` traverses it under a lock in filename order, applies unseen transactions, archives them in `transactions/` and removes processed files. API reception archives directly in `transactions.sent/`. |
| SQLite `transactions` and `receipts` | Journal by `(account, UUID)` and receipts by `(account, device, UUID)`. |

Tauri or web ZIPs include data and these history files. Import preserves existing files, journals added domain files and merges history separately. It retains the distinction between upload queue and archive. [Web import](../web/file-storage.js) · [Tauri import](../tauri/src-tauri/src/storage.rs)

## Transaction lifecycle

1. **Local write.** Storage writes domain files, creates the JSON transaction in `transactions/` and adds its UUID to the index. On detected errors, it attempts to restore modified files. Web groups changes from one `save`. Tauri may record multiple transactions for one user action.
2. **Trigger.** The interface starts one loop per instance. Writes reported by interface storage and session changes restart it. It reschedules after roughly one minute. For a token still awaiting reception, it attempts download before upload. Each API request has a 15-second client timeout.
3. **Download.** `GET /v1/transactions/pending` returns account transactions without a receipt for this device. Entries are sorted by timestamped name. Older entries without `name` come last, in SQLite sequence order. The client follows `next` to the last page. A page contains up to 100 entries and approximately 4 MiB. The cursor marks a sort position and each page rereads current state.
4. **Replay and acknowledgement.** Known UUIDs are acknowledged directly, including entries without `name`. Unknown UUIDs require a valid name; the client applies operations, archives the transaction without transport field `name` and adds the UUID to the index. It sends selected UUIDs to `POST /v1/transactions/acknowledge`. An individual failure leaves the entry unacknowledged while subsequent entries are processed. Request errors allow a retry. After completing traversal, the same token no longer downloads on subsequent passes until reopening or an account event.
5. **Upload.** The client reads `transactions/`, leaves unreadable or oversized files pending and sends the rest in one NDJSON request to `POST /v1/transactions`, with original names. The API also accepts JSON batches of up to 100 entries and 4 MiB. For NDJSON, the server writes groups of up to 100 entries and 4 MiB. If the stream fails, committed groups remain saved.
6. **Confirmation.** SQLite saves accepted uploads and the sender receipt in one commit. Equivalent retries also confirm the UUID and set the receipt. They may complete `name` on an equivalent historical entry. On collision with different content, the first version stays in the database and the UUID is excluded from the response. Only confirmed UUID files move to `transactions.sent/`. The receipt prevents returning the operation to its sender; other account devices can receive it.

After five seconds of client-observed waiting, the icon to the right of **Account** shows the oldest outgoing transaction date. Its sending animation lasts at most fifteen seconds. [Client loop](../tauri/src/transaction-sync.js) · [API routes](../server/api.ts) · [SQLite transactions](../server/store.ts)

**Guarantees.** SQLite guarantees atomicity of an upload group with its receipts and of an acknowledgement batch. Upload or delivery may repeat after a lost response. Local history deduplicates UUIDs during replay. Each client materialises state in files through successive writes, attempting restoration on error. [SQLite](../server/store.ts) · [Web replay](../shared/transactions.cjs) · [Tauri replay](../tauri/src-tauri/src/transactions.rs)

## Critical review

Priorities favour confidentiality, then data integrity and freshness, then operating cost.

### Priority 0 · Local account isolation

- **A local queue can change accounts.** A pending weigh-in from A after logout can be sent with B's token. The directory, queue and index are not account-bound. A's files remain locally visible and B's transactions apply in the same directory. [Account](../tauri/src/account.js) · [Loop](../tauri/src/transaction-sync.js)
- **Two web sessions can share a dataset.** Two browsers using the same web process may use different éPI accounts. `/api/session` processes storage actions in a common directory without associating them with the éPI token. The supplied server listens on loopback by default. Network exposure widens access to this shared dataset. [Web session](../web/session-api.js) · [Web configuration](../web/config.js)

### Priority 1 · Integrity and freshness

- **Concurrent changes can diverge.** Replay of `create` and `update` writes complete JSON even if a file exists. If two devices edit the same file offline and each uploads before downloading, each may retain the other's version after exchange. The server avoids returning the sender's own write and clients do not recompute latest state in a shared order. At startup, a remote version can overwrite a file before its pending local version uploads. Later upload does not reapply the local version to its sender. Deletion can also erase a concurrent edit or be undone by a late update. [Web replay](../shared/transactions.cjs) · [Tauri replay](../tauri/src-tauri/src/transactions.rs) · [Server receipts](../server/store.ts)
- **Chronological sorting per page does not guarantee global application order.** Clock skew, a late offline upload or completing `name` on an old entry can place an operation before the current cursor. It remains eligible for the next traversal and may then overwrite a newer version. Dependent operations may arrive backwards, such as a weigh-in before its referenced profile. [Server sorting](../server/store.ts) · [Pagination](../server/api.ts)
- **An open interface can retain stale state.** After the first complete traversal, the periodic loop no longer downloads with that token. A later weigh-in from another device, or an individually rejected transaction, waits for another traversal. The icon shows the outgoing queue without detailing integration failures, UUID collisions or token expiry. [Client loop](../tauri/src/transaction-sync.js) · [Account](../tauri/src/account.js)
- **Abrupt shutdown can separate data from its journal.** Stopping between writing a domain file and its transaction can leave an unqueued change. Stopping mid-`batch` can leave a partly applied batch. Checks and restoration cover errors detected at runtime. In-memory queues serialise calls within an instance, while several Tauri, web or CLI processes may write to the same directory. The manual replay lock covers only its own queue. [Node.js writes](../shared/transactions.cjs) · [Web save](../web/file-storage.js) · [Tauri save](../tauri/src-tauri/src/storage.rs)
- **A ZIP and server receipts can represent different states.** Restoring an old directory with the same `deviceId` can leave missing operations hidden by receipts. ZIP import may preserve a conflicting local file while adding its imported UUID to the index. That UUID is then enough to acknowledge remote content. A new device identifier makes history eligible for download. Reconstruction depends on journal content, order and conflicts. [Receipts](../server/store.ts) · [Node.js history](../shared/transactions.cjs) · [Tauri import](../tauri/src-tauri/src/storage.rs)

### Priority 2 · Compatibility and operations

- **Upload validates less than replay.** The API validates envelope, UUID, name format if supplied and size. Upload can be confirmed even when operations cannot apply at the recipient. Tauri validates the name's date and rejects malformed indexes, while web filters invalid index lines. An old unnamed transaction remains inapplicable on an installation unaware of its UUID. An unreadable, oversized or colliding outgoing file can remain pending indefinitely. [API](../server/api.ts) · [Node.js index](../shared/transaction-index.cjs) · [Tauri validation](../tauri/src-tauri/src/transactions.rs)
- **Queues and history grow.** The client builds an in-memory NDJSON request containing the whole eligible queue. Long offline periods increase preparation and retry cost. Server sorting uses an expression computed from JSON. The protocol purges neither journal nor receipts. Values predating edits or deletions may persist in SQLite, local archives and ZIPs. [Client upload](../tauri/src/transaction-sync.js) · [SQLite query](../server/store.ts) · [Web export](../web/file-storage.js)

## Improvements requiring decisions

1. **Isolate data before using multiple accounts on the same storage.** Bind directory, queue and index to a stable account identifier. Define what happens to existing data on first linking. Bind web server actions to the same account and ensure in-flight exchanges retain their original dataset. Test A and B on one machine with an offline weigh-in from A.
2. **Define conflict rules before generalising continuous reception.** Use immutable server ordering to traverse history. Separately define handling of writes based on stale versions, such as per-object versions with rejection or replacement rules. Retain deletion versions and decide which preferences stay device-specific. Test concurrent edits, deletion against editing, clock skew and an old upload arriving after cursor passage.
3. **Make recovery visible and bounded.** Track uploads, downloads, latest successes and blocked UUIDs. Add versioned upload validation, per-UUID rejection reasons and bounded outgoing batches. Handle old unnamed entries. Resume periodic reception after fixing conflict rules. Test lost responses, mid-batch rejection, token expiry and long queues.
4. **Plan restoration and retention.** Allow replica reconstruction from a consistent snapshot and recovery point. If files remain primary storage, provide a recovery journal able to finish or undo interrupted writes. A transactional local database could commit domain data and outgoing queue together. Test shutdown between every step and restoration with or without the same `deviceId`. Define retention periods for old versions, transactions and receipts.

## Local verification

The five Node.js journal/web storage tests and three server tests pass. They cover replay, duplicates, web storage persistence, server account isolation, pagination and receipt persistence. A trial with two temporary directories confirmed divergence after update exchange and overwriting by an older update received later. Account switching, abrupt shutdown and restoration described above were analysed in code. [Journal tests](../shared/transactions.test.cjs) · [Web storage tests](../web/file-storage.test.js) · [API tests](../server/api.test.mjs)
