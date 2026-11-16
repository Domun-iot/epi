import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSite } from './index.js';
import { catalog, locales } from './locales.js';

test('public pages, language selection and deletion contact', async t => {
  const server = createSite({
    contact: 'test@example.org',
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
      assert.ok((await response.text()).includes('<h1>' + catalog[locale][title] + '</h1>'));
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
  assert.match(await deletion.text(), /mailto:test@example.org\?subject=.*Conservation &amp; &lt;sauvegardes&gt;/);

  const weighted = await get('/epi?lang=ja', { headers: { 'Accept-Language': 'ja,de;q=0.2,es-MX;q=0.9,fr;q=0' } });
  assert.equal(weighted.headers.get('content-language'), 'es');
  const fallback = await get('/epi', { headers: { 'Accept-Language': 'ja' } });
  assert.equal(fallback.headers.get('content-language'), 'en-GB');

  const image = await get('/epi/assets/chart.jpg', { method: 'HEAD' });
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(await image.text(), '');
  assert.equal((await get('/epi/copy.txt')).status, 404);
  assert.equal((await get('/epi/delete-account', { method: 'POST' })).status, 405);
});
