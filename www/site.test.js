import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSite } from './index.js';
import { catalog, locales } from './locales.js';
import { scaleFamilies } from './feature-catalog.js';

test('public pages, language selection and account deletion redirects', async t => {
  const server = createSite({
    retention: { 'fr-FR': 'Conservation & <sauvegardes>' },
    secureCookie: true,
  }).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, options) => fetch(base + path, options);

  for (const locale of Object.keys(locales)) {
    for (const [route, title] of [
      ['', 'headline'], ['/privacy-policy', 'privacy'], ['/legal-notice', 'legal'],
    ]) {
      const response = await get('/epi' + route, { headers: { 'Accept-Language': locale } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-language'), locale);
      const html = await response.text();
      const afterTitle = route ? '</h1>' : '<sup><a class="scale-note" href="#bluetooth"';
      assert.ok(html.includes('<h1>' + catalog[locale][title] + afterTitle));
      assert.doesNotMatch(html, /mailto:|support@domun\.eu|↵/);
      assert.match(html, /<details class="languages"><summary>/);
      assert.ok(html.includes('class="footer-deletion" href="https://domun.eu/account/delete"'));
      assert.doesNotMatch(html, /href="\/epi\/delete-account/);
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

  const privacy = await get('/epi/privacy-policy', {
    headers: { Cookie: 'epi_lang=fr-FR', 'Accept-Language': 'de' },
  });
  assert.equal(privacy.headers.get('content-language'), 'fr-FR');
  const privacyPage = await privacy.text();
  assert.match(privacyPage, /Conservation &amp; &lt;sauvegardes&gt;/);
  assert.ok(privacyPage.includes('<p><a href="https://domun.eu/account/delete">'));

  for (const path of ['/epi/delete-account', '/epi/delete-account/', '/epi/delete-account?lang=fr&submitted=1']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const response = await get(path, {
        method, redirect: 'manual',
        ...(method === 'POST' && { body: new URLSearchParams({ email: 'account+test@example.org' }) }),
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), 'https://domun.eu/account/delete');
      assert.equal(await response.text(), '');
    }
  }

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
  for (const id of ['bluetooth', 'profiles', 'multiscale', 'composition', 'views', 'sync', 'local', 'source']) {
    assert.ok(home.includes('id="' + id + '" aria-labelledby="' + id + '-title"'));
  }
  const proBadges = [...home.matchAll(/<section class="feature feature-(\w+)"[^>]*>(.*?)<\/section>/g)]
    .filter(([, , section]) => section.includes('class="pro-badge"'));
  assert.deepEqual(proBadges.map(([, id]) => id), ['views', 'sync', 'local']);
  for (const [, , section] of proBadges) assert.match(section, /href="\/epi\/pro#compare"/);
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
  assert.equal((await get('/epi/delete-account', { method: 'PUT' })).headers.get('allow'), 'GET, HEAD');
  const flag = await get('/epi/assets/flags/gb.svg');
  assert.equal(flag.headers.get('content-type'), 'image/svg+xml');
});
