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
  assert.match(page, /Premier mois de PRO offert/);
  assert.match(page, /href="\/account\/epi\/subscribe\?lang=fr-CA"/);
  assert.doesNotMatch(page, /public-software|127\.0\.0\.1/);
  const features = await (await get('/epi/plan-features.json')).json();
  for (const [label, free] of features.rows) {
    if (!free) assert.ok(page.includes('<th scope="row">' + label + '</th><td>Non inclus</td><td>Inclus</td>'), label);
  }
  price = 840;
  promo = false;
  const changed = await (await get('/epi/pro')).text();
  assert.match(changed, /8,40/);
  assert.doesNotMatch(changed, /Premier mois de PRO offert/);
  available = false;
  const down = await get('/epi/pro');
  assert.equal(down.status, 503);
  assert.doesNotMatch(await down.text(), /\/account\/epi\/subscribe/);
});
