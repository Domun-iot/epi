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


test('cancelling Google while its completion response is pending never attaches or saves the ready token', async t => {
  const page = await open(t);
  let release;
  const held = new Promise(resolve=>{release=resolve;});
  t.after(release);
  await page.context().route('https://accounts.google.com/**',route=>route.fulfill({body:'Google sign-in'}));
  await page.route(api+'/v1/google/start',route=>route.fulfill({json:{state:'state',secret:'secret',url:'https://accounts.google.com/o/oauth2/v2/auth'}}));
  await page.route(api+'/v1/google/finish',async route=>{
    await held;
    await route.fulfill({json:{...info,token:'ready-google-token'}}).catch(()=>{});
  });
  await page.evaluate(()=>window.accounts.configureAccountDatasets({beforeSignIn:async()=>{window.attached=true;return true;}}));
  await page.locator('#account-button').click();
  const finishing=page.waitForRequest(api+'/v1/google/finish');
  await page.locator('#account-google').click();
  await finishing;
  await page.locator('#account-close').click();
  await page.locator('#account-submit:enabled').waitFor();
  release();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>Boolean(window.attached)),false);
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount()),null);
  assert.equal(await page.locator('#account-google-status').isVisible(),false);
});

test('an external account switch aborts Google management, clears secrets and ignores the old account locale', async t => {
  const aliceInfo={...info,googleLinked:false,hasPassword:true};
  const bobInfo={accountId:'b1800c21-2a45-4b03-9ccd-e80edc2bca2d',email:'bob@example.org',paid:false,paidUntil:null};
  const page=await open(t,{saved:{email:info.email,accountId,token:'alice-token',info:aliceInfo},response:aliceInfo});
  let release;
  const held=new Promise(resolve=>{release=resolve;});
  t.after(release);
  await page.context().route('https://accounts.google.com/**',route=>route.fulfill({body:'Google sign-in'}));
  await page.route(api+'/v1/account',route=>route.fulfill({json:route.request().headers().authorization==='Bearer bob-token'?bobInfo:aliceInfo}));
  await page.route(api+'/v1/google/start',route=>route.fulfill({json:{state:'state',secret:'secret',url:'https://accounts.google.com/o/oauth2/v2/auth'}}));
  await page.route(api+'/v1/google/finish',async route=>{
    await held;
    await route.fulfill({json:{...aliceInfo,googleLinked:true,locale:'fr-FR'}}).catch(()=>{});
  });
  await page.evaluate(()=>window.accounts.configureAccountDatasets({}));
  await page.locator('#account-button').click();
  await page.locator('#account-google').click();
  await page.locator('[name=googlePassword]').fill('Alice private password');
  const finishing=page.waitForRequest(api+'/v1/google/finish');
  await page.locator('#account-google').click();
  await finishing;
  await page.evaluate(({api,bobInfo})=>{
    localStorage.setItem('epi-account:'+api,JSON.stringify({email:bobInfo.email,accountId:bobInfo.accountId,token:'bob-token',info:bobInfo}));
    window.dispatchEvent(new StorageEvent('storage',{key:'epi-account:'+api}));
  },{api,bobInfo});
  await page.locator('#account-submit:enabled').waitFor();
  assert.equal(await page.locator('[name=googlePassword]').inputValue(),'');
  assert.equal(await page.locator('[name=password]').inputValue(),'');
  assert.equal(await page.locator('#account-google-status').isVisible(),false);
  release();
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount().token),'bob-token');
  assert.equal(await page.evaluate(()=>localStorage.getItem('epi-account-language')),null);
  assert.equal(await page.locator('#account-error').isVisible(),false);
});

test('token persistence failure cancels an activated hosted binding and fails closed', async t => {
  const page=await open(t);
  await page.evaluate(api=>{
    const write=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='epi-account:'+api)throw new DOMException('Full','QuotaExceededError');return write.call(this,key,value);};
    window.accounts.configureAccountDatasets({
      beforeSignIn:async()=>{window.accounts.setDatasetAccess({locked:false,hosted:true});return true;},
      onCancelled:async binding=>{window.cancelledBinding=binding;window.accounts.setDatasetAccess({locked:true,hosted:true});},
    });
  },api);
  await login(page);
  await page.waitForFunction(()=>Boolean(window.cancelledBinding));
  await page.locator('#account-submit:enabled').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.cancelledBinding),{token:'test-token',accountId});
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount()),null);
  assert.equal(await page.locator('.shell').isVisible(),false);
  assert.equal(await page.locator('#account-dialog').isVisible(),true);
});

test('cancelling Google during attachment invalidates only that binding and discards its late completion', async t => {
  const page=await open(t);
  await page.context().route('https://accounts.google.com/**',route=>route.fulfill({body:'Google sign-in'}));
  await page.route(api+'/v1/google/start',route=>route.fulfill({json:{state:'state',secret:'secret',url:'https://accounts.google.com/o/oauth2/v2/auth'}}));
  await page.route(api+'/v1/google/finish',route=>route.fulfill({json:{...info,token:'ready-google-token'}}));
  await page.evaluate(()=>window.accounts.configureAccountDatasets({
    beforeSignIn:()=>new Promise(resolve=>{window.finishAttachment=resolve;}),
    onCancelled:async binding=>{window.cancelledBinding=binding;window.finishAttachment(true);},
  }));
  await page.locator('#account-button').click();
  await page.locator('#account-google').click();
  await page.waitForFunction(()=>Boolean(window.finishAttachment));
  await page.locator('#account-close').click();
  await page.locator('#account-submit:enabled').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.cancelledBinding),{token:'ready-google-token',accountId});
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount()),null);
});


test('a delayed language save from the prior account cannot change the next account interface', async t => {
  const bobInfo={accountId:'b1800c21-2a45-4b03-9ccd-e80edc2bca2d',email:'bob@example.org',paid:false,paidUntil:null};
  const page=await open(t,{saved:{email:info.email,accountId,token:'alice-token',info}});
  await page.route(api+'/v1/account',route=>route.fulfill({json:route.request().headers().authorization==='Bearer bob-token'?bobInfo:info}));
  await page.evaluate(()=>{
    window.accounts.configureAccountDatasets({});
    window.accounts.enableLanguageSelection(()=>new Promise(resolve=>{window.finishLanguage=resolve;}));
  });
  await page.locator('#account-button').click();
  await page.locator('#account-form [name=language]').selectOption('en-US');
  await page.waitForFunction(()=>Boolean(window.finishLanguage));
  await page.evaluate(({api,bobInfo})=>{
    localStorage.setItem('epi-account:'+api,JSON.stringify({email:bobInfo.email,accountId:bobInfo.accountId,token:'bob-token',info:bobInfo}));
    window.dispatchEvent(new StorageEvent('storage',{key:'epi-account:'+api}));
    window.finishLanguage();
  },{api,bobInfo});
  await page.locator('#account-submit:enabled').waitFor();
  assert.equal(await page.evaluate(()=>localStorage.getItem('epi-interface-language')),null);
  assert.equal(await page.locator('html').getAttribute('lang'),'fr-FR');
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount().token),'bob-token');
});


test('a failed credential deletion still closes local access, rejects the retained token and revokes it', async t => {
  const page=await open(t,{saved:{email:info.email,accountId,token:'test-token',info}});
  let revoked=false;
  await page.route(api+'/v1/device-tokens',route=>{revoked=true;return route.fulfill({status:204});});
  await page.evaluate(api=>{
    const remove=Storage.prototype.removeItem;
    Storage.prototype.removeItem=function(key){if(key==='epi-account:'+api)throw new DOMException('Unavailable','SecurityError');return remove.call(this,key);};
    window.accounts.configureAccountDatasets({beforeSignOut:async()=>window.accounts.setDatasetAccess({locked:true,hosted:false})});
  },api);
  await page.locator('#account-button').click();
  await page.locator('#account-submit').click();
  await page.locator('#account-fields').waitFor();
  assert.equal(await page.evaluate(()=>window.accounts.getSavedAccount()),null);
  assert.equal(await page.evaluate(()=>window.accounts.syncToken()),undefined);
  assert.equal(await page.locator('.shell').isVisible(),false);
  await page.locator('#account-error').getByText('Le stockage local du compte est inaccessible.',{exact:true}).waitFor();
  await page.waitForTimeout(50);
  assert.equal(revoked,true);
});


test('caches device counts and shows the PRO invitation only for FREE accounts with multiple installations', async t => {
  const free = { ...info, paid: false, paidUntil: null, deviceCount: 1 };
  const saved = { email: info.email, accountId, token: 'test-token', info: free };
  const page = await open(t, { saved, response: free });
  // This harness loads the account module alone; the measurements route owns the slot.
  await page.evaluate(() => { document.querySelector('#sync-upgrade-slot').hidden = false; });
  const notice = page.locator('#sync-upgrade');
  assert.equal(await notice.isVisible(), false);
  for (const next of [{ ...free, deviceCount: 2 }, { ...info, deviceCount: 2 }, { ...free, deviceCount: 1 }]) {
    await page.route(api + '/v1/account', route => route.fulfill({ json: next }));
    await page.evaluate(() => window.accounts.checkAccountConnection());
    assert.equal(await notice.isVisible(), !next.paid && next.deviceCount > 1);
    assert.equal(await page.evaluate(() => window.accounts.getSavedAccount().info.deviceCount), next.deviceCount);
  }
  await page.route(api + '/v1/account', route => route.fulfill({ json: { ...free, deviceCount: 2 } }));
  await page.evaluate(() => window.accounts.checkAccountConnection());
  assert.equal(await notice.locator('p').innerText(), 'Vous vous connectez depuis plusieurs appareils. Synchronisez vos données avec la version PRO');
  assert.equal(new URL(await notice.locator('a').getAttribute('href')).origin + new URL(await notice.locator('a').getAttribute('href')).pathname + new URL(await notice.locator('a').getAttribute('href')).hash, 'https://domun.eu/epi/pro#compare');
  await page.route(api + '/v1/account', route => route.abort());
  await page.evaluate(() => window.accounts.checkAccountConnection());
  assert.equal(await notice.isVisible(), true);
  const offline = await open(t, { saved: { ...saved, info: { ...free, deviceCount: 2 } }, response: null });
  await offline.evaluate(() => { document.querySelector('#sync-upgrade-slot').hidden = false; });
  assert.equal(await offline.locator('#sync-upgrade').isVisible(), true);
  await page.locator('#account-button').click();
  await page.locator('#account-submit').click();
  await page.locator('#account-fields').waitFor();
  assert.equal(await notice.isVisible(), false);
});
