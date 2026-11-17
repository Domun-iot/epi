import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createSite } from './index.js';

test('the PRO page uses live native catalog prices and shares the comparison with account', async t => {
  let price = 575;
  let available = true;
  let promo = true;
  const admin = createServer((req, res) => {
    assert.equal(req.headers.accept, 'application/json');
    res.writeHead(available ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      code: 'epi', monthlyPriceMinor: 110, yearlyPriceMinor: price, freeProMonth: promo,
    }));
  }).listen(0, '127.0.0.1');
  await once(admin, 'listening');
  const site = createSite({ catalogUrl: 'http://127.0.0.1:' + admin.address().port + '/public-software/1/output' })
    .listen(0, '127.0.0.1');
  await once(site, 'listening');
  t.after(() => { site.close(); admin.close(); });
  const get = path => fetch('http://127.0.0.1:' + site.address().port + path, { headers: { 'Accept-Language': 'fr-CA' } });
  const first = await get('/epi/pro');
  const page = await first.text();
  assert.equal(first.status, 200);
  assert.match(page, /1,10.+par mois.+5,75.+par an/);
  assert.match(page, /En ce moment, premier mois de PRO offert/);
  assert.match(page, /href="\/account\/epi\/subscribe\?lang=fr-CA"/);
  assert.doesNotMatch(page, /public-software|127\.0\.0\.1/);
  const features = await (await get('/epi/plan-features.json')).json();
  assert.match(first.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(page, /<script defer src="\/epi\/assets\/scenes\.js\?v=[a-f0-9]+"><\/script>/);
  for (const id of ['sync', 'views', 'local']) {
    assert.ok(page.includes('id="' + id + '" aria-labelledby="' + id + '-title"'));
  }
  assert.match(page, /id="compare" aria-labelledby="compare-title"/);
  const rows = [...page.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)].map(match => match[1]);
  assert.equal(rows.length, features.rows.length);
  for (const [index, [label, free]] of features.rows.entries()) {
    const [heading, freeCell, proCell] = rows[index].split('<td>');
    assert.match(heading, /<svg class="plan-icon" aria-hidden="true"/);
    assert.ok(heading.includes('<span>' + label + '</span>'), label);
    assert.ok(freeCell.includes(free ? 'plan-included' : 'plan-excluded'), label);
    assert.ok(freeCell.includes(free ? '>Inclus</span>' : '>Non inclus</span>'), label);
    assert.match(proCell, /plan-included.*<span class="sr-only">Inclus<\/span>/);
  }
  price = 840;
  promo = false;
  const changed = await (await get('/epi/pro')).text();
  assert.match(changed, /8,40/);
  assert.doesNotMatch(changed, /premier mois de PRO offert/i);
  available = false;
  const down = await get('/epi/pro');
  assert.equal(down.status, 503);
  assert.doesNotMatch(await down.text(), /\/account\/epi\/subscribe/);
});
