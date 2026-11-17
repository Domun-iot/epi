import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const origin = 'http://localhost:1437';
const api = 'https://accounts.epi.test';
const accountId = 'b1800c21-2a45-4b03-9ccd-e80edc2bca2c';
const info = { email: 'alice@example.org', accountId, paid: true, paidUntil: '2099-01-01T00:00:00.000Z' };
let temporary;
let browser;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'epi-account-ui-'));
  const script = '<script type="module">import { initialiseLanguage } from "/src/i18n.js"; await initialiseLanguage(); '
    + 'const accounts = await import("/src/account.js"); const {chooseAccountData} = await import("/src/account-data-dialog.js"); '
    + 'window.accounts = accounts; window.chooseAccountData = chooseAccountData;</script>';
  await build({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)), plugins: [{name:'account-only-test',transformIndexHtml:{order:'pre',handler:html => html.replace('<script type="module" src="/src/bootstrap.js"></script>',script)}}], build: { outDir: join(temporary, 'public') },
    logLevel: 'error', define: { __DEV_ACCOUNT_API__: JSON.stringify(api) } });
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function open(t, { saved, response = info, time } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  t.after(() => context.close());
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^(?:index.html|assets\/[\w.-]+)$/.test(file)) return route.fulfill({status:404});
    const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    return route.fulfill({ body: await readFile(join(temporary,'public',file)), contentType });
  });
  await page.route(api + '/v1/**', route => {
    if (route.request().method() === 'DELETE') return route.fulfill({ status: 204 });
    if (route.request().url().endsWith('/device-tokens')) return route.fulfill({ json: { token: 'test-token', ...info } });
    return route.fulfill({ json: response });
  });
  if (saved) await page.addInitScript(({api,saved}) => localStorage.setItem('epi-account:' + api,JSON.stringify(saved)), {api,saved});
  if (time) await page.clock.install({time: new Date(time)});
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(window.accounts));
  return page;
}

async function login(page) {
  if (!await page.locator('#account-dialog').isVisible()) await page.locator('#account-button').click();
  await page.locator('[name=email]').fill('alice@example.org');
  await page.locator('[name=password]').fill('password');
  await page.locator('#account-submit').click();
}

// These cover the account boundary independently of filesystem and HTTP backend tests.
test('does not expose a new token until attachment is committed and leaves cancellation untouched', async t => {
  const page = await open(t);
  await page.evaluate(() => window.accounts.configureAccountDatasets({ beforeSignIn: () => new Promise(resolve => {window.finishAttachment=resolve;}) }));
  await login(page);
  await page.waitForFunction(() => Boolean(window.finishAttachment));
  assert.equal(await page.evaluate(api => localStorage.getItem('epi-account:' + api), api), null);
  await page.evaluate(() => window.finishAttachment(false));
  await page.locator('#account-submit:enabled').waitFor();
  assert.equal(await page.evaluate(api => localStorage.getItem('epi-account:' + api), api), null);
  await page.evaluate(() => window.accounts.configureAccountDatasets({beforeSignIn: async info => {window.attachedTo=info.accountId; return true;}}));
  await login(page);
  await page.waitForFunction(() => Boolean(window.accounts.getSavedAccount()));
  assert.equal(await page.evaluate(() => window.attachedTo), accountId);
  assert.equal(await page.evaluate(() => window.accounts.getAccountId()), accountId);
});

test('forced hosted login cannot be dismissed and never displays the application shell', async t => {
  const page = await open(t);
  await page.evaluate(() => window.accounts.setDatasetAccess({locked:true,hosted:true}));
  assert.equal(await page.locator('.shell').isVisible(), false);
  assert.equal(await page.locator('#account-close').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#account-dialog').isVisible(), true);
  assert.match(await page.locator('#account-access-notice').innerText(), /hébergées/);
  await page.evaluate(() => window.accounts.setDatasetAccess({locked:false,hosted:true}));
  assert.equal(await page.locator('.shell').isVisible(), true);
  assert.equal(await page.locator('#account-close').isVisible(), true);
});

test('offline expiry preserves dataset selection and cached PRO rights until online rejection', async t => {
  const page = await open(t, {saved:{email:info.email,token:'test-token',accountId,info}});
  await page.evaluate(() => window.accounts.configureAccountDatasets({ beforeSignOut: async () => {window.loggedOut=true;}, onExpired: async () => {window.expired=true;} }));
  await page.route(api + '/v1/account', route => route.abort());
  await page.evaluate(() => window.accounts.checkAccountConnection());
  assert.equal(await page.evaluate(() => window.accounts.isPaidAccount()), true);
  assert.equal(await page.evaluate(() => window.accounts.isOnlineAccountVerified()), false);
  assert.equal(await page.evaluate(() => Boolean(window.loggedOut)), false);
  await page.unroute(api + '/v1/account');
  await page.route(api + '/v1/account', route => route.fulfill({status:401,json:{error:'token_expired'}}));
  await page.evaluate(() => window.accounts.checkAccountConnection());
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount()), null);
  assert.equal(await page.evaluate(() => window.accounts.isPaidAccount()), false);
  assert.equal(await page.evaluate(() => Boolean(window.expired)), true);
  assert.equal(await page.evaluate(() => Boolean(window.loggedOut)), false);
});

test('explicit offline logout clears credentials and calls dataset deselection', async t => {
  const page = await open(t, {saved:{email:info.email,token:'test-token',accountId,info}});
  await page.route(api + '/v1/device-tokens', route => route.abort());
  await page.evaluate(() => window.accounts.configureAccountDatasets({ beforeSignOut: async () => {window.loggedOut=true; window.accounts.setDatasetAccess({locked:true,hosted:false});} }));
  await page.locator('#account-button').click();
  await page.locator('#account-submit').click();
  await page.waitForFunction(() => Boolean(window.loggedOut));
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount()), null);
  assert.equal(await page.locator('.shell').isVisible(), false);
  assert.equal(await page.locator('#account-dialog').isVisible(), true);
});

test('merge dialog displays both summaries and preserves explicit cancel, merge and remote choices', async t => {
  const page = await open(t);
  const summaries = {local:{count:12,from:'2025-01-01T00:00:00Z',to:'2025-12-31T23:59:00Z'},remote:{count:24,from:'2024-01-01T00:00:00Z',to:'2026-01-01T00:00:00Z'}};
  for (const choice of ['cancel','merge','remote']) {
    await page.evaluate(summaries => { window.selection = window.chooseAccountData(summaries); }, summaries);
    assert.equal(await page.locator('#account-data-local-count').innerText(), '12 pesées');
    assert.equal(await page.locator('#account-data-remote-count').innerText(), '24 pesées');
    assert.match(await page.locator('#account-data-local-period').innerText(), /2025/);
    await page.locator('#account-data-dialog button[value=' + choice + ']').click();
    assert.equal(await page.evaluate(() => window.selection), choice === 'cancel' ? null : choice);
  }
});


test('ignores an expired response from an old token and immediately locks the current hosted session', async t => {
  const page = await open(t, {saved:{email:info.email,token:'test-token',accountId,info}});
  await page.evaluate(() => {
    window.accounts.configureAccountDatasets({onExpired:async () => {window.expired=true;}});
    window.accounts.setDatasetAccess({locked:false,hosted:true});
    window.dispatchEvent(new CustomEvent('epi:session-expired',{detail:{token:'previous-account-token'}}));
  });
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount().token), 'test-token');
  assert.equal(await page.locator('.shell').isVisible(), true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('epi:session-expired',{detail:{token:'test-token'}})));
  await page.waitForFunction(() => Boolean(window.expired));
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount()), null);
  assert.equal(await page.locator('.shell').isVisible(), false);
  assert.equal(await page.locator('#account-dialog').isVisible(), true);
});

test('cached PRO rights expire offline at their verified deadline', async t => {
  const initial = '2026-11-17T10:00:00Z';
  const cached = {...info,paidUntil:'2026-11-17T10:00:30Z'};
  const page = await open(t, {time:initial,saved:{email:info.email,token:'test-token',accountId,info:cached}});
  await page.route(api + '/v1/account', route => route.abort());
  await page.evaluate(() => window.accounts.checkAccountConnection());
  assert.equal(await page.evaluate(() => window.accounts.isPaidAccount()), true);
  await page.clock.runFor(30_001);
  assert.equal(await page.evaluate(() => window.accounts.isPaidAccount()), false);
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount().accountId), accountId);
});


test('a silent dataset transition gates content without opening the account dialog', async t => {
  const page = await open(t);
  await page.evaluate(() => window.accounts.setDatasetAccess({locked:true,hosted:false,pending:true}));
  assert.equal(await page.locator('.shell').isVisible(), false);
  assert.equal(await page.locator('#account-dialog').isVisible(), false);
  await page.evaluate(() => window.accounts.setDatasetAccess({locked:false,hosted:false,pending:false}));
  assert.equal(await page.locator('.shell').isVisible(), true);
});

test('a token change in another tab cancels attachment and cannot restore its older login', async t => {
  const page = await open(t);
  await page.evaluate(() => window.accounts.configureAccountDatasets({beforeSignIn: () => window.chooseAccountData({local:{count:1},remote:{count:2}})}));
  await login(page);
  await page.locator('#account-data-dialog').waitFor();
  await page.evaluate(({api,info}) => {
    localStorage.setItem('epi-account:' + api,JSON.stringify({email:info.email,token:'newer-token',accountId:info.accountId,info}));
    window.dispatchEvent(new StorageEvent('storage',{key:'epi-account:' + api}));
  }, {api,info});
  await page.locator('#account-data-dialog').waitFor({state:'hidden'});
  await page.locator('#account-submit:enabled').waitFor();
  assert.equal(await page.evaluate(() => window.accounts.getSavedAccount().token), 'newer-token');
  assert.equal(await page.locator('.shell').isVisible(), false);
});


test('the hosted login language can change without reading or writing a locked dataset', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    window.accounts.enableLanguageSelection(async () => {throw new Error('private_dataset_accessed');});
    window.accounts.setDatasetAccess({locked:true,hosted:true});
  });
  await page.locator('#account-form [name=language]').selectOption('en-US');
  await page.locator('html[lang="en-US"]').waitFor({state:'attached'});
  assert.equal(await page.evaluate(() => localStorage.getItem('epi-interface-language')), 'en-US');
});
