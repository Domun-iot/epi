# éPI public website

Run `npm --prefix www start`, then open http://127.0.0.1:3002/epi.
Node.js 22.13 or later is sufficient; Node.js 24 is used for project verification.
Run HTTP tests with `npm --prefix www test`.

Language selection follows this order: `?lang=fr` parameter, cookie, browser preferences, British English. URLs remain identical across languages.

## Configuration and interfaces

- `EPI_WWW_PORT` changes the local port.
- `DOMUN_SOFTWARE_CATALOG_URL` supplies the JSON catalogue used by the Pro page. Tests inject a local server: no payment is needed to develop the site.
- `EPI_WWW_SECURE_COOKIE=1` enables the language cookie's Secure attribute.
- `EPI_WWW_RETENTION_FILE` points to a JSON file of privacy texts, indexed by language codes from `locales.js`. This local file remains outside Git.

The site displays plans and links to the external account service. It does not collect payments. `/epi/plan-features.json` exposes the feature matrix. The deletion link and legacy `/epi/delete-account` route lead to the account service.

## Developer pages and assets

`/epi/developers` and `/epi/download` describe available versions. The source panel links to the public repository, `https://github.com/domun-iot/epi`. The build guide is no longer exposed on the site; it remains in the repository. `/epi/license` presents the éPI software and website licence, with repository texts available under `/epi/licenses/`. Download tests use temporary files and do not alter real releases. The `public/weigh-ins.jpg` screenshot shows fictional data in simulation mode.

SVG logos come from `public/logos/` (Devicon, MIT licence; Simple Icons, CC0; see accompanying licences). Trademarks remain with their owners. The PWA logo follows the browser identified by User-Agent, falling back to a generic web icon. No third-party service is loaded for these logos.

## Website behaviour and tests

Download interface tests use the Playwright dependencies in `tauri`: from that directory, run `node --test test/downloads.test.js`.

Cards in the same row share grid tracks to align buttons and download information at the bottom. Clicking “SHA-256” displays and copies the checksum; clicking the checksum copies it again. Copy confirmation disappears after five seconds; another copy restarts the timer. A message appears if the browser denies clipboard access.

The PWA panel opens a window with numbered steps tailored to the current browser and system; without JavaScript, it remains expandable. The script also refines detection of iPads using a Mac User-Agent. “Install éPI” opens `https://epi.domun.eu/?install=1`: the application shows an installation window before account startup, then a native button when `beforeinstallprompt` arrives. Without this event (Safari, Firefox or installation unavailable), manual steps remain accessible. An application already open in installed mode shows confirmation. The download page cannot directly trigger installation on another domain. Shared instructions are in `shared/pwa-install.mjs`.
