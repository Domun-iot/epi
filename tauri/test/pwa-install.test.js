import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';
import { build } from 'vite';

let browser, server, root, base;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'epi-pwa-'));
  await build({ mode: 'hosted', build: { outDir: root }, logLevel: 'error' });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path === '/' ? '/index.html' : path;
    if (!/^\/(?:index\.html|manifest\.webmanifest|favicon\.ico|(?:assets|app-icons)\/[\w.-]+)$/.test(file)) return response.writeHead(404).end();
    try {
      response.writeHead(200, { 'Content-Type': types[extname(file)] });
      response.end(await readFile(join(root, file)));
    } catch { response.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (root) await rm(root, { recursive: true, force: true });
});

async function openInstaller(t, options = {}, setup) {
  const page = await browser.newPage({ locale: 'fr-FR', ...options });
  t.after(() => page.context().close());
  await page.route('https://**', route => route.abort());
  await setup?.(page);
  await page.goto(base + '/?install=1&keep=yes#measurements', { waitUntil: 'load' });
  await page.locator('.pwa-install-dialog[open]').waitFor();
  // The installer must be usable before account startup, including when signed out.
  assert.equal(await page.locator('#account-dialog[open]').count(), 0);
  return page;
}

test('captures installability at page load and prompts only on a click, allowing dismissal and a later retry', async t => {
  const page = await openInstaller(t, {}, page => page.addInitScript(() => {
    window.promptCalls = 0;
    window.offerInstall = outcome => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = async () => { window.promptCalls++; return { outcome }; };
      window.dispatchEvent(event);
    };
    window.addEventListener('load', () => window.offerInstall('dismissed'));
  }));
  const install = page.locator('[data-install-prompt]');
  await install.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.promptCalls), 0);
  await install.click();
  await install.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.promptCalls), 1);
  assert.equal(await page.locator('[data-install-guide]').isVisible(), true);
  await page.evaluate(() => window.offerInstall('accepted'));
  await install.click();
  await page.locator('[data-install-status]').filter({ hasText: 'éPI est installée' }).waitFor();
  assert.equal(await page.evaluate(() => window.promptCalls), 2);
  assert.equal(await page.locator('[data-install-guide]').isVisible(), false);
});

test('iPhone gets only its own steps and can continue to the app without logging in to install', async t => {
  const page = await openInstaller(t, {
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  assert.equal(await page.locator('[data-install-prompt]').isVisible(), false);
  assert.match(await page.locator('.pwa-steps').innerText(), /Partager/);
  assert.doesNotMatch(await page.locator('.pwa-steps').innerText(), /Dock|Caster|Applications/);
  assert.equal(await page.locator('.pwa-install-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.getByRole('button', { name: 'Continuer vers éPI' }).click();
  await page.locator('.pwa-install-dialog').waitFor({ state: 'detached' });
  assert.equal(new URL(page.url()).search, '?keep=yes');
  assert.equal(new URL(page.url()).hash, '#measurements');
  await page.locator('#theme-toggle:enabled').waitFor();
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }))), true);
});

test('ordinary app visits keep the browser’s default install promotion', async t => {
  const page = await browser.newPage({ locale: 'fr-FR' });
  t.after(() => page.context().close());
  await page.route('https://**', route => route.abort());
  await page.goto(base);
  await page.locator('#theme-toggle:enabled').waitFor();
  assert.equal(await page.locator('.pwa-install-dialog').count(), 0);
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }))), true);
});

test('a rejected browser prompt keeps manual instructions available', async t => {
  const page = await openInstaller(t);
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { throw new Error('unavailable'); };
    window.dispatchEvent(event);
  });
  await page.locator('[data-install-prompt]').click();
  await page.locator('[data-install-status]').filter({ hasText: 'n’a pas pu démarrer' }).waitFor();
  assert.equal(await page.locator('[data-install-guide]').isVisible(), true);
  assert.equal(await page.locator('[data-install-prompt]').isVisible(), false);
  await page.keyboard.press('Escape');
  await page.locator('.pwa-install-dialog').waitFor({ state: 'detached' });
});

test('standalone apps and browser installation events show the installed state', async t => {
  const page = await openInstaller(t, {}, page => page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
  }));
  assert.match(await page.locator('[data-install-status]').innerText(), /éPI est installée/);
  assert.equal(await page.locator('[data-install-prompt]').isVisible(), false);
  const other = await openInstaller(t);
  await other.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.match(await other.locator('[data-install-status]').innerText(), /éPI est installée/);
  assert.equal(await other.locator('[data-install-guide]').isVisible(), false);
});
