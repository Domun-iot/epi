import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSite } from './index.js';
import { catalog, locales } from './locales.js';
import { scaleFamilies } from './feature-catalog.js';

test('public pages, language selection and deletion requests', async t => {
  const mailDirectory = await mkdtemp(join(tmpdir(), 'epi-www-test-'));
  t.after(() => rm(mailDirectory, { recursive: true, force: true }));
  const server = createSite({
    mailDirectory,
    retention: { 'fr-FR': 'Conservation & <sauvegardes>' },
    secureCookie: true,
  }).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, options) => fetch(base + path, options);

  for (const locale of Object.keys(locales)) {
    for (const [route, title] of [
      ['', 'headline'], ['/privacy-policy', 'privacy'], ['/delete-account', 'deletion'], ['/legal-notice', 'legal'],
    ]) {
      const response = await get('/epi' + route, { headers: { 'Accept-Language': locale } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-language'), locale);
      const html = await response.text();
      assert.ok(html.includes('<h1>' + catalog[locale][title] + '</h1>'));
      assert.doesNotMatch(html, /mailto:|support@domun\.eu|↵/);
      assert.match(html, /<details class="languages"><summary>/);
      assert.match(html, /\?lang=en-GB"[^>]*><img class="flag" src="\/epi\/assets\/flags\/gb\.svg"/);
      assert.match(html, /\?lang=fr-CA"[^>]*><img class="flag" src="\/epi\/assets\/flags\/ca\.svg"/);
    }
  }

  const change = await get('/epi/privacy-policy?lang=fr', {
    redirect: 'manual', headers: { Cookie: 'epi_lang=de', 'Accept-Language': 'es' },
  });
  assert.equal(change.status, 303);
  assert.equal(change.headers.get('location'), '/epi/privacy-policy');
  assert.equal(change.headers.get('set-cookie'), 'epi_lang=fr-FR; Path=/epi; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure');

  const deletion = await get('/epi/delete-account', {
    headers: { Cookie: 'epi_lang=fr-FR', 'Accept-Language': 'de' },
  });
  assert.equal(deletion.headers.get('content-language'), 'fr-FR');
  const form = await deletion.text();
  assert.match(form, /method="post" action="\/epi\/delete-account"/);
  assert.match(form, /name="email" type="email"[^>]*required/);
  assert.match(form, /Conservation &amp; &lt;sauvegardes&gt;/);

  const postDeletion = (body, headers = {}) => get('/epi/delete-account', {
    method: 'POST', body, redirect: 'manual', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'epi_lang=fr-FR', ...headers,
    },
  });
  for (const invalid of [
    'email=invalid', 'email=test%40example.org%0D%0ABcc%3Aother%40example.org',
    'email=test%40example.org&email=other%40example.org', 'email=' + 'x'.repeat(2048),
  ]) {
    const response = await postDeletion(invalid);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /role="alert"/);
  }
  assert.equal((await postDeletion('email=test%40example.org', { 'Sec-Fetch-Site': 'cross-site' })).status, 400);
  assert.deepEqual(await readdir(mailDirectory), []);

  const email = 'account+test@example.org';
  const success = await postDeletion(new URLSearchParams({ email }));
  assert.equal(success.status, 303);
  const confirmation = await get(success.headers.get('location'), { headers: { Cookie: 'epi_lang=fr-FR' } });
  assert.match(await confirmation.text(), /Votre demande a été enregistrée/);
  const files = await readdir(mailDirectory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^epi-deletion-.*\.eml$/);
  const mail = await readFile(join(mailDirectory, files[0]), 'utf8');
  const [mimeHeaders, body] = mail.split('\r\n\r\n');
  assert.ok(mimeHeaders.split('\r\n').includes('To: support@domun.eu'));
  assert.ok(mimeHeaders.split('\r\n').includes('Reply-To: ' + email));
  assert.ok(mimeHeaders.split('\r\n').includes('MIME-Version: 1.0'));
  assert.ok(mimeHeaders.split('\r\n').includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(Buffer.from(body, 'base64').toString('utf8').includes(email));
  assert.equal((await get('/epi/assets/' + files[0])).status, 404);

  const weighted = await get('/epi?lang=ja', { headers: { 'Accept-Language': 'ja,de;q=0.2,es-MX;q=0.9,fr;q=0' } });
  assert.equal(weighted.headers.get('content-language'), 'es');
  const fallback = await get('/epi', { headers: { 'Accept-Language': 'ja' } });
  assert.equal(fallback.headers.get('content-language'), 'en-GB');

  const french = { headers: { 'Accept-Language': 'fr-FR' } };
  const homePage = await get('/epi', french);
  assert.match(homePage.headers.get('content-security-policy'), /script-src 'self'/);
  const home = await homePage.text();
  const sceneAsset = home.match(/<script defer src="(\/epi\/assets\/scenes\.js\?v=[a-f0-9]+)"><\/script>/);
  assert.ok(sceneAsset);
  const scriptResponse = await get(sceneAsset[1]);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type'), /^text\/javascript/);
  assert.match(home, /Simple au quotidien\. Complet pour les fous de données\./);
  assert.match(home, new RegExp('Pour ' + scaleFamilies.length + ' familles'));
  for (const id of ['bluetooth', 'profiles', 'composition', 'views', 'sync', 'local', 'source']) {
    assert.ok(home.includes('id="' + id + '" aria-labelledby="' + id + '-title"'));
  }
  for (const [path, expected] of [
    ['compatible-scales', 'XMTZC05HM'],
    ['calculation-methods', 'https://pubmed.ncbi.nlm.nih.gov/12540391/'],
  ]) {
    assert.ok(home.includes('href="/epi/' + path + '"'));
    const page = await get('/epi/' + path, french);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src/);
    const html = await page.text();
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /<script/);
  }
  const german = await get('/epi/calculation-methods', { headers: { 'Accept-Language': 'de' } });
  assert.match(await german.text(), /<html lang="de".*<div lang="en-GB">/);
  const weighIns = await get('/epi/assets/weigh-ins.jpg', { method: 'HEAD' });
  assert.equal(weighIns.status, 200);
  assert.equal(weighIns.headers.get('content-type'), 'image/jpeg');

  const image = await get('/epi/assets/chart.jpg', { method: 'HEAD' });
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(await image.text(), '');
  assert.equal((await get('/epi/copy.txt')).status, 404);
  assert.equal((await get('/epi', { method: 'POST' })).status, 405);
  assert.equal((await get('/epi/delete-account', { method: 'PUT' })).headers.get('allow'), 'GET, HEAD, POST');
  const flag = await get('/epi/assets/flags/gb.svg');
  assert.equal(flag.headers.get('content-type'), 'image/svg+xml');
});
