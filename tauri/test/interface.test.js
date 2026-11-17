import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build, createServer } from 'vite';
import { unzipSync } from 'fflate';
import { measurementCharts } from '../src/measurement-charts.js';

let browser;
const url = 'http://localhost:1420/';
const types = new Map([['html', 'text/html'], ['js', 'application/javascript'], ['css', 'text/css'], ['png', 'image/png']]);
let outDir;

const address = 'AA:BB:CC:DD:EE:FF';
const device = { name: 'Salle de bain', bluetooth: { address, serviceUuid: '0x181B' } };
const alice = { name: 'Alice', sex: 'F', age: 45, heightCm: 165 };
const bob = { name: 'Bob', sex: 'H', age: 42, heightCm: 180 };
const record = { receivedAt: '2026-01-15T17:23:21Z', profile: { name: 'Alice' }, device,
  measures: { weight: 70, unit: 'kg', impedanceOhms: 475 },
  calculations: { IMC: { bmi: 25.7 }, Mi: { fatPercent: 31.8 }, Deu: { fatPercent: 33.1 } },
};
const frame = 'AABBCCDDEEFF -58 181B 0226e40709060d2605e9015a37 ConnectableUndirected TUlCRlM=';
const metadata = 'META AABBCCDDEEFF TUlCRlM= 0157';

before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'epi-ui-'));
  await build({
    build: { outDir }, logLevel: 'error',
    define: { __DEV_ACCOUNT_API__: JSON.stringify('https://sync.epi.test') },
  });
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

async function dismissNotificationBanner(page) {
  const close = page.locator('#notices').getByRole('button', { name: 'Vu', exact: true });
  await close.click();
  await close.waitFor({ state: 'hidden' });
}

async function pageWith(t, snapshot, options = {}, mode, setup) {
  const page = await browser.newPage({ locale: 'fr-FR', ...options });
  page.setDefaultTimeout(10000);
  await page.route(url + '**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (mode === 'web' && path === '/api/session') {
      if (typeof snapshot === 'function') return snapshot(route);
      const { action } = route.request().postDataJSON();
      return route.fulfill({ json: action === 'pendingTransactions' ? [] : snapshot });
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^(?:index\.html|assets\/[\w.-]+)$/.test(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(join(outDir, mode ?? '.', file)), contentType: types.get(file.split('.').at(-1)) });
  });
  page.on('pageerror', error => t.diagnostic(error.stack));
  page.on('response', response => {
    if (response.status() >= 400) t.diagnostic(`${response.status()} ${response.url()}`);
  });
  t.after(() => page.context().close());
  if (snapshot && mode !== 'web') {
    await page.addInitScript(state => {
      sessionStorage.seeded ??= '';
      if (!sessionStorage.seeded) {
        localStorage.setItem('epi-session-v1', JSON.stringify(state));
        sessionStorage.seeded = 'yes';
      }
    }, snapshot);
  }
  await setup?.(page);
  await page.goto(url);
  await page.locator('#status span:last-child').filter({ hasText: /\S/ }).waitFor();
  await page.locator('#theme-toggle:enabled').waitFor();
  return page;
}

test('loads the French catalogue in Vite dev and falls back to English on failure', async t => {
  const server = await createServer({
    server: { middlewareMode: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  t.after(() => server.close());
  const html = `<button data-i18n="measurements"></button>
    <script type="module">
      import { initialiseLanguage } from '/src/i18n.js';
      await initialiseLanguage();
    </script>`;

  for (const [language, label] of [['fr-FR', 'Mesures'], ['en-GB', 'Measurements']]) {
    const page = await browser.newPage({ locale: 'fr-FR' });
    try {
      page.on('pageerror', error => t.diagnostic(error.stack));
      await page.route(url + '**', async route => {
        const { pathname, search } = new URL(route.request().url());
        if (pathname === '/') return route.fulfill({ body: html, contentType: 'text/html' });
        if (language === 'en-GB' && pathname === '/src/locales/fr-FR.json') return route.abort();
        const module = await server.transformRequest(pathname + search);
        return route.fulfill({ body: module.code, contentType: 'application/javascript' });
      });
      await page.goto(url);
      await page.getByRole('button', { name: label, exact: true }).waitFor({ timeout: 10000 });
      assert.equal(await page.locator('html').getAttribute('lang'), language);
    } finally {
      await page.context().close();
    }
  }
});

test('garde les boutons de connexion groupés quand la fenêtre rétrécit', async t => {
  const page = await pageWith(t, undefined, { viewport: { width: 700, height: 600 } });
  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  const buttons = page.locator('#account-dialog .actions button');
  assert.deepEqual(await buttons.allInnerTexts(), ['Se connecter', 'Google', 'Créer un compte', 'Fermer']);

  const logo = page.locator('#account-google img');
  await logo.evaluate(image => image.decode());
  const googleLabel = page.locator('#account-google span');
  assert.ok((await logo.boundingBox()).x < (await googleLabel.boundingBox()).x);

  const rows = () => buttons.evaluateAll(items => items.map(button => button.getBoundingClientRect().top + button.offsetHeight / 2));
  const [wideRow, ...wideButtons] = await rows();
  assert.ok(wideButtons.every(row => row === wideRow));

  await page.setViewportSize({ width: 350, height: 600 });
  const [signIn, google, register, close] = await rows();
  assert.equal(signIn, google);
  assert.equal(register, close);
  assert.ok(register > google);
});

test('affiche une erreur lorsque la connexion Google ne peut pas démarrer', async t => {
  const page = await pageWith(t);
  let unavailable = true;
  await page.route('https://sync.epi.test/v1/google/start', route => unavailable
    ? route.abort('connectionrefused')
    : route.fulfill({ status: 503, json: { error: 'google_disabled' } }));

  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  const button = page.getByRole('button', { name: 'Se connecter avec Google' });
  const notice = page.locator('#account-error');
  await button.click();
  await notice.getByText('Le serveur de comptes est inaccessible.', { exact: true }).waitFor();
  unavailable = false;
  await button.click();
  await notice.getByText('La connexion Google est désactivée sur ce serveur.', { exact: true }).waitFor();

  await page.evaluate(() => {
    globalThis.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      invoke: async command => {
        if (command === 'plugin:opener|open_url') throw 'The system browser could not be opened';
      },
    };
  });
  await page.route('https://sync.epi.test/v1/google/start', route => route.fulfill({
    json: { url: 'https://accounts.google.com/o/oauth2/v2/auth', state: 'state', secret: 'secret' },
  }));
  await button.click();
  await notice.getByText('La connexion Google a échoué ou a été annulée.', { exact: true }).waitFor();
});

test('crée un compte avec Google et exige un mot de passe pour le délier', async t => {
  const page = await pageWith(t);
  const calls = [];
  const callback = 'https://accounts.google.com/o/oauth2/v2/auth?state=test';
  const details = { email: 'alice@example.org', googleLinked: true, hasPassword: false, googleAvailable: true };
  await page.context().route(callback, route => route.fulfill({ body: 'Google', contentType: 'text/html' }));
  await page.route('https://sync.epi.test/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    calls.push({ path, body, token: route.request().headers().authorization });
    const response = {
      '/v1/google/start': { url: callback, state: 'state', secret: 'secret' },
      '/v1/google/finish': calls.some(call => call.body?.action === 'unlink')
        ? { ...details, googleLinked: false, hasPassword: true }
        : { ...details, token: 'device-token' },
    };
    return route.fulfill({ json: response[path], headers: { 'Access-Control-Allow-Origin': '*' } });
  });

  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connexion' });
  assert.equal(await dialog.locator('button.primary').innerText(), 'Se connecter');
  await dialog.getByRole('button', { name: 'Créer un compte', exact: true }).click();
  await page.getByRole('button', { name: 'Créer le compte avec Google' }).click();
  const accountDialog = page.getByRole('dialog', { name: 'Compte' });
  await accountDialog.getByText(details.email).waitFor();
  assert.equal(await accountDialog.locator('button.primary:last-child').innerText(), 'Fermer');
  assert.equal(await accountDialog.locator('#account-switch').isVisible(), false);
  assert.equal(calls.find(call => call.path.endsWith('/start')).body.action, 'register');
  assert.equal(await page.locator('#account-google-fields').isVisible(), false);
  const unlink = page.getByRole('button', { name: 'Délier Google' });
  await unlink.waitFor();
  await unlink.locator('img').waitFor({ state: 'hidden' });
  await unlink.click();
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('secret-password');
  await unlink.click();
  await page.getByRole('alert').getByText('Les deux mots de passe doivent être identiques.').waitFor();
  await page.getByLabel('Nouveau mot de passe (confirmation)').fill('secret-password');
  await unlink.click();
  await page.getByRole('button', { name: 'Associer Google' }).locator('img').waitFor();
  const request = calls.find(call => call.body?.action === 'unlink');
  assert.equal(request.token, 'Bearer device-token');
  assert.equal(request.body.password, 'secret-password');
});

test('l’icône crée le premier profil, puis partage un bouton avec son nom', async t => {
  const page = await pageWith(t);
  const picker = page.getByRole('combobox', { name: 'Profil actif' });
  assert.equal(await picker.count(), 0);
  const profileIcon = await page.locator('#profile-icon').boundingBox();
  const themeToggle = await page.locator('#theme-toggle').boundingBox();
  assert.equal(themeToggle.x - (profileIcon.x + profileIcon.width), profileIcon.width);
  await page.locator('.toolbar').getByRole('button', { name: 'Créer un profil' }).click();
  const editor = page.locator('#editor-view');
  await editor.getByRole('heading', { name: 'Créer un profil', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  await editor.getByLabel('Nom', { exact: true }).fill('Alice');
  await editor.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await editor.getByLabel('Date de naissance', { exact: true }).fill('1994-01-15');
  await editor.getByLabel('Taille (cm)').fill('165');
  await page.locator('.toolbar').getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await picker.count(), 0);
  const profileButton = page.getByRole('button', { name: 'Modifier le profil Alice', exact: true });
  const frameColor = control => control.evaluate(node => getComputedStyle(node, '::before').borderTopColor);
  const transparent = 'rgba(0, 0, 0, 0)';
  for (const target of [profileButton.locator('svg'), profileButton.getByText('Alice', { exact: true })]) {
    await page.locator('#theme-toggle').hover();
    assert.equal(await frameColor(profileButton), transparent);
    await target.hover();
    assert.notEqual(await frameColor(profileButton), transparent);
    await target.click();
    await editor.getByRole('heading', { name: 'Modifier le profil', exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Nom', { exact: true }).inputValue(), 'Alice');
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('#editor-actions').getByRole('button', { name: 'Annuler', exact: true }).click();
  }

  const multiPage = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Alice' });
  const multiButton = multiPage.getByRole('button', { name: 'Ouvrir les profils' });
  const multiPicker = multiPage.getByRole('combobox', { name: 'Profil actif' });
  const buttonBox = await multiButton.boundingBox();
  const pickerBox = await multiPicker.boundingBox();
  assert.equal(buttonBox.width, 20);
  assert.equal(pickerBox.x - buttonBox.x - buttonBox.width, 10);
  await multiPicker.hover();
  assert.equal(await frameColor(multiButton), transparent);
  await multiButton.hover();
  assert.notEqual(await frameColor(multiButton), transparent);
});

test('archive actions switch to icons when their labels do not fit', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice' });
  const reload = page.locator('#reload-data');
  const download = page.getByRole('button', { name: 'Export ZIP' });
  const upload = page.getByRole('button', { name: 'Import ZIP' });
  await reload.evaluate(button => { button.hidden = false; });
  await reload.locator('svg').waitFor();
  await download.locator('span').waitFor();
  await upload.locator('span').waitFor();

  await page.setViewportSize({ width: 300, height: 800 });
  await download.locator('svg').waitFor();
  await upload.locator('svg').waitFor();
  assert.equal(await download.getAttribute('title'), 'Export ZIP');
  assert.equal(await upload.getAttribute('title'), 'Import ZIP');
  assert.equal((await reload.boundingBox()).y, (await download.boundingBox()).y);
  assert.equal((await reload.boundingBox()).y, (await upload.boundingBox()).y);

  const longerLabel = 'Télécharger une archive ZIP avec toutes les données';
  await download.locator('span').evaluate((label, text) => { label.textContent = text; }, longerLabel);
  await page.waitForFunction(text => document.querySelector('#export-data').title === text, longerLabel);

  await page.setViewportSize({ width: 1280, height: 800 });
  const translated = page.getByRole('button', { name: longerLabel });
  await translated.locator('span').waitFor();
  assert.equal(await translated.getAttribute('title'), null);
  await upload.locator('span').waitFor();
});

test('theme follows the browser until a profile saves a selection', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Alice' }, { colorScheme: 'dark' });
  const picker = page.getByRole('combobox', { name: 'Profil actif' });
  const light = page.getByRole('button', { name: 'Activer le mode clair' });
  const dark = page.getByRole('button', { name: 'Activer le mode sombre' });
  const scheme = () => page.locator('html').evaluate(root => getComputedStyle(root).colorScheme);

  await light.waitFor();
  assert.equal(await scheme(), 'dark');
  assert.equal(await light.locator('svg:visible').getAttribute('class'), 'theme-sun');
  await light.click();
  await dark.waitFor();
  assert.equal(await scheme(), 'light');
  assert.equal(await dark.locator('svg:visible').getAttribute('class'), 'theme-moon');

  await picker.selectOption('Bob');
  await light.waitFor();
  await page.emulateMedia({ colorScheme: 'light' });
  await dark.waitFor();
  await dark.click();
  await light.waitFor();

  await picker.selectOption('Alice');
  await dark.waitFor();
  await page.reload();
  await dark.waitFor();
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await scheme(), 'light');

  await picker.selectOption('Bob');
  await light.waitFor();
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await scheme(), 'dark');
});

const choosePage = (page, label) => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
async function chosenProfile(page) {
  const name = page.locator('#profile-name');
  return await name.isVisible() ? name.innerText() : page.getByRole('combobox', { name: 'Profil actif' }).inputValue();
}
const feed = (page, line) => page.evaluate(value => window.dispatchEvent(new CustomEvent('epi:frame', { detail: value })), line);

let webBuild;
function buildWeb() {
  webBuild ??= build({
    mode: 'web',
    build: { outDir: join(outDir, 'web') },
    logLevel: 'error',
    define: { __DEV_ACCOUNT_API__: JSON.stringify('https://sync.epi.test') },
  });
  return webBuild;
}

test('le mode web ouvre l’écran expliquant où écouter le Bluetooth', async t => {
  await buildWeb();
  const page = await pageWith(t, { profiles: [], devices: [], measurements: [], pending: [], notifications: [] }, {}, 'web');
  await page.getByRole('link', { name: 'Mode web', exact: true }).click();
  await page.getByRole('heading', { name: 'Écoute Bluetooth' }).waitFor();
  await page.getByText('L’écoute Bluetooth est disponible uniquement avec l’application ou la version standalone.').waitFor();
  assert.equal(await page.getByRole('region', { name: 'Trames Bluetooth reçues' }).count(), 0);
});

test('receives transactions on startup and acknowledges only the IDs returned by storage', { timeout: 15000 }, async t => {
  await buildWeb();
  const rows = Array.from({ length: 3 }, (_, index) => {
    const uuid = '00000000-0000-4000-8000-00000000000' + index;
    return { uuid, name: '2026-01-15T17-23-21.00000' + index + 'Z-' + uuid + '.json' };
  });
  const snapshot = { profiles: [], devices: [], measurements: [], pending: [], notifications: [] };
  const integrated = [];
  let acknowledge;
  let startedAccountCheck;
  let releaseAccount;
  const acknowledged = new Promise(resolve => { acknowledge = resolve; });
  const accountCheckStarted = new Promise(resolve => { startedAccountCheck = resolve; });
  const accountResponse = new Promise(resolve => { releaseAccount = resolve; });
  t.after(releaseAccount);
  const page = await pageWith(t, route => {
    const { action, args } = route.request().postDataJSON();
    if (action === 'pendingTransactions') return route.fulfill({ json: [] });
    if (action === 'integrateTransactions') {
      integrated.push(...args[0]);
      return route.fulfill({ json: { uuids: [rows[0].uuid, rows[2].uuid] } });
    }
    return route.fulfill({ json: snapshot });
  }, { viewport: { width: 375, height: 700 } }, 'web', async page => {
    await page.addInitScript(() => {
      localStorage.setItem('epi-account:https://sync.epi.test', JSON.stringify({
        email: 'alice@example.org', token: 'test-token',
      }));
    });
    await page.route('https://sync.epi.test/v1/account', async route => {
      assert.equal(route.request().headers().authorization, 'Bearer test-token');
      startedAccountCheck();
      await accountResponse;
      await route.fulfill({ json: { email: 'alice@example.org' } }).catch(() => {});
    });
    await page.route('https://sync.epi.test/v1/transactions/pending', async route => {
      await accountCheckStarted;
      await route.fulfill({ json: { transactions: [...rows].reverse(), next: null } });
    });
    await page.route('https://sync.epi.test/v1/transactions/acknowledge', async route => {
      acknowledge(route.request().postDataJSON());
      await route.fulfill({ json: { inserted: 2 } });
    });
  });
  assert.deepEqual(await acknowledged, { uuids: [rows[0].uuid, rows[2].uuid] });
  assert.deepEqual(integrated, rows);
  const button = page.getByRole('button', { name: 'Compte', exact: true });
  assert.ok(await button.locator('.account-disconnected').isVisible());
  releaseAccount();
  await button.locator('.account-connected').waitFor();
  assert.equal(await button.getAttribute('title'), 'Connecté au compte');
});

test('refreshes local data, rechecks the account, then retries upload before downloading', { timeout: 15000 }, async t => {
  await buildWeb();
  const uuid = '00000000-0000-4000-8000-000000000001';
  const incomingUuid = '00000000-0000-4000-8000-000000000002';
  const name = '2026-01-15T17-23-21.000000Z-' + uuid + '.json';
  const incoming = { name: '2026-01-15T17-24-21.000000Z-' + incomingUuid + '.json', uuid: incomingUuid };
  let pending = [{ name, transaction: { uuid } }];
  const snapshot = { profiles: [], devices: [], measurements: [], pending: [], notifications: [] };
  const steps = [];
  let refreshing = false;
  let rejectFirstUpload;
  const offline = new Promise(resolve => { rejectFirstUpload = resolve; });
  t.after(rejectFirstUpload);
  let signalFirstUpload;
  const firstUpload = new Promise(resolve => { signalFirstUpload = resolve; });
  let signalReload;
  const reloaded = new Promise(resolve => { signalReload = resolve; });
  let signalReceived;
  const received = new Promise(resolve => { signalReceived = resolve; });
  const page = await pageWith(t, route => {
    const { action, args } = route.request().postDataJSON();
    if (action === 'reload') {
      steps.push('reload');
      signalReload();
    }
    if (action === 'pendingTransactions') return route.fulfill({ json: pending });
    if (action === 'archiveTransactions') {
      steps.push(['archive', args[0]]);
      pending = pending.filter(row => !args[0].includes(row.name));
      return route.fulfill({ json: {} });
    }
    if (action === 'integrateTransactions') {
      steps.push(['integrate', args[0]]);
      return route.fulfill({ json: { uuids: [incomingUuid], state: snapshot } });
    }
    return route.fulfill({ json: snapshot });
  }, {}, 'web', async page => {
    await page.addInitScript(() => {
      localStorage.setItem('epi-account:https://sync.epi.test', JSON.stringify({
        email: 'alice@example.org', token: 'test-token',
      }));
    });
    await page.route('https://sync.epi.test/v1/account', route => {
      if (!refreshing) return route.abort('connectionrefused');
      steps.push('account');
      return route.fulfill({ json: { email: 'alice@example.org' } });
    });
    await page.route('https://sync.epi.test/v1/transactions', async route => {
      if (!refreshing) {
        signalFirstUpload();
        await offline;
        return route.abort('connectionrefused').catch(() => {});
      }
      steps.push(['upload', JSON.parse(route.request().postData())]);
      return route.fulfill({ json: { uuids: [uuid] } });
    });
    await page.route('https://sync.epi.test/v1/transactions/pending', route => {
      if (refreshing) steps.push('download');
      return route.fulfill({ json: { transactions: refreshing ? [incoming] : [] } });
    });
    await page.route('https://sync.epi.test/v1/transactions/acknowledge', async route => {
      steps.push(['acknowledge', route.request().postDataJSON()]);
      await route.fulfill({ json: { inserted: 1 } });
      signalReceived();
    });
  });

  await firstUpload;
  const account = page.locator('#account-button');
  await account.locator('.account-disconnected').waitFor();
  refreshing = true;
  await page.locator('#reload-data').click();
  await reloaded;
  rejectFirstUpload();
  await received;
  await account.locator('.account-connected').waitFor();
  assert.deepEqual(steps, [
    'reload', 'account', ['upload', { uuid, name }], ['archive', [name]], 'download',
    ['integrate', [incoming]], ['acknowledge', { uuids: [incomingUuid] }],
  ]);
  assert.deepEqual(pending, []);
});

test('rechecks the saved account from its button and every minute', async t => {
  let offline = true;
  let checks = 0;
  const page = await pageWith(t, undefined, {}, undefined, async page => {
    await page.clock.install();
    await page.addInitScript(() => {
      localStorage.setItem('epi-account:https://sync.epi.test', JSON.stringify({
        email: 'alice@example.org', token: 'test-token',
      }));
    });
    await page.route('https://sync.epi.test/v1/account', route => {
      checks++;
      return offline
        ? route.abort('connectionrefused')
        : route.fulfill({ json: { email: 'alice@example.org' } });
    });
  });
  await page.waitForFunction(() => document.querySelector('#account-button').title === 'Compte déconnecté');
  const button = page.getByRole('button', { name: 'Compte', exact: true });
  await button.click();
  const error = page.getByRole('alert').getByText('Le serveur de comptes est inaccessible.');
  await error.waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('epi-account:https://sync.epi.test')).token), 'test-token');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();

  offline = false;
  const beforeClick = checks;
  await button.click();
  await button.locator('.account-connected').waitFor();
  assert.equal(checks, beforeClick + 1);
  await error.waitFor({ state: 'hidden' });
  const dialog = page.getByRole('dialog', { name: 'Compte' });
  assert.equal(await dialog.locator('button.primary:last-child').innerText(), 'Fermer');
  assert.equal(await dialog.locator('#account-switch').isVisible(), false);
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();

  offline = true;
  const beforeTimer = checks;
  await page.clock.runFor(61_000);
  await button.locator('.account-disconnected').waitFor();
  assert.equal(checks, beforeTimer + 1);
  offline = false;
  await page.clock.runFor(60_000);
  await button.locator('.account-connected').waitFor();
  assert.equal(checks, beforeTimer + 2);
});

test('dismisses a modal only when the click starts and ends on its backdrop', async t => {
  const page = await pageWith(t);
  await page.locator('#account-button').click();
  const dialog = page.locator('#account-dialog');
  const { x, y } = await dialog.boundingBox();
  await page.mouse.click(x + 10, y + 10);
  assert.ok(await dialog.isVisible());

  await page.mouse.move(x + 10, y + 10);
  await page.mouse.down();
  await page.mouse.move(2, 2);
  await page.mouse.up();
  assert.ok(await dialog.isVisible());

  await page.mouse.click(2, 2);
  await dialog.waitFor({ state: 'hidden' });
});

test('opens the sign-in form when the saved token has expired', async t => {
  let checks = 0;
  const page = await pageWith(t, undefined, {}, undefined, async page => {
    await page.clock.install();
    await page.addInitScript(() => {
      localStorage.setItem('epi-account:https://sync.epi.test', JSON.stringify({
        email: 'alice@example.org', token: 'expired-token',
      }));
    });
    await page.route('https://sync.epi.test/v1/account', route => {
      checks++;
      return route.fulfill({ status: 401, json: { error: 'token_expired' } });
    });
  });
  await page.waitForFunction(() => localStorage.getItem('epi-account:https://sync.epi.test') === null);
  const button = page.getByRole('button', { name: 'Compte', exact: true });
  assert.ok(await button.locator('.account-disconnected').isVisible());
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Connexion' });
  await dialog.getByText('Ta session a expiré. Reconnecte-toi.').waitFor();
  assert.equal(await dialog.locator('button:last-child').innerText(), 'Fermer');
  assert.equal(await dialog.locator('button.primary').innerText(), 'Se connecter');
  assert.ok(await dialog.getByRole('button', { name: 'Créer un compte', exact: true }).isVisible());
  await page.clock.runFor(60_000);
  assert.equal(checks, 1);
});

test('counts down to automatic sync and can retry immediately', async t => {
  await buildWeb();
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  let pending = ids.map(uuid => ({
    name: '2026-01-15T17-23-21.000000Z-' + uuid + '.json',
    transaction: { uuid, type: 'create', data: {} },
  }));
  const archived = [];
  const uploads = [];
  let releaseFirst;
  let releaseManual;
  let signalUpload;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const manualResponse = new Promise(resolve => { releaseManual = resolve; });
  const firstUpload = new Promise(resolve => { signalUpload = resolve; });
  t.after(releaseFirst);
  t.after(releaseManual);
  const snapshot = { profiles: [], devices: [], measurements: [], pending: [], notifications: [] };
  const page = await pageWith(t, route => {
    const { action, args } = route.request().postDataJSON();
    if (action === 'pendingTransactions') return route.fulfill({ json: pending });
    if (action === 'archiveTransactions') {
      archived.push(...args[0]);
      pending = pending.filter(row => !args[0].includes(row.name));
      return route.fulfill({ json: {} });
    }
    if (action === 'setTheme') {
      const uuid = '00000000-0000-4000-8000-000000000003';
      pending.push({ name: '2026-01-15T17-24-21.000000Z-' + uuid + '.json', transaction: { uuid } });
      return route.fulfill({ json: snapshot, headers: { 'X-Epi-Transactions': 'pending' } });
    }
    return route.fulfill({ json: snapshot });
  }, { timezoneId: 'Europe/Paris' }, 'web', async page => {
    await page.clock.install({ time: new Date('2026-01-15T17:30:00Z') });
    await page.clock.pauseAt(new Date('2026-01-15T17:30:05Z'));
    await page.addInitScript(() => {
      localStorage.setItem('epi-account:https://sync.epi.test', JSON.stringify({
        email: 'alice@example.org', token: 'test-token',
      }));
    });
    await page.route('https://sync.epi.test/v1/account', route => route.fulfill({ json: { email: 'alice@example.org' } }));
    await page.route('https://sync.epi.test/v1/transactions/pending', route => route.fulfill({ json: { transactions: [] } }));
    await page.route('https://sync.epi.test/v1/transactions', async route => {
      uploads.push(route.request().postData().trim().split('\n').map(line => JSON.parse(line).uuid));
      if (uploads.length === 1) {
        signalUpload();
        await firstResponse;
        return route.abort().catch(() => {});
      }
      if (uploads.length === 3) {
        await manualResponse;
        return route.fulfill({ json: { uuids: [] } });
      }
      return route.fulfill({ json: { uuids: uploads.length === 2 ? [ids[0]] : uploads.at(-1) } });
    });
  });

  const icon = page.locator('#sync-status');
  await firstUpload;
  assert.equal(await icon.isVisible(), false);
  await page.clock.runFor(5_000);
  await icon.waitFor();
  assert.match(await icon.getAttribute('class'), /syncing/);
  await icon.click();
  const dialog = page.getByRole('dialog', { name: 'Données en attente de synchronisation' });
  const syncNow = dialog.getByRole('button', { name: 'Synchroniser maintenant' });
  const countdown = dialog.locator('#sync-countdown');
  await dialog.getByText(/15 janv\. 2026.*18:23/).waitFor();
  assert.equal(await countdown.textContent(), 'Synchronisation en cours…');
  assert.equal(await syncNow.isDisabled(), true);
  await page.clock.runFor(15_000);
  assert.equal(await icon.isVisible(), true);
  assert.doesNotMatch(await icon.getAttribute('class'), /syncing/);
  assert.deepEqual(archived, []);
  assert.deepEqual(uploads, [ids]);
  releaseFirst();
  await dialog.getByText('Prochaine synchronisation automatique dans 0:40').waitFor();
  await page.clock.runFor(1_000);
  assert.equal(await countdown.textContent(), 'Prochaine synchronisation automatique dans 0:39');

  const archiveRequest = () => page.waitForResponse(response => response.url().endsWith('/api/session') &&
    response.request().postDataJSON().action === 'archiveTransactions');
  await Promise.all([archiveRequest(), page.clock.runFor(39_000)]);
  assert.deepEqual(uploads, [ids, ids]);
  assert.equal(archived.length, 1);
  assert.ok(archived[0].endsWith(ids[0] + '.json'));
  assert.equal(await icon.isVisible(), true);

  await dialog.getByText('Prochaine synchronisation automatique dans 1:00').waitFor();
  await page.clock.runFor(12_000);
  assert.equal(await countdown.textContent(), 'Prochaine synchronisation automatique dans 0:48');
  const manualUpload = page.waitForRequest('https://sync.epi.test/v1/transactions');
  await syncNow.click();
  const manualRequest = await manualUpload;
  assert.deepEqual(manualRequest.postData().trim().split('\n').map(line => JSON.parse(line).uuid), [ids[1]]);
  assert.equal(await countdown.textContent(), 'Synchronisation en cours…');
  assert.equal(await syncNow.isDisabled(), true);
  releaseManual();
  await dialog.getByText('Prochaine synchronisation automatique dans 0:48').waitFor();

  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await Promise.all([archiveRequest(), page.locator('#theme-toggle').click()]);
  await icon.waitFor({ state: 'hidden' });
  assert.deepEqual(uploads, [ids, ids, [ids[1]], [ids[1], '00000000-0000-4000-8000-000000000003']]);
});

test('l’écoute Bluetooth conserve les trames récentes et purge celles de plus de 24 heures', async t => {
  const page = await pageWith(t);
  const logKey = 'epi-bluetooth-log-v1';
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify([
      { at: Date.now() - 25 * 60 * 60 * 1000, address: 'AA:BB:CC:DD:EE:FF', text: 'Trame expirée' },
      { at: Date.now() - 23 * 60 * 60 * 1000, address: 'AA:BB:CC:DD:EE:FF', text: 'Trame récente' },
    ]));
  }, logKey);
  await page.getByRole('link', { name: 'Mode simulation' }).click();
  const log = page.getByRole('region', { name: 'Trames Bluetooth reçues' });
  await log.getByText('Trame récente').waitFor();
  assert.equal(await log.getByText('Trame expirée').count(), 0);
  const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), logKey);
  assert.deepEqual((await stored()).map(row => row.text), ['Trame récente']);
  await feed(page, 'PAYLOAD AABBCCDDEEFF -58 Service 180F 1 7F ');
  await log.getByText(/1 octet reçu/).waitFor();
  await page.reload();
  await log.getByText(/1 octet reçu/).waitFor();
  assert.equal((await stored()).length, 2);
});

test('l’écoute Bluetooth filtre, décode et suit les trames jusqu’à une pesée stable', async t => {
  const page = await pageWith(t, { devices: [device], addressFilter: address }, { locale: 'fr-FR' });
  await page.getByRole('link', { name: 'Mode simulation' }).click();
  await page.getByRole('heading', { name: 'Écoute Bluetooth' }).waitFor();
  await page.getByText(`Écoute limitée à Salle de bain (${address}).`, { exact: true }).waitFor();
  const log = page.getByRole('region', { name: 'Trames Bluetooth reçues' });
  const payload = (id, data = 'DEAD', length = data.length / 2) => `PAYLOAD AABBCCDDEEFF -58 Manufacturer ${id} ${length} ${data} `;
  await feed(page, payload('0157', '412020420A7F80FF'));
  const shortFrame = log.getByText(/^\[\d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}:\d{2}\].*Anhui Huami.*8 octets reçus/);
  assert.match(await shortFrame.innerText(), /8 octets reçus\n41 20 20 42 0A 7F 80 FF\nA  B····$/);
  await feed(page, payload('FFFF', '41'.repeat(120)));
  const longFrame = log.getByText(/Fabricant 0xFFFF · -58 dBm · 120 octets reçus/);
  assert.deepEqual((await longFrame.innerText()).split('\n').slice(1), [
    Array(120).fill('41').join(' '), 'A'.repeat(120),
  ]);
  assert.deepEqual(await log.locator('.bluetooth-id-unknown').allTextContents(), ['0xFFFF']);
  assert.deepEqual(await log.locator('.bluetooth-id-known').allTextContents(), ['0x0157']);
  await feed(page, frame.replace('0226', '0206'));
  await feed(page, metadata);
  await feed(page, frame.replace('0226', '0206'));
  const decodedFrame = log.getByText(/XMTZC05HM.*13 octets reçus.*70,9 kg.*Poids instable/);
  await decodedFrame.waitFor();
  assert.deepEqual(await decodedFrame.locator('.bluetooth-decoded').allTextContents(), ['70,9 kg', '489 Ω']);
  await feed(page, frame.replace('AABBCCDDEEFF', '000000000001'));

  const atBottom = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop <= 1);
  for (let index = 0; index < 30; index++) await feed(page, payload('FFFE'));
  await log.locator('div').nth(33).waitFor();
  assert.equal(await atBottom(), true);
  assert.equal(await log.getByText('00:00:00:00:00:01', { exact: false }).count(), 0);

  await log.evaluate(el => { el.scrollTop = 0; });
  await feed(page, payload('FFFD'));
  await log.getByText(/0xFFFD/).waitFor();
  assert.equal(await log.evaluate(el => el.scrollTop), 0);
  await log.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await feed(page, payload('FFFC'));
  await log.getByText(/0xFFFC/).waitFor();
  assert.equal(await atBottom(), true);

  await feed(page, frame);
  await page.waitForURL('**/#measurements');
  await page.getByRole('button', { name: 'Attribuer la pesée' }).waitFor();
});

test('l’écoute Bluetooth identifie le fabricant par préfixe MAC lorsque le code est inconnu', async t => {
  const page = await pageWith(t);
  await page.getByRole('link', { name: 'Mode simulation' }).click();
  const log = page.getByRole('region', { name: 'Trames Bluetooth reçues' });
  await log.waitFor();
  await feed(page, 'PAYLOAD D4278722D707 -91 Manufacturer 3030 1 30 QVBfMzQxODczMTY0NA==');
  const inferred = log.getByText(/AP_3418731644 · Shanghai High-Flying Electronics Technology Co\., Ltd \(0x3030\) · -91 dBm · 1 octet reçu/);
  assert.match(await inferred.innerText(), /1 octet reçu\n30\n0$/);
  await feed(page, 'PAYLOAD D4278722D707 -91 Manufacturer 0157 1 30 ');
  await log.getByText(/Anhui Huami.* \(0x0157\)/).waitFor();
  const known = log.locator('.bluetooth-id-known');
  const unknown = log.locator('.bluetooth-id-unknown');
  assert.deepEqual(await known.allTextContents(), ['D4:27:87', '0x0157']);
  assert.deepEqual(await unknown.allTextContents(), []);

  await feed(page, 'PAYLOAD FCFFFF000001 -58 Manufacturer 0157 1 30 ');
  await feed(page, 'PAYLOAD FCFFFF000001 -58 Service 180F 1 7F ');
  await feed(page, 'PAYLOAD FCFFFF000001 -58 Announcement 12345678-0000-1234-0000-123456789abc 0  ');
  await log.getByText(/12345678-0000-1234-0000-123456789abc/).waitFor();
  assert.deepEqual(await known.allTextContents(), ['D4:27:87', '0x0157', '0x0157', '0x180F']);
  assert.deepEqual(await unknown.allTextContents(), ['12345678-0000-1234-0000-123456789abc']);
  await feed(page, 'PAYLOAD FCFFFF000001 -58 Manufacturer 3030 1 30 ');
  await log.getByText(/Fabricant 0x3030/).waitFor();
  const unresolved = ['12345678-0000-1234-0000-123456789abc', 'FC:FF:FF', '0x3030'];
  assert.deepEqual(await unknown.allTextContents(), unresolved);
  await page.reload();
  await unknown.last().waitFor();
  assert.deepEqual(await unknown.allTextContents(), unresolved);
});

test('the Bluetooth log fills the main view down to its bottom padding', async t => {
  const page = await pageWith(t, undefined, { viewport: { width: 1200, height: 1000 } });
  await page.getByRole('link', { name: 'Mode simulation' }).click();
  const log = page.locator('#bluetooth-log');
  await log.waitFor();

  const bottomGap = () => log.evaluate(node => {
    const scroll = node.closest('#view-scroll');
    const gap = scroll.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom;
    const padding = parseFloat(getComputedStyle(scroll).paddingBottom);
    return gap - padding;
  });
  assert.ok(Math.abs(await bottomGap()) < 1);
  await page.setViewportSize({ width: 390, height: 480 });
  assert.ok(Math.abs(await bottomGap()) < 1);
});

test('central views use the same spacing above and below the header', async t => {
  const page = await pageWith(t, {
    profiles: [alice], devices: [device], selectedProfile: 'Alice', measurements: [record],
  });

  await page.getByText('Données', { exact: true }).click();
  await page.getByLabel('Masse grasse (%)', { exact: true }).check();

  const gaps = selector => page.locator('#view').evaluate((view, selector) => {
    const header = view.querySelector('.page-header');
    const control = (selector ? header.querySelector(selector) : header).getBoundingClientRect();
    const top = document.querySelector('.toolbar').getBoundingClientRect().bottom;
    const content = view.querySelector('#view-content').getBoundingClientRect().top;
    return [control.top - top, content - control.bottom];
  }, selector);

  const [aboveSave, belowSave] = await gaps('[data-action="save-view-preset"]');
  assert.equal(aboveSave, belowSave);
  assert.deepEqual(await gaps(null), [12, 12]);
  await page.getByRole('cell', { name: '70 kg', exact: true }).click();
  assert.deepEqual(await gaps(null), [12, 12]);
  await choosePage(page, 'Profils');
  assert.deepEqual(await gaps(null), [12, 12]);
  await choosePage(page, 'Appareils');
  assert.deepEqual(await gaps(null), [12, 12]);
  await page.locator('details[data-expand="raw"]').waitFor();
  const outerSpacing = await page.locator('#view-scroll').evaluate(scroll => {
    const raw = scroll.querySelector('details[data-expand="raw"]');
    const content = scroll.querySelector('#view-content');
    const style = getComputedStyle(scroll);
    return {
      left: style.paddingLeft,
      right: style.paddingRight,
      bottom: parseFloat(style.paddingBottom) + content.getBoundingClientRect().bottom - raw.getBoundingClientRect().bottom,
    };
  });
  assert.equal(outerSpacing.left, outerSpacing.right);
  assert.ok(Math.abs(outerSpacing.bottom - parseFloat(outerSpacing.left)) < 0.1);
});

test('les configurations de vue sont partagées et leur sélection persiste par profil', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Alice', measurements: [record] });
  const profile = page.getByRole('combobox', { name: 'Profil actif' });
  const title = page.locator('.view-preset-title h1');
  const picker = page.locator('.view-preset-picker summary');
  const chevron = page.locator('.view-preset-chevron');
  const dialog = page.getByRole('dialog');
  const options = page.getByRole('list', { name: 'Configurations de vue' });
  const saveButton = page.getByRole('button', { name: 'Sauvegarder la configuration' });
  const save = async name => {
    await saveButton.click();
    const saveDialog = page.getByRole('dialog', { name: 'Sauvegarder la configuration' });
    assert.equal(await saveDialog.evaluate(element => element.matches(':modal')), true);
    if (name) await saveDialog.getByLabel('Nom').fill(name);
    await saveDialog.getByRole('button', { name: 'Sauvegarder', exact: true }).click();
    await saveDialog.waitFor({ state: 'hidden' });
  };
  await page.getByText('Données', { exact: true }).click();
  const fat = page.getByLabel('Masse grasse (%)', { exact: true });
  const rename = page.getByRole('button', { name: 'Renommer la configuration' });
  assert.equal(await picker.count(), 0);
  const remove = page.getByRole('button', { name: 'Supprimer la configuration' });
  assert.equal(await rename.count(), 0);
  assert.equal(await remove.count(), 0);
  assert.equal(await saveButton.count(), 0);
  await fat.check();
  assert.equal(await saveButton.isVisible(), true);
  assert.equal((await title.textContent()).trim(), 'Pesées *');
  assert.equal(await chevron.count(), 0);
  assert.equal(await rename.isEnabled(), true);
  assert.equal(await remove.count(), 0);
  await title.click();
  const reload = options.getByRole('button', { name: 'Pesées', exact: true });
  assert.equal(await reload.locator('svg').count(), 1);
  await reload.click();
  assert.equal(await fat.isChecked(), false);
  assert.equal(await saveButton.count(), 0);
  const weightHeader = page.getByRole('columnheader', { name: 'Poids', exact: true });
  const dateHeader = page.getByRole('columnheader', { name: 'Date', exact: true });
  await weightHeader.dragTo(dateHeader);
  assert.equal((await title.textContent()).trim(), 'Pesées *');
  await weightHeader.dragTo(dateHeader);
  assert.equal((await title.textContent()).trim(), 'Pesées');
  assert.equal(await picker.count(), 0);
  assert.equal(await rename.count(), 0);
  assert.equal(await remove.count(), 0);
  assert.equal(await saveButton.count(), 0);

  await fat.check();
  await page.getByRole('button', { name: 'Éclater Masse grasse (%)' }).click();
  await rename.click();
  await dialog.getByRole('heading', { name: 'Créer une configuration' }).waitFor();
  const configurationName = dialog.getByLabel('Nom');
  assert.equal(await configurationName.evaluate(input => input === document.activeElement), true);
  await configurationName.fill('Composition');
  await dialog.getByRole('button', { name: 'Sauvegarder', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await chevron.count(), 1);
  assert.equal(await saveButton.count(), 0);
  const { width, height } = await remove.boundingBox();
  await title.click();
  const option = await options.getByRole('button', { name: 'Pesées', exact: true }).boundingBox();
  assert.equal(width, height);
  assert.equal(height, option.height);
  assert.deepEqual(await options.getByRole('button').allTextContents(), ['Pesées']);
  await title.click();

  await profile.selectOption('Bob');
  await title.click();
  await options.getByRole('button', { name: 'Composition', exact: true }).click();
  assert.equal(await fat.isChecked(), true);
  await page.getByRole('button', { name: 'Renommer la configuration' }).click();
  assert.equal(await dialog.getByLabel('Nom').inputValue(), 'Composition');
  await dialog.getByLabel('Nom').fill('Compact');
  await dialog.getByRole('button', { name: 'Renommer', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await profile.selectOption('Alice');
  await page.reload();
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  assert.equal((await title.textContent()).trim(), 'Compact');

  await page.getByText('Données', { exact: true }).click();
  await fat.uncheck();
  assert.equal((await title.textContent()).trim(), 'Compact *');
  await title.click();
  assert.deepEqual(await options.getByRole('button').allTextContents(), ['Pesées', 'Compact']);
  await options.getByRole('button', { name: 'Pesées', exact: true }).click();
  await title.click();
  const modifiedCompact = options.getByRole('button', { name: 'Compact *', exact: true });
  const reloadCompact = options.getByRole('button', { name: 'Recharger Compact', exact: true });
  assert.equal(await reloadCompact.isVisible(), true);
  await modifiedCompact.click();
  assert.equal(await title.textContent(), 'Compact *');
  assert.equal(await fat.isChecked(), false);
  await title.click();
  assert.equal(await reloadCompact.count(), 0);
  await options.getByRole('button', { name: 'Compact', exact: true }).click();
  assert.equal(await fat.isChecked(), true);

  await fat.uncheck();
  await title.click();
  await options.getByRole('button', { name: 'Pesées', exact: true }).click();
  await title.click();
  await reloadCompact.click();
  assert.equal(await title.textContent(), 'Compact');
  assert.equal(await fat.isChecked(), true);
  await fat.uncheck();
  await save();
  assert.equal(await saveButton.count(), 0);
  await profile.selectOption('Bob');
  assert.equal(await fat.isChecked(), false);
  await profile.selectOption('Alice');

  await page.getByRole('cell', { name: '70 kg', exact: true }).click();
  assert.equal((await title.textContent()).trim(), 'Détails de la pesée');
  assert.equal(await saveButton.count(), 0);
  const sections = page.locator('[data-detail-section] > summary');
  await sections.last().dragTo(sections.first());
  assert.equal((await title.textContent()).trim(), 'Détails de la pesée *');
  await save('Compact');
  await title.click();
  await options.getByRole('button', { name: 'Détails de la pesée', exact: true }).click();
  assert.equal((await title.textContent()).trim(), 'Détails de la pesée');
  await title.click();
  await options.getByRole('button', { name: 'Compact', exact: true }).click();
  const deviceSection = sections.filter({ hasText: 'Fiche de la balance à la pesée' });
  assert.equal(await sections.first().textContent(), 'Fiche de la balance à la pesée');
  await deviceSection.dragTo(sections.last());
  assert.equal((await title.textContent()).trim(), 'Compact *');
  await deviceSection.dragTo(sections.first());
  assert.equal((await title.textContent()).trim(), 'Compact');
  assert.equal(await chevron.count(), 1);
  assert.equal(await rename.isVisible(), true);
  assert.equal(await remove.isVisible(), true);
  assert.equal(await saveButton.count(), 0);
  await title.click();
  assert.deepEqual(await options.getByRole('button').allTextContents(), ['Détails de la pesée']);
  await title.click();
  await page.getByRole('button', { name: 'Supprimer la configuration' }).click();
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await title.textContent()).trim(), 'Détails de la pesée');
  await page.locator('#back-to-measurements').click();
  assert.equal((await title.textContent()).trim(), 'Compact');
});

test('sélection et mise à jour du profil, persistance des colonnes et comparaison des méthodes', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Bob', devices: [device], measurements: [record] });
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByRole('columnheader', { name: 'Date', exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Poids', exact: true }).waitFor();
  await table.getByText('70 kg', { exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'IMC (kg/m²)', exact: true }).waitFor();
  assert.equal(await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).count(), 0);
  await page.getByText('Données', { exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Filtrer' });
  await page.locator('.column-search:focus').waitFor();
  const options = page.locator('[data-column-option]:visible');
  const labels = await options.evaluateAll(nodes => nodes.map(node => node.dataset.columnOption));
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, 'fr')));
  const positions = await options.evaluateAll(nodes => nodes.map(node => {
    const { x, y } = node.getBoundingClientRect();
    return [x, y];
  }));
  assert.ok(positions.some(([x]) => x > positions[0][0]));
  assert.ok(positions.slice(1).every(([x, y], i) => x > positions[i][0] || (x === positions[i][0] && y > positions[i][1])));
  await search.fill('GRASSE masse, impéd');
  assert.deepEqual(await options.evaluateAll(nodes => nodes.map(node => node.dataset.columnOption)),
    labels.filter(label => /impédance|masse grasse/i.test(label)));
  await page.getByLabel('Impédance (Ω)', { exact: true }).check();
  await search.fill('% GRASSE masse');
  assert.equal(await options.count(), 1);
  await page.getByLabel('Masse grasse (%)', { exact: true }).check();
  await table.getByText('32,5', { exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).waitFor();
  await table.getByRole('button', { name: 'Masse grasse (%)', exact: true }).click();
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();
  assert.deepEqual(await table.locator('thead tr').nth(1).locator('th').allTextContents(), ['Moyenne', '● Mi', '⬣ Deu']);
  assert.equal(await table.getByText('32,5', { exact: true }).count(), 1);
  await table.getByRole('columnheader', { name: 'Mi', exact: true })
    .dragTo(table.getByRole('columnheader', { name: 'Poids', exact: true }));
  const columnOrder = () => table.locator('thead tr').first().locator('th').evaluateAll(headers =>
    headers.map(header => header.dataset.dragColumn));
  assert.deepEqual(await columnOrder(), ['date', 'fatPercent', 'weight', 'impedanceOhms', 'bmi']);
  await table.getByRole('columnheader', { name: 'Deu', exact: true }).waitFor();
  await table.getByText('31,8').waitFor();
  await page.getByRole('button', { name: 'Rassembler Masse grasse (%)', exact: true }).click();
  await table.getByText('32,5', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Éclater Masse grasse (%)', exact: true }).click();
  await search.fill('');
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Bob');
  assert.equal(await page.getByLabel('Impédance (Ω)', { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel('Masse grasse (%)', { exact: true }).isChecked(), false);
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
  assert.equal(await page.getByLabel('Impédance (Ω)', { exact: true }).isChecked(), true);
  await page.getByLabel('Impédance (Ω)', { exact: true }).uncheck();
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();
  assert.equal(await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).count(), 0);
  await page.setViewportSize({ width: 1800, height: 900 });
  const viewLayout = () => page.locator('#view').evaluate(view => {
    const { left, right } = view.getBoundingClientRect();
    const titleTop = view.querySelector('h1').getBoundingClientRect().top;
    const toolbarBottom = document.querySelector('.toolbar').getBoundingClientRect().bottom;
    return { left, right, titleGap: titleTop - toolbarBottom };
  });
  const listLayout = await viewLayout();
  await table.getByRole('cell', { name: '70 kg', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const detail = page.getByRole('region', { name: 'Détails de la pesée' });
  const comparison = detail.getByRole('table', { name: 'Comparaison des méthodes' });
  assert.equal(await dialog.count(), 0);
  assert.equal(await table.count(), 0);
  assert.deepEqual(await viewLayout(), listLayout);
  assert.equal(await comparison.getByRole('columnheader').nth(1).textContent(), 'Moyenne');
  const source = 'https://doi.org/10.1079/bjn19910073';
  await page.context().route(source, route => route.fulfill({ body: 'Publication Deurenberg' }));
  await detail.getByText('Méthodes de calcul', { exact: true }).click();
  const popupReady = page.waitForEvent('popup');
  await detail.getByRole('link', { name: /Deurenberg et al\. \(1991\)/ }).click();
  const popup = await popupReady;
  await popup.waitForURL(source);
  await popup.getByText('Publication Deurenberg').waitFor();
  await popup.close();
  const methodHeaders = comparison.locator('th[data-drag-column]');
  await methodHeaders.filter({ hasText: 'Deu' }).getByRole('link').dragTo(methodHeaders.filter({ hasText: 'IMC' }));
  assert.deepEqual(await methodHeaders.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  const deuHeader = methodHeaders.filter({ hasText: 'Deu' });
  const padding = { x: 3, y: 3 };
  assert.equal(await deuHeader.evaluate((header, { x, y }) => {
    const box = header.getBoundingClientRect();
    return document.elementFromPoint(box.left + x, box.top + y) === header;
  }, padding), true);
  await deuHeader.dragTo(methodHeaders.filter({ hasText: 'IMC' }), { sourcePosition: padding });
  assert.deepEqual(await methodHeaders.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['IMC', 'Deu', 'Mi']);
  await deuHeader.getByRole('link').dragTo(methodHeaders.filter({ hasText: 'IMC' }));
  await page.locator('#notices [role="alert"]').waitFor({ state: 'hidden' });
  const legend = detail.locator('.legend a');
  assert.match(await legend.first().textContent(), /Deu/);
  const sectionHeaders = detail.locator('[data-detail-section] > summary');
  const sectionOrder = () => sectionHeaders.evaluateAll(nodes => nodes.map(node => node.parentElement.dataset.detailSection));
  await sectionHeaders.filter({ hasText: 'Fiche de la balance à la pesée' })
    .dragTo(sectionHeaders.filter({ hasText: 'Méthodes de calcul' }));
  assert.deepEqual(await sectionOrder(), ['device', 'methods', 'measures', 'profile']);
  assert.equal(await legend.first().isVisible(), true);
  const fatRow = comparison.getByRole('row').filter({ hasText: 'Masse grasse (%)' });
  assert.equal(await fatRow.getByRole('cell').first().textContent(), '32,5');
  const toolbar = page.locator('.toolbar');
  assert.equal(await toolbar.getByRole('button', { name: 'Export ZIP' }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: 'Import ZIP' }).count(), 0);
  await toolbar.getByRole('button', { name: 'Retour' }).click();
  assert.equal(await table.getByRole('button', { name: /^Voir la pesée du/ }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await toolbar.locator('#data-actions button:visible').allTextContents(), ['Export ZIP', 'Import ZIP']);
  assert.equal(await detail.count(), 0);
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();

  await choosePage(page, 'Profils');
  await page.getByRole('article').filter({ hasText: 'Alice' }).getByRole('button', { name: 'Modifier' }).click();
  const editor = page.locator('#editor-view');
  await editor.getByRole('textbox', { name: 'Nom', exact: true }).fill('Alicia');
  await editor.getByLabel('Taille (cm)').fill('168');
  await page.locator('.toolbar').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText(/168 cm/).waitFor();
  await page.reload();
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alicia');
  await choosePage(page, 'Mesures');
  await table.getByRole('columnheader', { name: 'Masse grasse (%)', exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Deu', exact: true }).waitFor();
  await table.getByRole('button', { name: /^Voir la pesée du/ }).click();
  assert.deepEqual(await methodHeaders.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  assert.deepEqual(await sectionOrder(), ['device', 'methods', 'measures', 'profile']);
  await page.getByRole('button', { name: 'Retour' }).click();
  assert.deepEqual(await columnOrder(), ['date', 'fatPercent', 'weight', 'bmi']);
  assert.equal(await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).count(), 0);
});

test('l’axe IMC garde trois bandes au minimum et affiche les voisines proches', () => {
  const bands = values => {
    const rows = values.map((bmi, index) => ({ bmi, receivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }));
    const html = measurementCharts(rows, [{ id: 'bmi', label: 'IMC', read: row => row.bmi }], {
      mode: 'raw', statuses: { bmi: 'bold' },
    });
    return [...html.matchAll(/class="chart-bmi-band"[^>]+fill="([^"]+)"/g)].map(match => match[1]);
  };
  const [red, orange, yellow, green, purple] = ['#d54848', '#e67e32', '#e5b72c', '#44a66b', '#9b61cb'];
  assert.deepEqual(bands([20, 23]), [yellow, green, yellow]);
  assert.deepEqual(bands([20, 25.1]), [yellow, green, yellow]);
  assert.deepEqual(bands([22, 27]), [green, yellow, orange]);
  assert.deepEqual(bands([19, 28]), [yellow, green, yellow, orange]);
  assert.deepEqual(bands([21.75, 27.5]), [green, yellow, orange]);
  assert.deepEqual(bands([12]), [red, orange, yellow]);
  assert.deepEqual(bands([51]), [orange, red, purple]);
  assert.deepEqual(bands([12, 51]), [red, orange, yellow, green, yellow, orange, red, purple]);
});

test('le graphique s’adapte à la hauteur et conserve la marge sous les en-têtes', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [record] }, {
    viewport: { width: 1100, height: 330 },
  });
  const scroll = page.locator('#view-scroll');
  const chart = page.locator('.measurement-chart');
  await page.getByRole('button', { name: 'Graphique', exact: true }).click();
  await chart.waitFor();
  const layout = () => scroll.evaluate(view => {
    const { paddingTop, paddingBottom } = getComputedStyle(view);
    const chart = view.querySelector('.measurement-chart').getBoundingClientRect();
    return {
      height: Math.round(chart.height),
      bottomGap: view.getBoundingClientRect().bottom - chart.bottom,
      paddingBottom: parseFloat(paddingBottom),
      unscrolledTop: chart.top + view.scrollTop,
      available: view.clientHeight - parseFloat(paddingTop) - parseFloat(paddingBottom),
      top: view.scrollTop,
      remaining: view.scrollHeight - view.clientHeight - view.scrollTop,
      headerBottom: view.querySelector('.measurement-settings').getBoundingClientRect().bottom,
      viewTop: view.getBoundingClientRect().top,
    };
  });
  const short = await layout();
  assert.equal(short.height, short.available);
  assert.ok(short.top > 0 && Math.abs(short.remaining) <= 1);
  assert.ok(short.headerBottom <= short.viewTop);
  const shortPlot = (await chart.locator('.chart-plot').boundingBox()).height;

  await page.setViewportSize({ width: 1100, height: 500 });
  await page.waitForFunction(() => document.querySelector('.measurement-chart').offsetHeight === 384);
  const middle = await layout();
  assert.ok(middle.height < middle.available);

  await page.setViewportSize({ width: 1100, height: Math.ceil(middle.unscrolledTop + middle.height + middle.paddingBottom) });
  await page.waitForFunction(() => {
    const view = document.querySelector('#view-scroll');
    return view.scrollHeight === view.clientHeight;
  });
  const threshold = await layout();
  assert.equal(threshold.top, 0);
  assert.ok(Math.abs(threshold.bottomGap - threshold.paddingBottom) <= 1);

  await page.setViewportSize({ width: 360, height: 1000 });
  await page.waitForFunction(() => {
    const view = document.querySelector('#view-scroll');
    const chart = view.querySelector('.measurement-chart');
    const gap = view.getBoundingClientRect().bottom - chart.getBoundingClientRect().bottom;
    return Math.abs(gap - parseFloat(getComputedStyle(view).paddingBottom)) <= 1;
  });
  const tall = await layout();
  assert.equal(tall.top, 0);
  assert.equal(tall.remaining, 0);
  assert.ok(tall.height > threshold.height);
  assert.ok((await chart.locator('.chart-plot').boundingBox()).height > shortPlot);

  await scroll.evaluate(view => { view.scrollTop = 0; });
  const table = page.getByRole('button', { name: 'Tableau', exact: true });
  assert.ok(await table.evaluate(button => {
    return button.getBoundingClientRect().top < button.closest('#view-scroll').getBoundingClientRect().bottom;
  }));
  await table.click();
  await chart.waitFor({ state: 'detached' });
});

test('les commandes du graphique restent groupées et s’alignent à gauche sous le titre', async t => {
  const page = await pageWith(t, {
    profiles: [alice], selectedProfile: 'Alice',
    profilePreferences: { Alice: { chartByView: { default: {
      options: { display: 'table', mode: 'smooth', period: 'all' },
      lastRange: [Date.parse('2025-12-18T00:00:00+01:00'), Date.parse('2026-01-22T23:59:59+01:00')],
    } } } },
    measurements: [record, { ...record, receivedAt: '2026-01-22T17:23:21Z' }],
  }, { viewport: { width: 1100, height: 900 } });
  await page.getByRole('button', { name: 'Graphique', exact: true }).click();
  const chart = page.locator('.measurement-chart');
  const layout = () => chart.evaluate(element => {
    const heading = element.querySelector('.chart-heading');
    const toolbar = heading.querySelector('.chart-controls');
    const [mode, periods, fullscreen] = [...toolbar.children].map(child => child.getBoundingClientRect());
    const controls = [...toolbar.querySelectorAll('button')];
    const boxes = controls.map(button => button.getBoundingClientRect());
    const legend = element.querySelector('.chart-legend');
    const { marginTop, marginBottom } = getComputedStyle(legend);
    return {
      centers: boxes.map(({ top, height }) => top + height / 2),
      right: boxes.at(-1).right,
      headingRight: heading.getBoundingClientRect().right,
      headingLeft: heading.getBoundingClientRect().left,
      titleRight: heading.firstElementChild.getBoundingClientRect().right,
      toolbarLeft: toolbar.getBoundingClientRect().left,
      toolbarTop: toolbar.getBoundingClientRect().top,
      headingGap: parseFloat(getComputedStyle(heading).columnGap),
      modeLeftGap: mode.left - toolbar.getBoundingClientRect().left,
      groupGap: periods.left - mode.right,
      fullscreenGap: fullscreen.left - periods.right,
      itemGap: boxes[1].left - boxes[0].right,
      subtitleBottom: heading.querySelector('.chart-change').getBoundingClientRect().bottom,
      controlsTop: Math.min(...boxes.map(({ top }) => top)),
      legendGap: legend.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
      marginTop,
      marginBottom,
      buttonPadding: parseFloat(getComputedStyle(controls[0]).paddingInlineStart),
    };
  });

  assert.match(await chart.locator('[data-value="custom"]').textContent(), /^1,2\smois$/);
  const wide = await layout();
  assert.ok(wide.controlsTop < wide.subtitleBottom);
  assert.equal(wide.toolbarLeft, wide.titleRight + wide.headingGap);
  assert.ok(wide.modeLeftGap > 0);
  assert.ok(Math.abs(wide.modeLeftGap - (wide.groupGap - wide.fullscreenGap)) < 1);
  await page.setViewportSize({ width: 420, height: 900 });
  await chart.locator('.chart-controls-wrapped').waitFor();
  const medium = await layout();
  await page.setViewportSize({ width: 320, height: 900 });
  const narrow = await layout();
  assert.ok(wide.buttonPadding > medium.buttonPadding && medium.buttonPadding >= narrow.buttonPadding);
  assert.ok(wide.groupGap > medium.groupGap && medium.groupGap >= narrow.groupGap);
  for (const { groupGap, fullscreenGap, itemGap } of [medium, narrow]) {
    assert.ok(Math.abs(groupGap - fullscreenGap) < 1);
    assert.ok(groupGap >= itemGap && groupGap <= 4);
  }
  for (const { centers, right, headingRight } of [wide, medium, narrow]) {
    assert.equal(new Set(centers).size, 1);
    assert.ok(right <= headingRight + 1, `Fin des commandes : ${right}, en-tête : ${headingRight}`);
  }
  assert.ok(Math.abs(wide.right - wide.headingRight) < 1);
  for (const { toolbarLeft, headingLeft, modeLeftGap, subtitleBottom, toolbarTop, legendGap, marginTop, marginBottom }
    of [medium, narrow]) {
    assert.equal(toolbarLeft, headingLeft);
    assert.equal(modeLeftGap, 0);
    const titleGap = toolbarTop - subtitleBottom;
    assert.ok(titleGap > 0 && titleGap <= legendGap);
    assert.equal(legendGap, 6);
    assert.equal(marginTop, '6px');
    assert.equal(marginBottom, '6px');
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await chart.locator('.chart-controls-wrapped').waitFor({ state: 'detached' });
  assert.equal((await layout()).modeLeftGap, wide.modeLeftGap);
});

test('le graphique grandit quand les repères IMC sont dépliés dans une vue courte', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [record] }, {
    viewport: { width: 320, height: 300 },
  });
  await page.getByRole('button', { name: 'Graphique', exact: true }).click();
  const chart = page.locator('.measurement-chart');
  await chart.getByRole('button', { name: 'IMC (kg/m\u00b2)', exact: true }).click();
  const reference = chart.locator('.chart-bmi-reference summary');
  await reference.waitFor();
  const height = await chart.evaluate(element => element.clientHeight);
  await reference.click();
  const layout = await chart.evaluate(element => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    referenceBottom: element.querySelector('.chart-bmi-reference').getBoundingClientRect().bottom,
    chartBottom: element.getBoundingClientRect().bottom,
  }));
  assert.ok(layout.height > height);
  assert.equal(layout.scrollHeight, layout.height);
  assert.ok(layout.referenceBottom < layout.chartBottom);
});

test('le plein écran du graphique reste temporaire', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [record] });
  await page.getByRole('button', { name: 'Graphique', exact: true }).click();
  const chart = page.locator('.measurement-chart');
  const bmi = chart.getByRole('button', { name: 'IMC (kg/m\u00b2)', exact: true });
  await bmi.click();
  const reference = chart.locator('.chart-bmi-reference');
  await reference.waitFor();
  const fullscreen = chart.getByRole('button', { name: 'Plein écran', exact: true });
  const stored = () => page.evaluate(() => localStorage.getItem('epi-session-v1'));
  const before = await stored();

  await fullscreen.click();
  await page.locator('#view-content:fullscreen').waitFor();
  await reference.waitFor({ state: 'hidden' });
  await chart.locator('[data-action="chart-fullscreen"][aria-pressed="true"]').waitFor();
  assert.equal(await chart.locator('h2').isVisible(), true);
  assert.equal(await chart.getByRole('button', { name: 'Brut', exact: true }).isVisible(), true);
  assert.equal(await bmi.isVisible(), true);
  assert.deepEqual(await chart.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const { borderWidth, borderRadius } = getComputedStyle(element);
    return [x, y, width - innerWidth, height - innerHeight, borderWidth, borderRadius];
  }), [0, 0, 0, 0, '0px', '0px']);
  await fullscreen.click();
  await reference.waitFor();
  await chart.locator('[data-action="chart-fullscreen"][aria-pressed="false"]').waitFor();
  assert.equal(await stored(), before);

  await fullscreen.click();
  const period = chart.getByRole('button', { name: '30 j', exact: true });
  await period.click();
  await chart.locator('[data-value="30"][aria-pressed="true"]').waitFor();
  await chart.locator('[data-action="chart-fullscreen"][aria-pressed="true"]').waitFor();
  await fullscreen.click();
  await reference.waitFor();
});

test('le graphique suit les pesées et mémorise la visualisation par profil', async t => {
  const earlier = { ...record, receivedAt: '2025-12-01T17:23:21Z',
    measures: { weight: 150, unit: 'lb' }, calculations: null };
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Alice',
    measurements: [record, earlier, { ...record, receivedAt: '2026-01-14T17:23:21Z',
      measures: { ...record.measures, weight: 72 } }] }, {
    viewport: { width: 360, height: 800 }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
  });
  const chart = page.getByRole('button', { name: 'Graphique', exact: true });
  const table = page.getByRole('button', { name: 'Tableau', exact: true });
  const weightChart = page.getByRole('region', { name: 'Évolution des pesées', exact: true });
  assert.equal(await table.getAttribute('aria-pressed'), 'true');
  assert.ok((await chart.boundingBox()).x < (await table.boundingBox()).x);
  await chart.click();
  await weightChart.waitFor();
  assert.equal(await page.locator('.view-preset-title h1').textContent(), 'Pesées *');
  assert.equal(await page.getByRole('button', { name: 'Sauvegarder la configuration' }).isVisible(), true);
  assert.equal(await chart.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('table', { name: 'Pesées' }).count(), 0);
  const series = weightChart.locator('svg .chart-line');
  assert.deepEqual((await series.evaluateAll(lines => lines.map(line => line.dataset.series))).sort(), ['bmi', 'weight']);
  const bmi = weightChart.getByRole('button', { name: 'IMC (kg/m²)', exact: true });
  const bands = weightChart.locator('svg .chart-bmi-band');
  assert.equal(await bands.count(), 0);
  await bmi.click();
  await weightChart.locator('.chart-line-active[data-series="bmi"]').waitFor({ state: 'attached' });
  assert.equal(await bmi.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await bands.evaluateAll(rects => rects.map(rect => rect.getAttribute('fill'))),
    ['#44a66b', '#e5b72c', '#e67e32']);
  const reference = weightChart.getByText('Repères IMC adulte · Surpoids', { exact: true });
  await reference.click();
  assert.match(await weightChart.locator('.chart-bmi-reference ul').innerText(), /Corpulence normale \(18,5 à < 25\)/);
  await bmi.click();
  await weightChart.locator('.chart-line[data-series="bmi"]').waitFor({ state: 'detached' });
  assert.equal(await bmi.getAttribute('data-status'), 'hidden');
  assert.equal(await bands.count(), 0);
  const points = weightChart.locator('.chart-point[data-series="weight"]');
  const tendance = weightChart.getByRole('button', { name: 'Tendance', exact: true });
  const brut = weightChart.getByRole('button', { name: 'Brut', exact: true });
  assert.equal(await tendance.getAttribute('aria-pressed'), 'true');
  assert.ok((await weightChart.locator('.chart-values span').allTextContents()).includes('0'));
  const path = weightChart.locator('path.chart-line[data-series="weight"]');
  const smoothed = await path.getAttribute('d');
  const pointPositions = () => points.evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--y')));
  const trendPoints = await pointPositions();
  await brut.click();
  assert.notEqual(await path.getAttribute('d'), smoothed);
  assert.deepEqual(await pointPositions(), trendPoints);
  await weightChart.getByRole('button', { name: '30 j', exact: true }).click();
  assert.equal(await points.count(), 2);
  await weightChart.getByRole('button', { name: 'Tout', exact: true }).click();
  assert.equal(await points.count(), 3);

  const plot = weightChart.locator('.chart-plot');
  await plot.scrollIntoViewIfNeeded();
  const { x, y, width, height } = await plot.boundingBox();
  await page.mouse.move(x + width * .5, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width + 2, y + height / 2, { steps: 5 });
  await weightChart.locator('.chart-selection').waitFor();
  await page.mouse.up();
  const selectedStart = Date.parse('2025-12-22T00:00:00+01:00');
  const selectedPlot = weightChart.locator(`.chart-plot[data-start="${selectedStart}"]`);
  await selectedPlot.waitFor();
  assert.equal(await weightChart.locator('.chart-range').count(), 0);
  const customPeriod = weightChart.locator('[data-value="custom"]');
  assert.match(await customPeriod.textContent(), /^28\sjours$/);
  assert.equal(await customPeriod.getAttribute('aria-pressed'), 'true');
  assert.equal(await customPeriod.evaluate(button => button.nextElementSibling.textContent), '30 j');
  assert.equal(Number(await plot.getAttribute('data-end')), Date.parse('2026-01-18T23:59:59.999+01:00'));
  assert.equal(await points.count(), 2);
  const dates = weightChart.locator('.chart-dates');
  const edges = dates.locator('.chart-date-start span, .chart-date-end span');
  const interiorLabels = dates.locator('.chart-date-major:not(.chart-date-start, .chart-date-end)');
  const minorTicks = dates.locator('.chart-date-tick:not(.chart-date-major)');
  const calendarDates = locator => locator.evaluateAll(nodes => nodes.map(node => {
    const date = new Date(Number(node.dataset.time));
    return [date.getMonth() + 1, date.getDate(), date.getHours()];
  }));
  const interiorTicks = dates.locator('.chart-date-tick:not(.chart-date-start, .chart-date-end)');
  const assertReadableLabels = async () => {
    const labels = await dates.locator('.chart-date-major span').evaluateAll(nodes => nodes.map(node => {
      const { left, right } = node.getBoundingClientRect();
      return { left, right, lines: node.textContent.split('\n').length };
    }));
    assert.ok(labels.every(({ lines }, index) => lines === 2
      && (index === 0 || labels[index - 1].right < labels[index].left)));
  };

  await edges.last().waitFor();
  assert.deepEqual(await edges.allTextContents(), ['22/12\n2025', '18/01\n2026']);
  assert.deepEqual(await calendarDates(interiorTicks), [[12, 29, 0], [1, 5, 0], [1, 12, 0]]);
  assert.ok((await interiorLabels.count()) >= 2);
  await assertReadableLabels();

  await page.setViewportSize({ width: 1100, height: 800 });
  await minorTicks.nth(7).waitFor({ state: 'attached' });
  assert.equal(await interiorTicks.count(), 26);
  const majorDays = await interiorLabels.evaluateAll(nodes => nodes.map(node => Number(node.dataset.time)));
  assert.ok(majorDays.length > 3);
  const stride = majorDays[1] - majorDays[0];
  assert.ok(stride > 86_400_000);
  assert.ok(majorDays.slice(1).every((day, index) => day - majorDays[index] === stride));
  await assertReadableLabels();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await selectedPlot.waitFor();
  assert.equal(await brut.getAttribute('aria-pressed'), 'true');
  assert.equal(await points.count(), 2);
  const allPeriod = weightChart.getByRole('button', { name: 'Tout', exact: true });
  await allPeriod.click();
  assert.equal(await customPeriod.getAttribute('aria-pressed'), 'false');
  await page.reload();
  await customPeriod.click();
  await selectedPlot.waitFor();
  assert.equal(await customPeriod.getAttribute('aria-pressed'), 'true');
  assert.equal(await points.count(), 2);
  await allPeriod.click();
  assert.equal(await points.count(), 3);
  assert.match(await points.first().getAttribute('aria-label'), /68,04$/);
  await points.first().click();
  await page.getByRole('heading', { name: 'Détails de la pesée' }).waitFor();
  await page.getByRole('button', { name: 'Retour' }).click();
  await weightChart.waitFor();

  const picker = page.getByRole('combobox', { name: 'Profil actif' });
  await picker.selectOption('Bob');
  await page.getByText('Aucune pesée enregistrée pour ce profil.').waitFor();
  assert.equal(await table.getAttribute('aria-pressed'), 'true');
  await picker.selectOption('Alice');
  await weightChart.waitFor();
  await page.reload();
  await weightChart.waitFor();
  assert.equal(await bmi.getAttribute('data-status'), 'hidden');
  await bmi.click();
  await weightChart.locator('.chart-line[data-series="bmi"]').waitFor({ state: 'attached' });
  assert.equal(await bmi.getAttribute('data-status'), 'visible');

  for (const id of ['bmi', 'weight']) {
    const button = weightChart.locator(`[data-action="chart-axis"][data-value="${id}"]`);
    await button.click();
    await button.click();
    await weightChart.locator(`[data-value="${id}"][data-status="hidden"]`).waitFor();
  }
  await weightChart.getByText('Toutes les courbes sont masquées.').waitFor();
  await bmi.click();
  await weightChart.locator('.chart-line[data-series="bmi"]').waitFor({ state: 'attached' });
  await table.click();
  await page.getByRole('table', { name: 'Pesées' }).waitFor();
  await page.reload();
  await page.getByRole('table', { name: 'Pesées' }).waitFor();
});

test('sur Android, Filtrer apparaît à droite de Données sans prendre le focus', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice' }, {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 360, height: 800 },
  });
  const columns = page.getByText('Données', { exact: true });
  const search = page.getByRole('searchbox', { name: 'Filtrer' });
  await search.waitFor({ state: 'hidden' });
  await columns.click();
  await search.waitFor();
  const heading = await columns.boundingBox();
  const field = await search.boundingBox();
  assert.ok(field.x >= heading.x + heading.width);
  assert.equal(field.y, heading.y);
  assert.equal(await search.evaluate(input => document.activeElement === input), false);
  await columns.click();
  await search.waitFor({ state: 'hidden' });
});

test('la liste des pesées fixe les deux lignes d’en-tête pendant le défilement', async t => {
  const measurements = Array.from({ length: 25 }, (_, minute) => ({
    ...record, receivedAt: new Date(Date.parse(record.receivedAt) + minute * 60_000).toISOString(),
  }));
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements },
    { viewport: { width: 420, height: 380 } });
  await page.getByText('Données', { exact: true }).click();
  await page.getByLabel('Masse grasse (%)', { exact: true }).check();
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByRole('button', { name: 'Masse grasse (%)', exact: true }).click();
  const header = table.locator('thead');
  const rowOffset = await header.evaluate(head => {
    const [first, second] = head.rows;
    const scroll = document.querySelector('#view-scroll');
    scroll.scrollBy(0, first.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 80);
    return second.offsetTop - first.offsetTop;
  });
  await page.waitForFunction(offset => {
    const [first, second] = document.querySelector('.measurements-table thead').rows;
    const boundary = document.querySelector('#view-scroll').getBoundingClientRect().top;
    return Math.abs(first.cells[0].getBoundingClientRect().top - boundary + 1) < 0.5
      && Math.abs(second.cells[0].getBoundingClientRect().top - boundary - offset + 1) < 0.5;
  }, rowOffset);
});

test('le détail fixe la colonne Donnée et les en-têtes pendant le défilement', async t => {
  const calculations = Object.fromEntries(['IMC', 'Mi', 'Sun*', 'Jan*', 'D60*', 'Deu', 'CUN', 'Wat', 'HW', 'MSJ', 'HB', 'Owe', 'Cun*']
    .map(id => [id, { bmi: 25.7, fatPercent: 31.8, fatKg: 20, leanKg: 50, waterL: 37, restingEnergy: 1500 }]));
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [{ ...record, calculations }] },
    { viewport: { width: 420, height: 380 } });
  await page.getByRole('button', { name: /^Voir la pesée du/ }).click();
  const panel = page.locator('.comparison-scroll');
  const initial = await panel.evaluate(panel => {
    const corner = panel.querySelector('thead th');
    const rowHeader = panel.querySelector('tbody tr:last-child th');
    const { x, y } = corner.getBoundingClientRect();
    panel.scrollLeft = 200;
    panel.scrollTop = 100;
    const scroll = panel.closest('#view-scroll');
    scroll.scrollBy(0, y - scroll.getBoundingClientRect().top + 80);
    return {
      x,
      horizontalScroll: panel.scrollLeft > 0,
      verticalScroll: panel.scrollTop,
      fullHeight: panel.scrollHeight === panel.clientHeight,
      rowX: rowHeader.getBoundingClientRect().x,
    };
  });
  assert.deepEqual(initial, { x: initial.x, horizontalScroll: true, verticalScroll: 0, fullHeight: true, rowX: initial.x });
  await page.waitForFunction(() => {
    const boundary = document.querySelector('#view-scroll').getBoundingClientRect().top;
    return [...document.querySelectorAll('.comparison-scroll thead th')]
      .every(header => Math.abs(header.getBoundingClientRect().top - boundary + 1) < 0.5);
  });
  await page.evaluate(() => {
    const scroll = document.querySelector('#view-scroll');
    const table = scroll.querySelector('.comparison-scroll table');
    scroll.scrollBy(0, table.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top - 10);
  });
  await page.waitForFunction(() => {
    const scroll = document.querySelector('#view-scroll');
    return scroll.querySelector('.comparison-scroll thead th').getBoundingClientRect().top < scroll.getBoundingClientRect().top - 2;
  });
});

test('un glissement de souris depuis une cellule fait défiler le tableau sans déplacer les colonnes', async t => {
  const measurements = Array.from({ length: 30 }, (_, minute) => ({
    ...record, receivedAt: new Date(Date.parse(record.receivedAt) + minute * 60_000).toISOString(),
  }));
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements },
    { viewport: { width: 360, height: 600 } });
  await page.getByText('Données', { exact: true }).click();
  await page.getByLabel('Impédance (Ω)', { exact: true }).check();
  await page.getByText('Données', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Pesées' });
  const headers = panel.locator('thead tr').first().locator('th');
  const order = await headers.allTextContents();
  const reading = panel.getByRole('button', { name: /^Voir la pesée du/ }).first();
  const { x, y, width, height } = await reading.boundingBox();
  const startX = x + width / 2;
  const startY = y + height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 60, startY - 60, { steps: 5 });
  await page.mouse.up();
  assert.ok(await panel.evaluate(node => node.scrollLeft > 0));
  assert.ok(await panel.evaluate(node => (node.closest('#view-scroll') ?? document.scrollingElement).scrollTop > 0));
  assert.deepEqual(await headers.allTextContents(), order);
  await page.locator('#back-to-measurements').waitFor({ state: 'hidden' });
});

async function touchDrag(client, source, target) {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const x = from.x + from.width / 2;
  const y = from.y + from.height / 2;
  const dx = to.x + to.width / 2 - x;
  const dy = to.y + to.height / 2 - y;
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (const progress of [0.25, 0.5, 0.75, 1]) {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: x + dx * progress, y: y + dy * progress }],
    });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('le toucher réordonne l’historique, les méthodes et les sections du détail', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [record] },
    { viewport: { width: 430, height: 850 }, hasTouch: true, isMobile: true });
  const client = await page.context().newCDPSession(page);
  const table = page.getByRole('table', { name: 'Pesées' });
  await touchDrag(client, table.getByRole('columnheader', { name: 'Poids', exact: true }),
    table.getByRole('columnheader', { name: 'Date', exact: true }));
  assert.deepEqual(await table.locator('thead tr').first().locator('th').evaluateAll(headers =>
    headers.slice(0, 2).map(header => header.dataset.dragColumn)), ['weight', 'date']);
  const openReading = page.getByRole('button', { name: /^Voir la pesée du/ });
  await openReading.click();
  const comparison = page.getByRole('table', { name: 'Comparaison des méthodes' });
  const headers = comparison.locator('th[data-drag-column]');
  const section = id => page.locator(`[data-detail-section="${id}"] > summary`);
  await touchDrag(client, headers.filter({ hasText: 'Deu' }).getByRole('link'), headers.filter({ hasText: 'IMC' }));
  assert.deepEqual(await headers.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  await section('methods').click();
  assert.match(await page.locator('.legend a').first().textContent(), /Deu/);
  await section('methods').click();
  await touchDrag(client, section('device'), section('methods'));
  const sectionOrder = () => page.locator('[data-detail-section]').evaluateAll(nodes => nodes.map(node => node.dataset.detailSection));
  assert.deepEqual(await sectionOrder(), ['device', 'methods', 'measures', 'profile']);
  assert.equal(await section('device').evaluate(summary => summary.parentElement.open), false);
  await section('device').click();
  assert.equal(await section('device').evaluate(summary => summary.parentElement.open), true);
  await page.reload();
  await openReading.tap();
  assert.deepEqual(await headers.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  assert.deepEqual(await sectionOrder(), ['device', 'methods', 'measures', 'profile']);
});

test('les volets du flux brut et des détails sont mémorisés par profil', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Alice', measurements: [
    record, { ...record, profile: { name: 'Bob' } },
  ] });
  const profile = page.getByRole('combobox', { name: 'Profil actif' });
  const raw = page.locator('details[data-expand="raw"]');
  const details = page.getByRole('button', { name: /^Voir la pesée du/ });
  const measures = page.locator('details[data-detail-section="measures"]');
  const weighedProfile = page.locator('details[data-detail-section="profile"]');
  await choosePage(page, 'Appareils');
  await raw.locator('summary').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('epi-session-v1')).profilePreferences?.Alice?.rawOpen === true);
  await profile.selectOption('Bob');
  await raw.and(page.locator('[open]')).waitFor({ state: 'hidden' });
  await profile.selectOption('Alice');
  await raw.and(page.locator('[open]')).waitFor();

  await choosePage(page, 'Mesures');
  await details.click();
  await measures.locator('summary').click();
  await weighedProfile.locator('summary').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('epi-session-v1')).profilePreferences?.Alice?.detailSectionsOpen?.profile === false);
  await profile.selectOption('Bob');
  await details.click();
  assert.equal(await measures.getAttribute('open'), null);
  assert.equal(await weighedProfile.getAttribute('open'), '');
  await profile.selectOption('Alice');
  await details.click();
  assert.equal(await measures.getAttribute('open'), '');
  assert.equal(await weighedProfile.getAttribute('open'), null);

  await choosePage(page, 'Appareils');
  await page.reload();
  await raw.and(page.locator('[open]')).waitFor();
  await choosePage(page, 'Mesures');
  await details.click();
  assert.equal(await measures.getAttribute('open'), '');
  assert.equal(await weighedProfile.getAttribute('open'), null);
});

test('dates selon la locale active et conservation de la date de naissance et de l’horloge de la balance', async t => {
  const birthDate = '1980-01-05';
  const scaleTime = '2026-03-08T02:15:00';
  const profile = { ...alice, birthDate, createdAt: record.receivedAt, updatedAt: '2026-01-15T17:25:42Z' };
  const scale = { ...device, registeredAt: profile.createdAt, updatedAt: profile.updatedAt };
  const measurement = { ...record, profile, device: scale, reception: { scale: { scaleTime } } };
  const page = await pageWith(t, { profiles: [profile], devices: [scale], selectedProfile: 'Alice', measurements: [measurement] },
    { locale: 'en-GB', timezoneId: 'America/Los_Angeles' });

  assert.equal(await page.locator('html').getAttribute('lang'), 'en-GB');
  assert.match(await page.locator('.measurement-summary .muted').innerText(), /09:23$/);
  await page.getByRole('button', { name: /View weigh-in from 15\/01\/2026, 09:23:21/ }).click();
  assert.match(await page.locator('.measurement-details > p').innerText(), /09:23$/);
  await page.getByText(/^08\/03\/2026, 02:15:00/).waitFor();
  await page.getByText('05/01/1980', { exact: true }).waitFor();
  await choosePage(page, 'Profiles');
  await page.getByText(/Birth: 05\/01\/1980/).waitFor();
  await page.getByText(/09:23$/, { exact: true }).waitFor();
  await page.getByText(/09:25$/, { exact: true }).waitFor();
  await choosePage(page, 'Devices');
  await page.getByText(/09:23$/, { exact: true }).waitFor();
  await page.getByText(/09:25$/, { exact: true }).waitFor();
});

test('la création de profil utilise la vue centrale et les boutons de la barre', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice' },
    { viewport: { width: 360, height: 700 } });
  await choosePage(page, 'Profils');
  const toolbar = page.locator('.toolbar');
  const archive = toolbar.getByRole('button', { name: 'Export ZIP' });
  const editor = page.locator('#editor-view');
  const create = page.getByRole('button', { name: 'Créer un profil' });
  await create.click();
  await editor.getByRole('heading', { name: 'Créer un profil' }).waitFor();
  assert.equal(await editor.getByLabel('Nom', { exact: true }).evaluate(input => input === document.activeElement), true);
  await archive.waitFor({ state: 'hidden' });
  await toolbar.getByRole('button', { name: 'Annuler' }).click();
  await archive.waitFor();
  await create.click();
  await editor.getByLabel('Nom', { exact: true }).fill('Camille');
  await editor.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await editor.getByLabel('Date de naissance', { exact: true }).fill('1994-01-15');
  await editor.getByLabel('Taille (cm)').fill('170');
  await toolbar.getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: /^Camille/ }).waitFor();
  await page.locator('#notices').getByText('Profil enregistré', { exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Camille');
  await archive.waitFor();
});

test('une trame reçue pendant la saisie prépare l’enregistrement de la balance', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [record] });
  await choosePage(page, 'Appareils');
  await page.getByRole('button', { name: 'Ajouter un appareil' }).click();
  const editor = page.locator('#editor-view');
  const toolbar = page.locator('.toolbar');
  const name = editor.getByLabel('Nom de l’appareil');
  assert.equal(await name.evaluate(input => input === document.activeElement), true);
  await name.fill('Balance en cours');
  await toolbar.getByRole('button', { name: 'Démarrer la capture' }).waitFor();
  await feed(page, frame);
  const save = toolbar.getByRole('button', { name: 'Enregistrer', exact: true });
  await save.waitFor();
  await editor.getByText(address, { exact: true }).waitFor();
  await feed(page, metadata);
  await editor.getByText('XMTZC05HM', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), 'Balance en cours');
  assert.equal(await name.evaluate(input => input === document.activeElement), true);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('epi-session-v1')).devices.length), 0);
  await name.fill('Balance capturée');
  await save.click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await choosePage(page, 'Appareils');
  await page.getByRole('heading', { name: 'Balance capturée', exact: true }).waitFor();
  assert.equal(await page.getByText(/En attente d’une pesée/).count(), 0);
});

test('les suppressions demandent confirmation et persistent après rechargement', async t => {
  const remaining = { ...record, receivedAt: '2026-01-16T17:23:21Z' };
  const other = { ...record, profile: { name: 'Bob' } };
  const page = await pageWith(t, {
    profiles: [alice, bob], selectedProfile: 'Alice', devices: [device],
    measurements: [record, remaining, other], profilePreferences: { Alice: { theme: 'dark' } },
  });
  const dialog = page.getByRole('dialog');
  const confirm = () => dialog.getByRole('button', { name: 'Supprimer', exact: true }).click();
  const cancel = () => dialog.getByRole('button', { name: 'Annuler' }).click();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('epi-session-v1')));
  const notices = page.locator('#notices');

  const initial = await stored();
  await choosePage(page, 'Appareils');
  await page.getByRole('button', { name: 'Écouter seulement cet appareil' }).click();
  await page.getByText(/Écoute limitée à/).waitFor();
  const editorActions = page.locator('#editor-actions').getByRole('button');
  const deviceCard = page.locator('.device-list').getByRole('article');
  assert.deepEqual(await deviceCard.getByRole('button').allTextContents(), ['Modifier']);
  await deviceCard.getByRole('button', { name: 'Modifier' }).click();
  assert.deepEqual(await editorActions.allTextContents(), ['Annuler', 'Supprimer', 'Enregistrer']);
  const deleteDevice = page.locator('#editor-actions').getByRole('button', { name: 'Supprimer', exact: true });
  await deleteDevice.click();
  await cancel();
  await deleteDevice.click();
  await confirm();
  await deleteDevice.waitFor({ state: 'detached' });
  await page.getByText('Aucun appareil enregistré.', { exact: true }).waitFor();
  await notices.getByText('Appareil supprimé', { exact: true }).waitFor();
  await dismissNotificationBanner(page);
  assert.equal((await stored()).addressFilter, null);
  assert.equal((await stored()).measurements.length, 3);

  await choosePage(page, 'Mesures');
  await page.getByRole('button', { name: /Voir la pesée du/ }).last().click();
  const deleteMeasurement = page.locator('#detail-actions').getByRole('button', { name: 'Supprimer', exact: true });
  await deleteMeasurement.click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await deleteMeasurement.click();
  await confirm();
  await page.getByRole('table', { name: 'Pesées' }).waitFor();
  assert.deepEqual((await stored()).measurements, initial.measurements.slice(1));

  await choosePage(page, 'Profils');
  const profile = page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^Alice\b/ }) });
  await profile.getByRole('button', { name: 'Modifier', exact: true }).click();
  assert.deepEqual(await editorActions.allTextContents(), ['Annuler', 'Supprimer', 'Enregistrer']);
  const deleteProfile = page.locator('.toolbar').getByRole('button', { name: 'Supprimer', exact: true });
  await deleteProfile.click();
  await dialog.getByText(/Les pesées de ce profil seront aussi retirées/).waitFor();
  await cancel();
  await deleteProfile.click();
  await confirm();
  await deleteProfile.waitFor({ state: 'detached' });
  await notices.getByText('Profil supprimé', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  const snapshot = await stored();
  assert.deepEqual(snapshot.profiles, [initial.profiles[1]]);
  assert.deepEqual(snapshot.measurements, [initial.measurements[2]]);
  assert.deepEqual(snapshot.devices, []);
  assert.deepEqual(snapshot.profilePreferences, {});
  assert.equal(snapshot.selectedProfile, 'Bob');
  assert.deepEqual(snapshot.notifications.map(({ type, action }) => [type, action]), [
    ['device', 'deleted'], ['measurement', 'deleted'], ['profile', 'deleted'],
  ]);
});

test('capture et renommage, attribution automatique et flux brut horodaté', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Bob', measurements: [record] }, { locale: 'fr-FR' });
  await choosePage(page, 'Appareils');
  await page.getByRole('button', { name: 'Ajouter un appareil' }).click();
  const editor = page.locator('#editor-view');
  await editor.getByLabel('Nom de l’appareil').fill('Balance Xiaomi');
  await page.locator('.toolbar').getByRole('button', { name: 'Démarrer la capture' }).click();
  await page.getByText(/En attente d’une pesée/).waitFor();
  await feed(page, metadata);
  await feed(page, frame);
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await page.getByText('70,9 kg', { exact: true }).waitFor();
  await choosePage(page, 'Appareils');
  await page.getByRole('heading', { name: 'Balance Xiaomi', exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alice');
  await page.getByText('Flux Bluetooth brut').click();
  await page.locator('#raw-frames').filter({ hasText: /\[\d[^\]]*\d{2}:\d{2}:\d{2}\] AABBCCDDEEFF -58/ }).waitFor();
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await editor.getByRole('heading', { name: 'Modifier l’appareil' }).waitFor();
  assert.equal(await editor.getByRole('textbox').count(), 1);
  await editor.getByText(address, { exact: true }).waitFor();
  const name = editor.getByLabel('Nom de l’appareil');
  assert.equal(await name.evaluate(input => input === document.activeElement), true);
  await name.fill('Balance maison');
  await page.locator('.toolbar').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  const renamed = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Balance maison', exact: true }) });
  await renamed.getByText(address, { exact: true }).waitFor();
  await page.locator('#notices').getByText('Appareil enregistré', { exact: true }).waitFor();
  await page.reload();
  await renamed.getByText(address, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Écouter seulement cet appareil' }).click();
  await page.getByText(/Écoute limitée à/).waitFor();
  await page.getByRole('button', { name: 'Écouter tous les appareils' }).click();
  await page.getByRole('button', { name: 'Écouter tous les appareils' }).waitFor({ state: 'hidden' });
  await choosePage(page, 'Mesures');
  await page.getByRole('table').getByText('70,9 kg', { exact: true }).waitFor();
  assert.equal(await page.getByRole('table').getByText('70,9 kg', { exact: true }).count(), 1);
});

test('attribution sans profil sur smartphone, création depuis une pesée et historique redimensionnable', async t => {
  const page = await pageWith(t, { devices: [device] },
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await feed(page, frame);
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  const editor = page.locator('#editor-view');
  const toolbar = page.locator('.toolbar');
  await editor.getByText('Aucun profil sur cet appareil.', { exact: true }).waitFor();
  assert.equal(await editor.getByRole('list', { name: 'Profils' }).count(), 0);
  const createProfile = toolbar.locator('#editor-actions').getByRole('button', { name: 'Créer un profil' });
  assert.match(await createProfile.getAttribute('class'), /\bprimary\b/);
  assert.doesNotMatch(await toolbar.getByRole('button', { name: 'Calculer sans profil' }).getAttribute('class'), /\bprimary\b/);
  const receipt = page.locator('#pending-actions').getByText('Pesée reçue', { exact: true });
  await editor.getByRole('heading', { name: 'Attribuer la pesée' }).waitFor();
  assert.equal(await receipt.isVisible(), false);
  await createProfile.tap();
  await editor.getByRole('heading', { name: 'Créer un profil' }).waitFor();
  assert.equal(await receipt.isVisible(), false);
  await toolbar.getByRole('button', { name: 'Annuler', exact: true }).click();
  await receipt.waitFor();
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  await createProfile.tap();
  await editor.getByRole('textbox', { name: 'Nom', exact: true }).fill('Camille');
  await editor.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await editor.getByLabel('Âge utilisé par les formules').selectOption('age');
  await editor.getByLabel('Âge (ans)', { exact: true }).fill('35');
  await editor.getByLabel('Taille (cm)').fill('171');
  await toolbar.getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Camille');
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await page.getByText('70,9 kg', { exact: true }).waitFor();
  await page.locator('#back-to-measurements').click();
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByText('70,9 kg', { exact: true }).waitFor();
  await page.getByText('Données', { exact: true }).click();
  for (const label of ['Masse grasse (%)', 'Énergie au repos (kcal/j)', 'Horloge de la balance']) {
    await page.getByLabel(label, { exact: true }).check();
  }
  const scroll = page.getByRole('region', { name: 'Pesées' });
  assert.equal(await scroll.evaluate(node => node.scrollWidth > node.clientWidth), true);
  await table.getByRole('cell', { name: '70,9 kg', exact: true }).tap();
  const comparison = page.getByRole('region', { name: 'Comparaison des méthodes' });
  assert.ok(await comparison.evaluate(node => node.scrollWidth > node.clientWidth));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth), true);
});

test('archive ZIP exportée, réimportée et idempotente dans le navigateur', async t => {
  const source = await pageWith(t, { profiles: [alice], devices: [device], measurements: [record] });
  await source.getByRole('table', { name: 'Pesées' }).getByText('70 kg', { exact: true }).waitFor();
  const downloadEvent = source.waitForEvent('download');
  await source.getByRole('button', { name: 'Export ZIP' }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^epi-data-\d{4}-\d{2}-\d{2}\.zip$/);
  const data = await download.createReadStream();
  const bytes = [];
  for await (const chunk of data) bytes.push(chunk);
  const archive = { name: download.suggestedFilename(), mimeType: 'application/zip', buffer: Buffer.concat(bytes) };
  const entries = Object.keys(unzipSync(archive.buffer));
  const uuid = '[0-9a-f-]{36}';
  assert.ok(entries.some(path => new RegExp('^data/profiles/' + uuid + '[.]json$').test(path)));
  assert.ok(entries.some(path => new RegExp('^data/devices/' + uuid + '[.]json$').test(path)));
  const stamp = new Date(record.receivedAt).toISOString().replaceAll(':', '-');
  assert.ok(entries.some(path => path.startsWith('data/measures/') && path.endsWith('/' + stamp + '.json')));


  const page = await pageWith(t);
  await page.locator('#import-files').setInputFiles(archive);
  await page.getByText('Import terminé.', { exact: true }).waitFor();
  await dismissNotificationBanner(page);
  await page.getByRole('button', { name: 'Modifier le profil Alice', exact: true }).waitFor();
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByText('70 kg', { exact: true }).waitFor();
  await page.locator('#import-files').setInputFiles(archive);
  await page.getByText('Import terminé.', { exact: true }).waitFor();
  assert.equal(await table.getByText('70 kg', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('combobox', { name: 'Profil actif' }).count(), 0);
  await dismissNotificationBanner(page);
  await page.locator('#import-files').setInputFiles({ name: 'incorrect.zip', mimeType: 'application/zip', buffer: Buffer.from('Invalid ZIP') });
  await page.getByRole('alert').waitFor();
});

test('appareil détecté sans capture, attribution confirmée et calcul temporaire', async t => {
  const elise = { ...alice, name: 'Élise' };
  const zoe = { ...alice, name: 'zoé' };
  const bobWithSurname = { ...bob, name: 'Bob Martin' };
  const page = await pageWith(t, { profiles: [zoe, elise, bobWithSurname, alice], selectedProfile: 'Alice' }, { hasTouch: true });
  const profileNames = ['Alice', 'Bob Martin', 'Élise', 'zoé'];
  assert.deepEqual((await page.locator('#profile option').allTextContents()).slice(1), profileNames);
  await feed(page, frame);
  const banner = page.locator('#pending-actions');
  await banner.getByRole('button', { name: 'Enregistrer l’appareil' }).click();
  const editor = page.locator('#editor-view');
  const toolbar = page.locator('.toolbar');
  const receipt = banner.getByText('Pesée reçue', { exact: true });
  await editor.getByRole('heading', { name: 'Ajouter un appareil' }).waitFor();
  assert.equal(await receipt.isVisible(), false);
  await toolbar.getByRole('button', { name: 'Annuler', exact: true }).click();
  await receipt.waitFor();
  await banner.getByRole('button', { name: 'Enregistrer l’appareil' }).click();
  await editor.getByLabel('Nom de l’appareil').fill('Xiaomi');
  await toolbar.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await banner.getByRole('button', { name: 'Attribuer la pesée' }).click();
  const profiles = editor.getByRole('list', { name: 'Profils' });
  assert.deepEqual(await profiles.locator('.assignment-name').allTextContents(), ['Alice', 'Bob', 'Élise', 'zoé']);
  await profiles.getByRole('button', { name: 'Bob Sélectionner', exact: true }).getByText('Bob', { exact: true }).tap();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Bob Martin');
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await page.getByText('70,9 kg', { exact: true }).waitFor();

  await feed(page, 'AABBCCDDEEFF -62 181D 00404C');
  await banner.getByRole('button', { name: 'Attribuer la pesée' }).click();
  const calculate = toolbar.getByRole('button', { name: 'Calculer sans profil' });
  assert.match(await calculate.getAttribute('class'), /\bprimary\b/);
  assert.doesNotMatch(await toolbar.getByRole('button', { name: 'Créer un profil' }).getAttribute('class'), /\bprimary\b/);
  await calculate.click();
  await editor.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await editor.getByLabel('Date de naissance', { exact: true }).fill('1994-01-15');
  await editor.getByLabel('Taille (cm)').fill('170');
  await toolbar.getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Bob Martin');
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await page.getByText('97,6 kg', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('');
  await page.getByRole('table').getByText('97,6 kg', { exact: true }).waitFor();
  assert.equal(await page.getByText('Données', { exact: true }).count(), 0);
  await page.getByRole('table').getByRole('columnheader', { name: 'IMC (kg/m²)', exact: true }).waitFor();
});

test('affiche les mesures reçues de la balance et leur provenance', async t => {
  const scale = { name: 'Standard', bluetooth: { address, serviceUuid: '0x181D' } };
  const page = await pageWith(t, { profiles: [alice], devices: [scale], selectedProfile: 'Alice' });
  await feed(page, 'AABBCCDDEEFF -58 181D 0e803eea070b100b0c0d02e600d606 Gatt ');
  await page.locator('#pending-actions').getByRole('button', { name: 'Attribuer la pesée' }).click();
  await page.getByRole('list', { name: 'Profils' }).getByRole('button', { name: 'Alice Sélectionner' }).click();
  const measures = page.locator('details[data-detail-section="measures"]');
  await measures.locator('summary').click();
  assert.equal(await measures.locator('dt').filter({ hasText: /^IMC$/ }).locator('+ dd').textContent(), '23');
  assert.equal(await measures.locator('dt').filter({ hasText: 'Taille (cm)' }).locator('+ dd').textContent(), '175');
  const user = page.locator('details[data-detail-section="reception"] dt')
    .filter({ hasText: 'Identifiant utilisateur sur la balance' }).locator('+ dd');
  assert.equal(await user.textContent(), '2');
});

test('le journal conserve ses entrées et restaure un profil avec ses pesées', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], devices: [device], selectedProfile: 'Bob',
    measurements: [record] });
  const icon = page.getByRole('button', { name: 'Notifications', exact: true });
  assert.equal(await icon.count(), 0);
  await choosePage(page, 'Profils');
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Alice', exact: true }) })
    .getByRole('button', { name: 'Modifier', exact: true }).click();
  await page.locator('.toolbar').getByRole('button', { name: 'Supprimer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await icon.waitFor();
  const profileIcon = page.locator('#profile-icon');
  const frameColor = control => control.evaluate(node => getComputedStyle(node, '::before').borderTopColor);
  const transparent = 'rgba(0, 0, 0, 0)';
  for (const control of [profileIcon, icon]) {
    assert.equal(await frameColor(control), transparent);
    await control.hover();
    assert.notEqual(await frameColor(control), transparent);
    await page.getByRole('heading', { name: 'Profils', exact: true }).hover();
    assert.equal(await frameColor(control), transparent);
  }
  await page.reload();
  await icon.click();
  const card = page.locator('.notification-item').filter({ hasText: 'Profil supprimé' });
  await card.getByText(/Profil actif : Bob/).waitFor();
  await card.getByRole('button', { name: /Profil supprimé/ }).click();
  const form = page.locator('#editor-view');
  const toolbar = page.locator('.toolbar');
  await form.getByRole('heading', { name: 'Restaurer le profil', exact: true }).waitFor();
  assert.equal(await form.getByLabel('Nom', { exact: true }).inputValue(), 'Alice');
  assert.equal(await form.getByLabel('Taille (cm)').inputValue(), '165');
  await form.getByLabel('Nom', { exact: true }).fill('Alicia');
  assert.equal(await toolbar.getByRole('button', { name: 'Supprimer', exact: true }).count(), 0);
  const restore = toolbar.getByRole('button', { name: 'Restaurer', exact: true });
  await restore.click();
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
  assert.equal(await form.getByLabel('Nom', { exact: true }).inputValue(), 'Alicia');
  await restore.click();
  await dialog.getByText(/Restaurer aussi les pesées de ce profil/).waitFor();
  const yes = dialog.getByRole('button', { name: 'Oui', exact: true });
  assert.match(await yes.getAttribute('class'), /\bprimary\b/);
  await yes.click();
  await form.waitFor({ state: 'hidden' });
  await page.waitForURL(/#profiles\/[0-9a-f-]+$/);
  await page.getByRole('heading', { name: 'Alicia', exact: true }).waitFor();
  await page.locator('#notices').getByText('Profil restauré', { exact: true }).waitFor();
  await icon.click();
  await card.getByText(/^Restauré le /).waitFor();
  await card.getByRole('button', { name: /Profil supprimé/ }).click();
  await form.getByRole('heading', { name: 'Modifier le profil', exact: true }).waitFor();
  assert.equal(await form.getByLabel('Nom', { exact: true }).inputValue(), 'Alicia');
  assert.equal(await restore.count(), 0);
  await toolbar.getByRole('button', { name: 'Annuler', exact: true }).click();
  await card.getByRole('button', { name: 'Supprimer définitivement la notification' }).click();
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  await page.locator('.notification-item').getByText('Profil restauré', { exact: true }).waitFor();
  await choosePage(page, 'Mesures');
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alicia');
  await page.getByRole('table', { name: 'Pesées' }).getByText('70 kg').waitFor();
});

test('la suppression groupée demande confirmation et vide le journal après rechargement', async t => {
  const date = new Date().toISOString();
  const page = await pageWith(t, { profiles: [alice, bob], measurements: [record], selectedProfile: 'Alice',
    notifications: ['Première notification', 'Seconde notification'].map((text, index) => ({
      id: String(index), date, type: 'info', text,
    })) });
  await page.getByRole('button', { name: 'Ouvrir les profils', exact: true }).click();
  await page.getByRole('heading', { name: 'Profils', exact: true }).waitFor();
  const icon = page.getByRole('button', { name: 'Notifications', exact: true });
  const gap = await icon.evaluate(button => {
    const iconBounds = button.getBoundingClientRect();
    return iconBounds.left - document.querySelector('#profile').getBoundingClientRect().right - iconBounds.width;
  });
  assert.ok(Math.abs(gap) < 1);
  await icon.click();
  const removeAll = page.locator('#view-header').getByRole('button', { name: 'Supprimer tout', exact: true });
  const dialog = page.getByRole('dialog');
  await removeAll.click();
  await dialog.getByRole('button', { name: 'Annuler', exact: true }).click();
  assert.equal(await page.locator('.notification-item').count(), 2);
  await removeAll.click();
  await dialog.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByText('Aucune notification.', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Aucune notification.', { exact: true }).waitFor();
  assert.equal(await icon.count(), 0);
  await choosePage(page, 'Mesures');
  await page.getByRole('table', { name: 'Pesées' }).getByText('70 kg').waitFor();
});

test('le bandeau recouvre la barre sur smartphone et sa fermeture conserve le journal', async t => {
  const page = await pageWith(t, { devices: [device] },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.getByRole('button', { name: 'Export ZIP' }).click();
  const banner = page.locator('.notification-banner');
  await banner.getByText('Archive ZIP exportée.', { exact: true }).waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.notification-banner')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
  const geometry = await banner.evaluate(node => {
    const toolbar = document.querySelector('.toolbar');
    const icon = document.querySelector('#notifications-icon').getBoundingClientRect();
    const theme = document.querySelector('#theme-toggle').getBoundingClientRect();
    const profile = document.querySelector('#profile-icon').getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    const bar = toolbar.getBoundingClientRect();
    const overTheme = document.elementFromPoint(theme.x + theme.width / 2, theme.y + theme.height / 2);
    return {
      top: bounds.top - bar.top,
      bottom: bounds.bottom - bar.bottom,
      coversTheme: node.contains(overTheme),
      duration: getComputedStyle(node).transitionDuration,
      iconWidth: icon.width,
      gaps: [theme.left - icon.right, icon.left - profile.right],
    };
  });
  assert.equal(geometry.top, 0);
  assert.ok(Math.abs(geometry.bottom) <= 1);
  assert.equal(geometry.coversTheme, true);
  assert.equal(geometry.duration, '0.18s');
  assert.deepEqual(geometry.gaps, [geometry.iconWidth, geometry.iconWidth]);
  await dismissNotificationBanner(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.locator('.notification-item').getByText('Archive ZIP exportée.', { exact: true }).waitFor();
});

test('les informations expirent après trois secondes et les erreurs attendent une validation', async t => {
  const page = await pageWith(t);
  await page.clock.install();
  const reload = page.locator('#reload-data');
  const banner = page.locator('#notices');
  const info = banner.getByText('Données rechargées manuellement.', { exact: true });
  await reload.evaluate(button => { button.hidden = false; });
  await reload.click();
  await info.waitFor();
  await page.clock.runFor(2800);
  assert.equal(await banner.evaluate(node => node.classList.contains('is-open')), true);
  await page.clock.runFor(200);
  assert.equal(await banner.evaluate(node => node.classList.contains('is-open')), false);
  await page.clock.runFor(180);
  await reload.click();
  await info.click();
  await page.clock.runFor(180);
  await info.waitFor({ state: 'hidden' });

  await page.locator('#import-files').setInputFiles({ name: 'incorrect.zip', mimeType: 'application/zip', buffer: Buffer.from('Invalid ZIP') });
  const error = banner.getByRole('alert');
  await error.waitFor();
  await reload.evaluate(button => button.click());
  await page.clock.runFor(4000);
  assert.equal(await error.isVisible(), true);
  await banner.getByRole('button', { name: 'Vu', exact: true }).click();
  await page.clock.runFor(180);
  await info.waitFor();
});

test('un conflit recharge les fichiers modifiés et regroupe les demandes rapprochées', async t => {
  await buildWeb();
  const id = '00000000-0000-4000-8000-000000000001';
  const reloads = [];
  const notices = [];
  let conflicts = 0;
  let snapshot = { profiles: [{ ...alice, uuid: id }], devices: [], measurements: [], pending: [],
    notifications: [], profilePreferences: {}, viewPresets: { measurements: [], details: [] } };
  const page = await pageWith(t, route => {
    const { action, args } = route.request().postDataJSON();
    if (action === 'pendingTransactions') return route.fulfill({ json: [] });
    if (action === 'setTheme') {
      conflicts += 1;
      return route.fulfill({ status: 400, json: { error: conflicts === 1
        ? 'Un fichier a changé. Recharge les données avant de réessayer.'
        : 'epi-i18n:diagnostic.aFileHasBeenModifiedReload' } });
    }
    if (action === 'reload') {
      reloads.push(performance.now());
      if (reloads.length === 2) {
        snapshot = { ...snapshot, profiles: [{ ...alice, uuid: id, heightCm: 166 }], measurements: [record] };
      }
    }
    if (action === 'recordNotice') {
      notices.push(args[0]);
      snapshot = { ...snapshot, notifications: [...snapshot.notifications,
        { ...args[0], id: String(notices.length), date: new Date().toISOString() }] };
    }
    return route.fulfill({ json: snapshot });
  }, { timezoneId: 'Europe/Paris' }, 'web');

  const banner = page.locator('#notices');
  const theme = page.locator('#theme-toggle');
  await page.locator('#reload-data').click();
  await banner.getByText('Données rechargées manuellement.', { exact: true }).waitFor();
  await dismissNotificationBanner(page);
  await theme.click();
  await theme.click();
  await banner.getByText('Données rechargées automatiquement.', { exact: true }).waitFor();
  assert.equal(conflicts, 2);
  assert.equal(reloads.length, 2);
  assert.ok(reloads[1] - reloads[0] >= 1000);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1].reloadFiles, ['Profil · Alice', 'Pesée · Alice · 70 kg · 15/01/2026 18:23:21']);
  assert.deepEqual(await banner.locator('.notification-reload-files li').allTextContents(), notices[1].reloadFiles);
});

test('le bandeau affiche uniquement la première ligne d’une erreur', async t => {
  await buildWeb();
  const page = await pageWith(t, { profiles: [], devices: [], measurements: [], pending: [], notifications: [] },
    { viewport: { width: 320, height: 800 } }, 'web');
  const message = 'Impossible de recharger les données depuis le dossier utilisateur.';
  await page.route(url + 'api/session', route => route.fulfill({
    status: 500,
    json: { error: message + '\r\nDétail technique.' },
  }));
  const reload = page.locator('#reload-data');
  await reload.evaluate(button => { button.hidden = false; button.click(); });
  const summary = page.getByRole('alert').locator('.notification-summary');
  await summary.waitFor();
  assert.equal(await summary.textContent(), message);
  assert.deepEqual(await summary.evaluate(node => {
    const style = getComputedStyle(node);
    return [style.whiteSpace, style.textOverflow, node.scrollWidth > node.clientWidth];
  }), ['nowrap', 'ellipsis', true]);
});

test('les notifications de pesée ouvrent le détail et la suppression permet de restaurer', async t => {
  const page = await pageWith(t, { profiles: [alice], devices: [device], selectedProfile: 'Alice', measurements: [record] });
  const notices = page.locator('#notices');
  await page.getByRole('link', { name: 'Mode simulation' }).click();
  await page.getByRole('heading', { name: 'Écoute Bluetooth' }).waitFor();
  await feed(page, frame);
  await notices.getByText('Pesée enregistrée', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  await page.getByText('70,9 kg', { exact: true }).waitFor();
  assert.equal(await notices.locator('.notification-summary').innerText(), 'Pesée enregistrée');
  await dismissNotificationBanner(page);
  const icon = page.getByRole('button', { name: 'Notifications', exact: true });
  await icon.click();
  const saved = page.locator('.notification-item').getByRole('button', { name: /^Pesée enregistrée/ });
  assert.match(await saved.innerText(), /Impédance reçue/);
  assert.match(await saved.innerText(), /\d{1,2}:\d{2}:\d{2}/);
  await saved.click();
  await page.getByRole('heading', { name: 'Détails de la pesée', exact: true }).waitFor();
  assert.match(await page.locator('.measurement-details > p').innerText(), /\d{1,2}:\d{2}:\d{2}/);
  await choosePage(page, 'Mesures');
  await page.getByRole('button', { name: /Voir la pesée du/ }).first().click();
  await page.locator('#detail-actions').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await notices.getByText('Pesée supprimée', { exact: true }).waitFor();
  assert.equal(await notices.locator('.notification-summary').innerText(), 'Pesée supprimée');
  await dismissNotificationBanner(page);
  await icon.click();
  const deleted = page.locator('.notification-item').getByRole('button', { name: /Pesée supprimée/ });
  assert.match(await deleted.innerText(), /avec impédance/);
  await deleted.click();
  await page.getByText('Cet élément a été supprimé.', { exact: true }).waitFor();
  await page.locator('.toolbar').getByRole('button', { name: 'Restaurer', exact: true }).click();
  await page.getByText('Cet élément a été restauré.', { exact: true }).waitFor();
  await notices.getByText('Pesée restaurée', { exact: true }).waitFor();
  await dismissNotificationBanner(page);
  await icon.click();
  await page.locator('.notification-item').getByText('Pesée restaurée', { exact: true }).waitFor();
  await choosePage(page, 'Mesures');
  await page.getByRole('table', { name: 'Pesées' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Voir la pesée du/ }).count(), 2);
});

test('une réception ouvre la pesée active ou supprimée et réactive le bandeau si sa fiche disparaît', async t => {
  const page = await pageWith(t, { profiles: [alice], devices: [device], selectedProfile: 'Alice', measurements: [record] });
  await feed(page, frame);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const receipt = page.locator('.notification-item').getByRole('button', { name: /Pesée reçue/ });
  await receipt.click();
  const details = page.getByRole('heading', { name: 'Détails de la pesée', exact: true });
  await details.waitFor();
  await page.locator('#detail-actions').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByText('Cet élément a été supprimé.', { exact: true }).waitFor();
  await dismissNotificationBanner(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();

  const originalDate = await receipt.locator('small').innerText();
  await receipt.click();
  await details.waitFor();
  await page.getByText('Cet élément a été supprimé.', { exact: true }).waitFor();
  await page.locator('.toolbar').getByRole('button', { name: 'Restaurer', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const archive = page.locator('.notification-item').filter({ hasText: 'Pesée supprimée' });
  await archive.getByRole('button', { name: 'Supprimer définitivement la notification' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await archive.waitFor({ state: 'hidden' });
  await receipt.click();
  const pending = page.locator('#pending-actions');
  await pending.getByRole('button', { name: 'Attribuer la pesée' }).waitFor();
  await page.waitForURL('**/#measurements');
  const geometry = await pending.locator('.notice').evaluate(node => {
    const view = document.querySelector('#view').getBoundingClientRect();
    const { left, right, top } = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { fullWidth: left === view.left && right === view.right, first: top === view.top,
      radius: style.borderRadius, margin: style.margin, padding: parseFloat(style.paddingLeft) };
  });
  assert.equal(geometry.fullWidth, true);
  assert.equal(geometry.first, true);
  assert.equal(geometry.radius, '0px');
  assert.equal(geometry.margin, '0px');
  assert.ok(geometry.padding > 0);
  assert.ok((await pending.innerText()).includes(originalDate));
  assert.equal(await page.locator('#notices').getByText('Pesée reçue', { exact: true }).count(), 0);

  const icon = page.getByRole('button', { name: 'Notifications', exact: true });
  await icon.click();
  const logEntry = page.locator('.notification-item').filter({ hasText: 'Pesée reçue' });
  await receipt.waitFor();
  assert.equal(await logEntry.count(), 1);
  assert.equal(await logEntry.getByRole('button', { name: 'Attribuer la pesée' }).count(), 0);
  assert.equal(await logEntry.getByRole('button', { name: 'Ignorer la pesée' }).count(), 0);
  await receipt.click();
  await pending.getByRole('button', { name: 'Ignorer la pesée' }).click();
  await pending.waitFor({ state: 'hidden' });

  await icon.click();
  const ignored = page.locator('.notification-item').getByRole('button', { name: /^Pesée ignorée/ });
  await ignored.waitFor();
  assert.equal(await receipt.count(), 0);
  assert.equal(await ignored.locator('small').innerText(), originalDate);
  await ignored.click();
  await pending.getByRole('button', { name: 'Attribuer la pesée' }).waitFor();
  assert.ok((await pending.innerText()).includes(originalDate));
});

test('un appareil lié disparu ouvre sa carte de restauration et revient à sa fiche dans la liste', async t => {
  const page = await pageWith(t, { devices: [device] });
  await choosePage(page, 'Appareils');
  const toolbar = page.locator('.toolbar');
  const notices = page.locator('#notices');
  await page.getByRole('button', { name: 'Modifier', exact: true }).click();
  await page.getByLabel('Nom de l’appareil').fill('Balance cuisine');
  await toolbar.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await notices.getByText('Appareil enregistré', { exact: true }).waitFor();
  await dismissNotificationBanner(page);

  const live = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Balance cuisine', exact: true }) });
  const id = await live.getAttribute('id');
  await live.getByRole('button', { name: 'Modifier', exact: true }).click();
  await toolbar.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.locator('.notification-item').getByRole('button', { name: /^Appareil enregistré/ }).click();
  await page.locator('.list-item').getByText(address, { exact: true }).waitFor();

  const commands = toolbar.locator('#detail-actions').getByRole('button');
  assert.deepEqual(await commands.allTextContents(), ['Retour', 'Restaurer']);
  await commands.last().click();
  await page.waitForURL(url => url.hash === '#' + id);
  await live.getByText(address, { exact: true }).waitFor();
  assert.equal(await live.evaluate(card => document.activeElement === card), true);
  const restored = notices.getByText('Appareil restauré', { exact: true });
  await restored.waitFor();
  await restored.waitFor({ state: 'hidden', timeout: 4500 });

  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const archived = page.locator('.notification-item').filter({ hasText: 'Appareil supprimé' });
  await archived.getByText(/^Restauré le \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/).waitFor();
});

test('the account dialog keeps the interface language across sign-in and sign-out', async t => {
  await buildWeb();
  let languagePreference;
  const snapshot = { profiles: [], devices: [], measurements: [], pending: [], notifications: [] };
  const page = await pageWith(t, route => {
    const { action, args } = route.request().postDataJSON();
    if (action === 'setLanguagePreference') languagePreference = args[0];
    if (action === 'loadLanguagePreference') return route.fulfill({ json: { languagePreference } });
    if (action === 'pendingTransactions') return route.fulfill({ json: [] });
    return route.fulfill({ json: { ...snapshot, languagePreference } });
  }, { locale: 'en-US' }, 'web', page => page.route('https://sync.epi.test/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    const responses = {
      '/v1/device-tokens': { token: 'device-token', locale: 'de', googleLocale: 'it' },
      '/v1/account': { email: 'user@example.org', locale: 'de' },
      '/v1/transactions/pending': { transactions: [], next: null },
    };
    return route.fulfill({ json: responses[path] });
  }));

  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const dialog = page.locator('#account-dialog');
  assert.equal(await dialog.getByLabel('Language', { exact: true }).inputValue(), 'en-US');
  await dialog.getByLabel('Language', { exact: true }).selectOption('fr-CA');
  await page.locator('html[lang="fr-CA"]').waitFor({ state: 'attached' });
  assert.equal(languagePreference, 'fr-CA');

  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  await dialog.locator('[name=email]').fill('user@example.org');
  await dialog.locator('[name=password]').fill('test-password');
  await dialog.locator('#account-submit').click();
  await dialog.getByText('user@example.org', { exact: true }).waitFor();
  const language = dialog.getByLabel('Langue', { exact: true });
  assert.equal(await language.inputValue(), 'fr-CA');

  await language.selectOption('fr-FR');
  await page.locator('html[lang="fr-FR"]').waitFor({ state: 'attached' });
  assert.equal(languagePreference, 'fr-FR');
  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  await dialog.getByText('user@example.org', { exact: true }).waitFor();
  assert.equal(await language.inputValue(), 'fr-FR');
  await dialog.locator('#account-submit').click();
  await dialog.locator('[name=email]').waitFor();
  await page.reload();
  await page.locator('html[lang="fr-FR"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  assert.equal(await language.inputValue(), 'fr-FR');
});

test('account registration suggests the detected language and saves Canadian French', async t => {
  const page = await pageWith(t, undefined, { locale: 'en-US' });
  const requests = [];
  await page.route('https://sync.epi.test/v1/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/accounts') requests.push(route.request().postDataJSON());
    const responses = {
      '/v1/google/config': { enabled: false },
      '/v1/accounts': { email: 'user@example.org' },
      '/v1/device-tokens': { token: 'device-token', locale: 'fr-CA', googleLocale: 'de' },
      '/v1/account': { email: 'user@example.org', locale: 'fr-CA', googleAvailable: false },
    };
    return route.fulfill({ json: responses[path], headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  const language = page.getByLabel('Language', { exact: true });
  assert.equal(await language.inputValue(), 'en-US');
  const labels = await language.locator('option').allTextContents();
  assert.equal(labels.length, 26);
  assert.deepEqual(labels, [...labels].sort((first, second) => first.localeCompare(second, 'en-US')));
  assert.ok(labels.includes('English (UK)'));
  assert.ok(labels.includes('English (US)'));
  await language.selectOption('fr-CA');
  await page.getByLabel('Email address').fill('user@example.org');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.locator('html[lang="fr-CA"]').waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Compte', exact: true }).click();
  await page.getByText('user@example.org', { exact: true }).waitFor();
  assert.equal(requests[0].locale, 'fr-CA');
});
