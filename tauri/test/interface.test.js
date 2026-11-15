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

test('the toolbar profile icon creates the first profile, then opens the profiles screen', async t => {
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
  assert.equal(await picker.inputValue(), 'Alice');
  await page.getByRole('button', { name: 'Ouvrir les profils' }).click();
  await page.waitForURL('**/#profiles');
  await page.getByRole('heading', { name: 'Profils', exact: true }).waitFor();
  assert.equal(await page.locator('#profile').evaluate(select => select === document.activeElement), false);
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
const chosenProfile = page => page.getByRole('combobox', { name: 'Profil actif' }).inputValue();
const feed = (page, line) => page.evaluate(value => window.dispatchEvent(new CustomEvent('epi:frame', { detail: value })), line);

test('central views use the same spacing above and below the header', async t => {
  const page = await pageWith(t, {
    profiles: [alice], devices: [device], selectedProfile: 'Alice', measurements: [record],
  });

  await page.getByText('Colonnes', { exact: true }).click();
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
  const editor = page.locator('#editor-view');
  const save = async name => {
    await saveButton.click();
    if (name) await editor.getByLabel('Nom').fill(name);
    await page.locator('.toolbar').getByRole('button', { name: 'Sauvegarder', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
  };
  await page.getByText('Colonnes', { exact: true }).click();
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

  await page.getByText('Colonnes', { exact: true }).click();
  await fat.uncheck();
  assert.equal((await title.textContent()).trim(), 'Compact *');
  await title.click();
  assert.deepEqual(await options.getByRole('button').allTextContents(), ['Pesées', 'Compact']);
  await options.getByRole('button', { name: 'Compact', exact: true }).click();
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
  await page.getByText('Colonnes', { exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Recherche' });
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
  await page.getByLabel('Impédance (Ω)', { exact: true }).uncheck();
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Bob');
  assert.equal(await page.getByLabel('Impédance (Ω)', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Masse grasse (%)', { exact: true }).isChecked(), false);
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('Alice');
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
  assert.equal(await editor.getByRole('textbox', { name: 'Nom', exact: true }).evaluate(el => el.readOnly), true);
  await editor.getByLabel('Taille (cm)').fill('168');
  await page.locator('.toolbar').getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText(/168 cm/).waitFor();
  await page.reload();
  await page.getByText('Mode simulation', { exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alice');
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

test('sur Android, Recherche apparaît à droite de Colonnes sans prendre le focus', async t => {
  const page = await pageWith(t, { profiles: [alice], selectedProfile: 'Alice' }, {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
    viewport: { width: 360, height: 800 },
  });
  const columns = page.getByText('Colonnes', { exact: true });
  const search = page.getByRole('searchbox', { name: 'Recherche' });
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
  await page.getByText('Colonnes', { exact: true }).click();
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
  await page.getByRole('heading', { name: 'Balance capturée', exact: true }).waitFor();
  assert.equal(await page.getByText(/En attente d’une pesée/).count(), 0);
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
  await page.getByRole('heading', { name: 'Balance Xiaomi', exact: true }).waitFor();
  assert.equal(await chosenProfile(page), 'Alice');
  await page.getByText('Flux Bluetooth brut').click();
  await page.locator('#raw-frames').filter({ hasText: /\[\d[^\]]*\d{2}:\d{2}:\d{2}\] AABBCCDDEEFF -58/ }).waitFor();
  await page.getByRole('button', { name: 'Renommer' }).click();
  await editor.getByRole('heading', { name: 'Renommer' }).waitFor();
  assert.equal(await editor.getByRole('textbox').count(), 1);
  await editor.getByText(address, { exact: true }).waitFor();
  const name = editor.getByLabel('Nom de l’appareil');
  assert.equal(await name.evaluate(input => input === document.activeElement), true);
  await name.fill('Balance maison');
  await page.locator('.toolbar').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  const renamed = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Balance maison', exact: true }) });
  await renamed.getByText(address, { exact: true }).waitFor();
  assert.equal(await page.getByText(/En attente d’une pesée/).count(), 0);
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
  await createProfile.tap();
  await editor.getByRole('textbox', { name: 'Nom', exact: true }).fill('Camille');
  await editor.getByLabel('Sexe utilisé par les formules').selectOption('F');
  await editor.getByLabel('Âge utilisé par les formules').selectOption('age');
  await editor.getByLabel('Âge (ans)', { exact: true }).fill('35');
  await editor.getByLabel('Taille (cm)').fill('171');
  await toolbar.getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Camille');
  const table = page.getByRole('table', { name: 'Pesées' });
  await table.getByText('70,9 kg', { exact: true }).waitFor();
  await page.getByText('Colonnes', { exact: true }).click();
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
  const bobWithSurname = { ...bob, name: 'Bob Martin' };
  const page = await pageWith(t, { profiles: [zoe, elise, bobWithSurname, alice], selectedProfile: 'Alice' }, { hasTouch: true });
  const profileNames = ['Alice', 'Bob Martin', 'Élise', 'zoé'];
  assert.deepEqual((await page.locator('#profile option').allTextContents()).slice(1), profileNames);
  await feed(page, frame);
  await page.getByRole('button', { name: 'Enregistrer l’appareil' }).click();
  const editor = page.locator('#editor-view');
  const toolbar = page.locator('.toolbar');
  await editor.getByLabel('Nom de l’appareil').fill('Xiaomi');
  await toolbar.getByRole('button', { name: 'Enregistrer' }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
  const profiles = editor.getByRole('list', { name: 'Profils' });
  assert.deepEqual(await profiles.locator('.assignment-name').allTextContents(), ['Alice', 'Bob', 'Élise', 'zoé']);
  await profiles.getByRole('button', { name: 'Bob Sélectionner', exact: true }).getByText('Bob', { exact: true }).tap();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await chosenProfile(page), 'Bob Martin');
  await page.getByRole('table').getByText('70,9 kg').waitFor();

  await feed(page, 'AABBCCDDEEFF -62 181D 00404C');
  await page.getByRole('button', { name: 'Attribuer la pesée' }).click();
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
  await page.getByRole('combobox', { name: 'Profil actif' }).selectOption('');
  await page.getByRole('table').getByText('97,6 kg', { exact: true }).waitFor();
  assert.equal(await page.getByText('Colonnes', { exact: true }).count(), 0);
  await page.getByRole('table').getByRole('columnheader', { name: 'IMC (kg/m²)', exact: true }).waitFor();
});
