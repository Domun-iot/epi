import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
import domain from '../domain/session.cjs';

const origin = 'http://localhost:1448';
const api = 'https://accounts.browser.test';
const accountId = '11111111-1111-4111-8111-111111111111';
const dataKey = 'epi-browser-storage-v1';
let browser, temporary;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'epi-shared-browser-'));
  await build({ root: fileURLToPath(new URL('..', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    mode: 'hosted', logLevel: 'error', build: { outDir: temporary },
    define: { __DEV_ACCOUNT_API__: JSON.stringify(api) },
    plugins: [{ name: 'expose-session-for-storage-tests', transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/main.js')) return code
        + '\nwindow.epiTest = { session, account: await import("./account.js") };';
    } }],
  });
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => { await browser?.close(); if (temporary) await rm(temporary, { recursive: true, force: true }); });

async function fixture(t, { paid = false } = {}) {
  const requests = [], sessions = new Map();
  let online = true;
  const info = () => ({ accountId, email: 'alice@example.org', paid, paidUntil: paid ? '2099-01-01T00:00:00.000Z' : null });
  async function open(existing) {
    const context = existing ?? await browser.newContext({ locale: 'fr-FR' });
    if (!existing) t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.route(origin + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/session') {
        const body = route.request().postDataJSON();
        requests.push({ path: pathname, ...body });
        if (!paid) return route.fulfill({ status: 403, json: { error: 'pro_required' } });
        if (!sessions.has(accountId)) {
          let state;
          const session = domain.createSession({ hasProViews: () => paid, storage: { load: () => state, save: value => { state = value; } } });
          await session.load(); sessions.set(accountId, session);
        }
        return route.fulfill({ json: await sessions.get(accountId)[body.action](...body.args) });
      }
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^(?:index.html|assets\/[\w.-]+)$/u.test(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ body: await readFile(join(temporary, file)),
        contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    });
    await page.route(api + '/v1/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      requests.push({ path: pathname });
      if (!online) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
      if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
      if (pathname === '/v1/device-tokens') return route.fulfill({ json: { token: 'alice-token', ...info() } });
      if (pathname === '/v1/account') return route.fulfill({ json: info() });
      if (!paid) return route.fulfill({ status: 403, json: { error: 'pro_required' } });
      if (pathname === '/v1/dataset') return route.fulfill({ json: { accountId, files: [],
        summary: { count: 0, from: null, to: null, hasData: false }, revision: 'a'.repeat(64) } });
      if (pathname === '/v1/transactions') {
        const rows = route.request().postData().trim().split('\n').map(line => JSON.parse(line));
        return route.fulfill({ json: { uuids: rows.map(row => row.uuid) } });
      }
      return route.fulfill({ json: { transactions: [] } });
    });
    page.on('pageerror', error => t.diagnostic(error.stack));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.epiTest?.session));
    return page;
  }
  async function login(page) {
    if (!await page.locator('#account-dialog').isVisible()) await page.locator('#account-button').click();
    await page.locator('[name=email]').fill('alice@example.org');
    await page.locator('[name=password]').fill('test-password');
    await page.locator('#account-submit').click();
    await page.waitForFunction(() => Boolean(window.epiTest.account.getSavedAccount()?.token));
    await page.locator('#account-close').click();
  }
  return { open, login, requests, rights: value => { paid = value; }, offline: () => { online = false; } };
}
const save = page => page.evaluate(() => window.epiTest.session.saveProfile({ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }));
const state = page => page.evaluate(() => window.epiTest.session.load());
const mode = page => page.evaluate(() => window.epiTest.session.storageMode);
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), dataKey);

test('shared web opens anonymously; guest data stays local after FREE login and browser restart', async t => {
  const f = await fixture(t), page = await f.open();
  assert.equal(await page.locator('.shell').isVisible(), true);
  assert.equal(await page.locator('#account-dialog').isVisible(), false);
  assert.equal(await stored(page), null);
  await save(page);
  assert.equal((await stored(page)).usageLocal, true);
  await f.login(page);
  assert.equal(await mode(page), 'browser-local');
  assert.equal((await state(page)).profiles[0].name, 'Alice');
  await page.reload(); await page.waitForFunction(() => Boolean(window.epiTest?.session));
  await page.waitForFunction(() => window.epiTest.account.isOnlineAccountVerified());
  assert.equal((await state(page)).profiles[0].name, 'Alice');
  assert.equal(f.requests.some(row => row.path === '/api/session' || row.path === '/v1/dataset' || row.path.startsWith('/v1/transactions')), false);
});

test('confirmed FREE pins an empty browser and subsequent PRO stays local with transaction sync', async t => {
  const f = await fixture(t), page = await f.open();
  await f.login(page);
  assert.equal((await stored(page)).usageLocal, true);
  assert.equal(await mode(page), 'browser-local');
  assert.equal(f.requests.some(row => row.path === '/api/session'), false);
  f.rights(true);
  await page.evaluate(() => window.epiTest.account.checkAccountConnection());
  await page.waitForFunction(key => Object.values(JSON.parse(localStorage.getItem(key)).datasets).some(data => data.syncReady), dataKey);
  await save(page);
  await page.waitForFunction(key => Object.values(JSON.parse(localStorage.getItem(key)).datasets).some(data => Object.keys(data.sent).length), dataKey);
  assert.equal(await mode(page), 'browser-local');
  assert.equal(f.requests.some(row => row.path === '/v1/transactions'), true);
  assert.equal(f.requests.some(row => row.path === '/api/session'), false);
});

test('fresh PRO browsers use the same API dataset without a local mode flag', async t => {
  const f = await fixture(t, { paid: true }), first = await f.open();
  await f.login(first);
  assert.equal(await mode(first), 'hosted-api');
  await save(first);
  assert.equal(await stored(first), null);
  const second = await f.open();
  await f.login(second);
  assert.equal(await mode(second), 'hosted-api');
  assert.equal((await state(second)).profiles[0].name, 'Alice');
  assert.equal(await stored(second), null);
  assert.equal(f.requests.some(row => row.path === '/v1/dataset' || row.path.startsWith('/v1/transactions')), false);
});

test('a confirmed downgrade seeds the visible remote dataset into local storage and stops API writes', async t => {
  const f = await fixture(t, { paid: true }), page = await f.open();
  await f.login(page); await save(page);
  f.rights(false);
  await page.evaluate(() => window.epiTest.account.checkAccountConnection());
  await page.waitForFunction(() => window.epiTest.session.storageMode === 'browser-local');
  await page.waitForFunction(() => !document.querySelector('.shell').inert);
  assert.equal((await stored(page)).usageLocal, true);
  assert.equal((await state(page)).profiles[0].name, 'Alice');
  const calls = f.requests.filter(row => row.path === '/api/session').length;
  await page.evaluate(() => window.epiTest.session.saveProfile({ name: 'Bob', sex: 'H', age: 40, heightCm: 175 }));
  assert.equal(f.requests.filter(row => row.path === '/api/session').length, calls);
  assert.deepEqual((await state(page)).profiles.map(row => row.name).sort(), ['Alice', 'Bob']);
});

test('local browser data remains usable when verification becomes unavailable', async t => {
  const f = await fixture(t), page = await f.open();
  await f.login(page); await save(page);
  f.offline();
  await page.reload(); await page.waitForFunction(() => Boolean(window.epiTest?.session));
  assert.equal(await mode(page), 'browser-local');
  assert.equal((await state(page)).profiles[0].name, 'Alice');
  assert.equal(await page.locator('.shell').isVisible(), true);
});


test('opening a second FREE tab refreshes the first tab generation without locking out its data', async t => {
  const f = await fixture(t), first = await f.open();
  await f.login(first); await save(first);
  const second = await f.open(first.context());
  await second.waitForFunction(() => window.epiTest.account.isOnlineAccountVerified());
  await first.waitForFunction(async () => {
    if (document.querySelector('.shell').inert) return false;
    try { return (await window.epiTest.session.load()).profiles.length === 1; } catch { return false; }
  });
  assert.equal((await state(first)).profiles[0].name, 'Alice');
  assert.equal((await state(second)).profiles[0].name, 'Alice');
  assert.equal(f.requests.some(row => row.path === '/api/session'), false);
});
