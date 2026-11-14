import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

let browser;
const url = 'http://localhost:1420/';
const types = new Map([['html', 'text/html'], ['js', 'application/javascript'], ['css', 'text/css']]);
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
  await build({ build: { outDir }, logLevel: 'error' });
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

async function pageWith(t, snapshot, options = {}) {
  const page = await browser.newPage(options);
  page.setDefaultTimeout(10000);
  await page.route(url + '**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^(?:index\.html|assets\/[\w.-]+)$/.test(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(join(outDir, file)), contentType: types.get(file.split('.').at(-1)) });
  });
  page.on('pageerror', error => t.diagnostic(error.stack));
  page.on('response', response => {
    if (response.status() >= 400) t.diagnostic(`${response.status()} ${response.url()}`);
  });
  t.after(() => page.context().close());
  if (snapshot) {
    await page.addInitScript(state => {
      sessionStorage.seeded ??= '';
      if (!sessionStorage.seeded) {
        localStorage.setItem('epi-session-v1', JSON.stringify(state));
        sessionStorage.seeded = 'yes';
      }
    }, snapshot);
  }
  await page.goto(url);
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  return page;
}

const choosePage = (page, label) => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
const chosenProfile = page => page.getByRole('combobox', { name: 'Profil actif' }).inputValue();
const feed = (page, line) => page.evaluate(value => window.dispatchEvent(new CustomEvent('epi:frame', { detail: value })), line);

test('sélection et mise à jour du profil, persistance des colonnes et comparaison des méthodes', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Bob', devices: [device], measurements: [record] });
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByRole('columnheader', { name: 'Date', exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Poids', exact: true }).waitFor();
  await table.getByText('70 kg', { exact: true }).waitFor();
  await page.getByText('Colonnes', { exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Recherche' });
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
  await search.fill('% GRASSE masse');
  assert.equal(await options.count(), 1);
  await page.getByLabel('Masse grasse (%)', { exact: true }).check();
  await table.getByText('32,45', { exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).waitFor();
  await table.getByRole('button', { name: 'Masse grasse (%)', exact: true }).click();
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();
  assert.deepEqual(await table.locator('thead tr').nth(1).locator('th').allTextContents(), ['Moyenne', '● Mi', '⬣ Deu']);
  assert.equal(await table.getByText('32,45', { exact: true }).count(), 1);
  await table.getByText('31,8', { exact: true }).dragTo(table.getByText('70 kg', { exact: true }));
  const columnOrder = () => table.locator('thead tr').first().locator('th').evaluateAll(headers =>
    headers.map(header => header.dataset.dragColumn));
  assert.deepEqual(await columnOrder(), ['date', 'fatPercent', 'weight', 'impedanceOhms', 'bmi']);
  await table.getByRole('columnheader', { name: 'Deu', exact: true }).waitFor();
  await table.getByText('31,8').waitFor();
  await page.getByRole('button', { name: 'Rassembler Masse grasse (%)', exact: true }).click();
  await table.getByText('32,45', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Éclater Masse grasse (%)', exact: true }).click();
  await search.fill('');
  await page.getByLabel('Impédance (Ω)', { exact: true }).uncheck();
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Bob');
  assert.equal(await page.getByLabel('Impédance (Ω)', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Masse grasse (%)', { exact: true }).isChecked(), false);
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();
  assert.equal(await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).count(), 0);
  await table.getByRole('cell', { name: '70 kg', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const detail = page.getByRole('region', { name: 'Détails de la pesée' });
  const comparison = detail.getByRole('table', { name: 'Comparaison des méthodes' });
  assert.equal(await dialog.count(), 0);
  assert.equal(await table.count(), 0);
  await page.setViewportSize({ width: 1800, height: 900 });
  assert.ok(await comparison.evaluate(node => node.clientWidth > 1340));
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
  await methodHeaders.filter({ hasText: 'Deu' }).dragTo(methodHeaders.filter({ hasText: 'IMC' }));
  assert.deepEqual(await methodHeaders.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  const legend = detail.locator('.legend a');
  assert.match(await legend.first().textContent(), /Deu/);
  const fatRow = comparison.getByRole('row').filter({ hasText: 'Masse grasse (%)' });
  assert.equal(await fatRow.getByRole('cell').first().textContent(), '32,45');
  const toolbar = page.locator('.toolbar');
  assert.equal(await toolbar.getByRole('button', { name: 'Export ZIP' }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: 'Import ZIP' }).count(), 0);
  await toolbar.getByRole('button', { name: 'Retour' }).click();
  assert.equal(await table.getByRole('button', { name: /^Voir la pesée du/ }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await toolbar.locator('button:visible').allTextContents(), ['Export ZIP', 'Import ZIP']);
  assert.equal(await detail.count(), 0);
  await table.getByRole('columnheader', { name: 'Mi', exact: true }).waitFor();

  await choosePage(page, 'Profils');
  await page.getByRole('article').filter({ hasText: 'Alice' }).getByRole('button', { name: 'Modifier' }).click();
  assert.equal(await dialog.getByRole('textbox', { name: 'Nom', exact: true }).evaluate(el => el.readOnly), true);
  await dialog.getByLabel('Taille (cm)').fill('168');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText(/168 cm/).waitFor();
  await page.reload();
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alice');
  await choosePage(page, 'Mesures');
  await table.getByRole('columnheader', { name: 'Masse grasse (%)', exact: true }).waitFor();
  await table.getByRole('columnheader', { name: 'Deu', exact: true }).waitFor();
  await table.getByRole('button', { name: /^Voir la pesée du/ }).click();
  assert.deepEqual(await methodHeaders.evaluateAll(nodes => nodes.map(node => node.dataset.dragColumn)), ['Deu', 'IMC', 'Mi']);
  await page.getByRole('button', { name: 'Retour' }).click();
  assert.deepEqual(await columnOrder(), ['date', 'fatPercent', 'weight', 'bmi']);
  assert.equal(await table.getByRole('columnheader', { name: 'Impédance (Ω)', exact: true }).count(), 0);
});

test('le détail fixe la colonne Donnée et les en-têtes pendant le défilement', async t => {
  const calculations = Object.fromEntries(['IMC', 'Mi', 'Sun*', 'Jan*', 'D60*', 'Deu', 'CUN', 'Wat', 'HW', 'MSJ', 'HB', 'Owe', 'Cun*']
    .map(id => [id, { bmi: 25.7, fatPercent: 31.8, fatKg: 20, leanKg: 50, waterL: 37, restingEnergy: 1500 }]));
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice', measurements: [{ ...record, calculations }] },
    { viewport: { width: 420, height: 380 } });
  await page.getByRole('button', { name: /^Voir la pesée du/ }).click();
  const result = await page.locator('.comparison-scroll').evaluate(panel => {
    const corner = panel.querySelector('thead th');
    const header = panel.querySelector('thead th:nth-child(2)');
    const rowHeader = panel.querySelector('tbody tr:last-child th');
    const initial = corner.getBoundingClientRect();
    panel.scrollLeft = 200;
    panel.scrollTop = 100;
    return {
      scrolled: panel.scrollLeft > 0 && panel.scrollTop > 0,
      cornerFixed: corner.getBoundingClientRect().x === initial.x && corner.getBoundingClientRect().y === initial.y,
      headerFixed: header.getBoundingClientRect().y === initial.y,
      rowHeaderFixed: rowHeader.getBoundingClientRect().x === initial.x,
    };
  });
  assert.deepEqual(result, { scrolled: true, cornerFixed: true, headerFixed: true, rowHeaderFixed: true });
});

test('dates selon la locale active et conservation de la date de naissance et de l’horloge de la balance', async t => {
  const birthDate = '1980-01-05';
  const scaleTime = '2026-03-08T02:15:00';
  const profile = { ...alice, birthDate };
  const measurement = { ...record, profile, reception: { scale: { scaleTime } } };
  const page = await pageWith(t, { profiles: [profile], selectedProfile: 'Alice', measurements: [measurement] },
    { locale: 'en-US', timezoneId: 'America/Los_Angeles' });

  await page.getByRole('button', { name: /Voir la pesée du 1\/15\/26, 9:23:21/ }).click();
  await page.getByText(/^3\/8\/26, 2:15:00/).waitFor();
  await page.getByText('1/5/80', { exact: true }).waitFor();
  await choosePage(page, 'Profils');
  await page.getByText(/Naissance : 1\/5\/80/).waitFor();
});

test('capture et renommage, attribution automatique et flux brut horodaté', async t => {
  const page = await pageWith(t, { profiles: [alice, bob], selectedProfile: 'Bob', measurements: [record] }, { locale: 'fr-FR' });
  await choosePage(page, 'Appareils');
  await page.getByRole('button', { name: 'Ajouter un appareil' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nom de l’appareil').fill('Balance Xiaomi');
  await dialog.getByRole('button', { name: 'Démarrer la capture' }).click();
  await page.getByText(/En attente d’une pesée/).waitFor();
  await feed(page, metadata);
  await feed(page, frame);
  await page.getByRole('heading', { name: 'Balance Xiaomi', exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alice');
  await page.getByText('Flux Bluetooth brut').click();
  await page.locator('#raw-frames').filter({ hasText: /\[\d[^\]]*\d{2}:\d{2}:\d{2}\] AABBCCDDEEFF -58/ }).waitFor();
  await page.getByRole('button', { name: 'Renommer' }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('textbox').count(), 1);
  await dialog.getByText(address, { exact: true }).waitFor();
  await dialog.getByLabel('Nom de l’appareil').fill('Balance maison');
  await dialog.getByRole('button', { name: 'Démarrer la capture' }).click();
  await page.getByText(/En attente d’une pesée/).waitFor();
  await feed(page, frame);
  await page.getByRole('heading', { name: 'Balance maison', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Écouter seulement cet appareil' }).click();
  await page.getByText(/Écoute limitée à/).waitFor();
  await page.getByRole('button', { name: 'Écouter tous les appareils' }).click();
  await page.getByRole('button', { name: 'Écouter tous les appareils' }).waitFor({ state: 'hidden' });
  await choosePage(page, 'Mesures');
  await page.getByRole('table').getByText('70,85 kg', { exact: true }).waitFor();
  assert.equal(await page.getByRole('table').getByText('70,85 kg', { exact: true }).count(), 1);
});

test('confirmation sur smartphone, création de profil depuis une pesée et historique redimensionnable', async t => {
  const page = await pageWith(t, { profiles: [bob], selectedProfile: 'Bob', devices: [device] },
    { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await feed(page, frame);
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Créer un profil' }).click();
  await dialog.getByRole('textbox', { name: 'Nom', exact: true }).fill('Camille');
  await dialog.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await dialog.getByLabel('Âge utilisé par les formules').selectOption('age');
  await dialog.getByLabel('Âge (ans)', { exact: true }).fill('35');
  await dialog.getByLabel('Taille (cm)').fill('171');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Camille');
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByText('70,85 kg', { exact: true }).waitFor();
  await page.getByText('Colonnes', { exact: true }).click();
  for (const label of ['Masse grasse (%)', 'Énergie au repos (kcal/j)', 'Horloge de la balance']) {
    await page.getByLabel(label, { exact: true }).check();
  }
  const scroll = page.getByRole('region', { name: 'Pesées' });
  assert.equal(await scroll.evaluate(node => node.scrollWidth > node.clientWidth), true);
  await table.getByRole('cell', { name: '70,85 kg', exact: true }).tap();
  const comparison = page.getByRole('region', { name: 'Comparaison des méthodes' });
  assert.ok(await comparison.evaluate(node => node.scrollWidth > node.clientWidth));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth), true);
});

test('archive ZIP exportée, réimportée et idempotente dans le navigateur', async t => {
  const source = await pageWith(t, { profiles: [alice], devices: [device], measurements: [record] });
  const downloadEvent = source.waitForEvent('download');
  await source.getByRole('button', { name: 'Export ZIP' }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /^epi-data-\d{4}-\d{2}-\d{2}\.zip$/);
  const data = await download.createReadStream();
  const bytes = [];
  for await (const chunk of data) bytes.push(chunk);
  const archive = { name: download.suggestedFilename(), mimeType: 'application/zip', buffer: Buffer.concat(bytes) };

  const page = await pageWith(t);
  await page.locator('#import-files').setInputFiles(archive);
  await page.getByText('Import terminé.', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByText('70 kg', { exact: true }).waitFor();
  await page.locator('#import-files').setInputFiles(archive);
  await page.getByText('Import terminé.', { exact: true }).waitFor();
  assert.equal(await table.getByText('70 kg', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('combobox', { name: 'Profil actif' }).getByRole('option', { name: 'Alice' }).count(), 1);
  await page.locator('#import-files').setInputFiles({ name: 'incorrect.zip', mimeType: 'application/zip', buffer: Buffer.from('Invalid ZIP') });
  await page.getByRole('alert').waitFor();
});

test('appareil détecté sans capture, attribution confirmée et calcul temporaire', async t => {
  const elise = { ...alice, name: 'Élise' };
  const zoe = { ...alice, name: 'zoé' };
  const page = await pageWith(t, { profiles: [zoe, elise, bob, alice], selectedProfile: 'Alice' });
  const profileNames = ['Alice', 'Bob', 'Élise', 'zoé'];
  assert.deepEqual((await page.locator('#profile option').allTextContents()).slice(1), profileNames);
  await feed(page, frame);
  await page.getByRole('button', { name: 'Enregistrer l’appareil' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nom de l’appareil').fill('Xiaomi');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  assert.deepEqual((await dialog.locator('#assignment-profile option').allTextContents()).slice(2), profileNames);
  await dialog.getByLabel('Profil', { exact: true }).selectOption('Bob');
  await dialog.getByRole('button', { name: 'Confirmer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Bob');
  await page.getByRole('table').getByText('70,85 kg').waitFor();

  await feed(page, 'AABBCCDDEEFF -62 181D 00404C');
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  await dialog.getByRole('button', { name: 'Calculer sans profil' }).click();
  await dialog.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await dialog.getByLabel('Date de naissance', { exact: true }).fill('1994-01-15');
  await dialog.getByLabel('Taille (cm)').fill('170');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Bob');
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('');
  await page.getByRole('table').getByText('97,6 kg', { exact: true }).waitFor();
  assert.equal(await page.getByText('Colonnes', { exact: true }).count(), 0);
  await page.getByRole('table').getByRole('columnheader', { name: 'IMC (kg/m²)', exact: true }).waitFor();
});
