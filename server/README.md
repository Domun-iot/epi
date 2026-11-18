# éPI synchronisation server

Standalone HTTP API written in TypeScript. Node.js 22.13 or later is sufficient to run the compiled server. It uses SQLite through `node:sqlite` and creates its schema at startup in `server/data/epi.sqlite`.

## Running the server

From the repository root, use these scripts (`.bat` extension on Windows).

| Script | Action |
| --- | --- |
| `run/prep/server.sh` | Installs locked build dependencies. |
| `run/build/server.sh` | Checks and compiles TypeScript into `server/dist/`. |
| `run/dev/server.sh` | Runs TypeScript and restarts on source changes. |
| `run/server.sh` | Runs the compiled server, building it on first launch if necessary. |

Edit `server/config.js` to change the port (default 8787), listening address or SQLite file. The default address is `127.0.0.1`. Restart after configuration changes. HTTP transmits passwords, tokens and data in plain text. For remote access, terminate HTTPS in front of the server.

The hosted web client relay uses `EPI_WEB_PORT` (default 3001). The API process and hosted file server must use the same value. The independent public website uses `EPI_WWW_PORT` (default 3002).

Run local checks with `npm --prefix server test`.

## API

POST bodies use JSON with `Content-Type: application/json`. Synchronisation routes use `Authorization: Bearer <token>`.

| Method and route | Body | Response |
| --- | --- | --- |
| `POST /v1/accounts` | `{"email":"a@example.org","password":"example-password"}` | `201` and `{"email":"a@example.org"}`. `409 account_exists` if the address already exists. |
| `POST /v1/device-tokens` | `{"email":"a@example.org","password":"example-password","deviceId":"pc-1"}` | `200`, including `{"token":"…","paid":false,"paidUntil":null}`. |
| `GET /v1/account` | Device token. | Current account, stable `accountId` UUID, `paid`/`paidUntil` entitlements, language and Google configuration. |
| `GET /v1/dataset` | PRO token. | `{accountId,files,summary,revision}`: materialised state and history, with `summary={count,from,to,hasData}`. |
| `GET /v1/dataset/summary` | PRO token. | Same summary and revision, without files. |
| `POST /api/session` | Device token and `{action,args,datasetId}`. | Authenticated PRO account's hosted session; `401` without a valid session, `403 pro_required` on FREE, `409 dataset_changed` if the requested account differs. |
| `DELETE /v1/device-tokens` | `Authorization: Bearer <token>` header | `204`. Revokes this token without deleting device acknowledgements. |
| `POST /v1/transactions` | JSON object `{"transactions":[…]}` or one JSON transaction per line (`application/x-ndjson`). | `200` and `{"inserted":1,"uuids":["…"]}` with confirmed UUIDs. |
| `GET /v1/transactions/pending` | Optional `after` parameter | `200` and `{"transactions":[…],"next":null}`. Timestamped transactions sorted by UTC filename. If `next` is set, pass it as `after` for the next page. |
| `POST /v1/transactions/acknowledge` | `{"uuids":["…"]}` | `200` and `{"inserted":1}` for a new acknowledgement. |

Errors have the form `{"error":"code"}`. Registration is open. The client chooses a device identifier that must remain stable for that instance. It accepts 1–128 ASCII letters, digits, dots, hyphens and underscores. Each issuance replaces the device's previous token. After more than 30 days without use, the token is deleted and the API returns `401 token_expired` until a new password or Google login. Device acknowledgements are retained.

JSON uploads accept up to 100 entries and 4 MiB per request. NDJSON sends the local queue in one request, with the same per-transaction size limit. The server validates and saves groups of up to 100 transactions and 4 MiB. After interruption, the client can resend the entire batch. The server retains the first content submitted for a UUID. An equivalent retry confirms the UUID and can add its timestamped name if missing from the original entry. A UUID associated with different JSON is excluded from confirmations. UUIDs use canonical lowercase format. Download acknowledgements for UUIDs unknown to the account are ignored and can be resent after submission.

## Subscription management by domun

The private API accepts the service token defined by `EPI_DOMUN_API_TOKEN` as 64 lowercase hexadecimal characters. domun sends it through `Authorization: Bearer <token>`. Restrict `/v1/domun/` to loopback in production. Without a configured token, these routes return `404`.

| Method and route | Body | Response |
| --- | --- | --- |
| `GET /v1/domun/accounts` | None. Optional `after` parameter. | `200` with `{"accounts":[{"id":"…","email":"a@example.org","paidUntil":null}],"next":null}`. Pass `next` as `after` for the next page. |
| `DELETE /v1/domun/account-deletion` | `X-Domun-Device` header with the account's device token. | `204`. Marks the account and blocks access. |
| `GET /v1/domun/accounts/purge` | Optional `after` parameter. | `200` with `accounts`, each containing `id`, `email` and `deletedAt`, and a `next` cursor. |
| `POST /v1/domun/accounts/purge` | `{"ids":["…"]}` | `200` with the purged account count in `purged`. Only listed accounts marked for strictly more than one UTC calendar month are eligible. |
| `PUT /v1/domun/accounts/<id>/entitlement` | `{"paidUntil":"2027-01-01T00:00:00.000Z"}` or `{"paidUntil":null}` as JSON. | `204`. `404 account_not_found` if deleted. |

PRO checks are repeated after processing waits and before returning a snapshot; expiry during the request blocks the remaining transfer.

The server checks entitlements with `EPI_DOMUN_BILLING_URL` (loopback, `EPI_DOMUN_API_TOKEN` token) for every transaction upload, read and acknowledgement. FREE accounts receive `403 pro_required`; an admin outage gives `503 subscription_unavailable`. Account login and stored data remain available for a future subscription.

The account identifier, `domunId` in `GET /v1/account`, remains stable. `accountId` represents the same 128 bits as a canonical UUID; the server supplies it to clients to select their data directory. Reregistration receives a new identifier. Password and Google login responses and `GET /v1/account` return `paid` and `paidUntil`. `paidUntil` contains the UTC expiry, even if past, or `null` without an expiry. `paid` is `true` while expiry is in the future.

## Accounts in the application

Open **Account** in web or Tauri. Creating an account opens a session. Explicit logout closes local account dataset access even offline; remote token revocation is attempted when the server is reachable. Token expiry retains the last active dataset on local installations and in browser storage; hosted API mode requires a new login.

Web and Tauri clients access accounts through `https://epi.domun.eu` in all modes, including development. The proxy must forward `GET`, `POST`, `DELETE` and `OPTIONS` on account routes, together with CORS headers.

### Google login

1. Create a **Web application** OAuth client in Google Cloud, configure consent and add the exact redirect URI, `https://epi.domun.eu/v1/google/callback` in production. In test mode, add authorised Google accounts.
2. Before starting the server, set `EPI_GOOGLE_CLIENT_ID`, `EPI_GOOGLE_CLIENT_SECRET` and `EPI_GOOGLE_REDIRECT_URI`. For testing on the same computer, register and use `http://127.0.0.1:8787/v1/google/callback`. The browser must reach the callback URI; the server must reach Google services over HTTPS.
3. Restart the server. In **Account**, the Google action supports login, account creation and linking. Tauri opens the system browser for login, creation or linking, including on Android. On web, account selection opens in a new tab. Return to éPI after approval.

The server exchanges the authorisation code with Google using PKCE, validates the OpenID Connect token received directly from Google over HTTPS and retains the stable `sub` identifier. Google tokens are used only for this exchange. éPI then issues its usual device token. An existing email address requires éPI login and password confirmation to link Google.

To unlink Google, confirm your éPI password in the application. If Google is your only login method, choose and confirm a new éPI password on the same screen. Unlinking uses the éPI session and preserves authorisations stored by Google.

Google requests expire after five minutes and remain in memory. With multiple API instances, request initiation, callback and completion must reach the same instance. Avoid logging the callback query string, which contains the authorisation code and state parameter. Password login remains available without Google configuration.

## Hosted web application

At startup, the server imports `web/hosted-api.js` from the complete repository. Each account's data is materialised in `server/data/accounts/<accountId>`; the UUID comes from the server-verified token, never a browser-supplied path or body. Raw synchronisation actions are not exposed through `/api/session`. PRO actions are checked server-side. Hosted storage is PRO-only, including simple reads. FREE uses the browser localStorage adapter without data exchange between browsers; the local-usage flag is recorded as soon as FREE is confirmed. A PRO browser without local usage accesses the API directly. Other PRO web clients remain local and synchronise their journal. Subscription verification failure must not confirm FREE: fallback account responses carry `entitlementVerified: false`, and hosted sessions return `503 subscription_unavailable`. See [storage architecture](../docs/ARCHITECTURE-STOCKAGE.md).

The SQLite journal is replayed independently of device acknowledgements to reconstruct existing data. An old domain operation without a timestamped name blocks reconstruction with `503 dataset_recovery_required`; it needs explicit migration rather than an invented deletion date. Old opaque envelopes without domain operations are ignored during materialisation. PRO web changes join the same journal without creating download acknowledgements on behalf of another device. If SQLite temporarily refuses publication after successful file writes, the session returns saved state with `X-Epi-Sync: pending`. The local journal remains durable and publication is retried on web requests or the next PRO device download, including after restart. A snapshot unable to guarantee publication returns `503 storage_saved_sync_pending`. Imported history is validated before archiving: allowed paths, non-empty operations, object values and unique paths per transaction. Account directories reject nested symbolic links. Deletions remain in history: an old transaction cannot recreate a deleted record. Final account purge also removes its hosted directory.

For initial local PRO linking, the client reads a consistent snapshot, shows weigh-in counts and date ranges, then may use `If-Match: <revision>` on first upload. A stale revision returns `409 dataset_changed` before writing the batch. The snapshot includes history and index to avoid replaying operations already applied. Local activation bodies are limited to 32 MiB; larger snapshots require a suitable migration before linking.

`node web/build.mjs --hosted` produces hosted client files. See the [build guide](../docs/BUILD.md) for targets and prerequisites.

## Client loop

Account responses (password or Google login, account reads and updates) include `deviceCount`, the number of distinct installation identifiers that have logged into the account. Logged-out or expired installations remain counted; reconnecting with the same identifier does not increment it. It does not represent geographical locations. It is retained in local account information alongside the subscription. From two installations onwards, FREE accounts see an invitation below their weigh-ins to discover PRO synchronisation.

The client downloads transactions at startup and on account session changes. It follows `next` and acknowledges integrated or already present local UUIDs. It then sends the local queue, retrying in the background. An accepted upload also creates the sending device's receipt to avoid returning its own transaction. [Synchronisation behaviour and edge cases](../docs/SYNCHRONISATION.md) details replay, storage guarantees and conflicts.

The private `GET /v1/domun/accounts` list includes `deletedAt` (UTC timestamp or `null`) so Domun accounts marked for deletion appear in administration before purging.

It also returns `createdAt`, the source account's UTC creation date, including accounts marked for deletion. This is `null` for older accounts with an unknown creation date. Administration can therefore distinguish accounts with the same email address.
