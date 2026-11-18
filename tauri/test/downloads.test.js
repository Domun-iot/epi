import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createSite } from '../../www/index.js';

let root, server, browser, base;
const checksum = '0123456789abcdef'.repeat(4);
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'epi-downloads-ui-'));
  for (const [group, kinds] of Object.entries({
    windows: ['public', 'msi', 'portable'], linux: ['public', 'appimage', 'portable'],
    android: ['apk'], 'cli-windows': ['cli'], 'cli-linux': ['cli'], web: ['web'],
  })) {
    await mkdir(join(root, group));
    await writeFile(join(root, group, 'release.json'), JSON.stringify({
      version: '1.2.3', files: kinds.map(kind => ({ kind, label: kind.toUpperCase(), name: group + '-' + kind, size: 12345678, sha256: checksum })),
    }));
  }
  server = createSite({ downloadsDir: root }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: process.env.EPI_CHROMIUM_CHANNEL || 'chrome' });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
  if (root) await rm(root, { recursive: true, force: true });
});

async function pageFor(t, path = '/epi/download', options = {}) {
  const page = await browser.newPage({ locale: 'fr-FR', viewport: { width: 1280, height: 1000 }, ...options });
  t.after(() => page.context().close());
  await page.goto(base + path);
  return page;
}

test('download actions share the same baseline across each row at desktop and tablet widths', async t => {
  const page = await pageFor(t);
  for (const path of ['/epi/download', '/epi/developers']) {
    await page.goto(base + path);
    for (const width of [1280, 820]) {
      await page.setViewportSize({ width, height: 1000 });
      const grids = await page.locator('.download-grid').evaluateAll(grids => grids.map(grid => [...grid.children].map(card => ({
        top: card.getBoundingClientRect().top,
        bottom: card.getBoundingClientRect().bottom,
        action: card.querySelector('.download-actions > .button, .download-actions .download-file .button').getBoundingClientRect().top,
      }))));
      for (const cards of grids) {
        for (const card of cards) {
          const peers = cards.filter(peer => Math.abs(card.top - peer.top) < 1);
          assert.ok(peers.every(peer => Math.abs(card.action - peer.action) < 1), `${path}, ${width}px: download buttons must align`);
          assert.ok(peers.every(peer => Math.abs(card.bottom - peer.bottom) < 1), `${path}, ${width}px: card bottoms must align`);
        }
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});

test('opening SHA copies the exact checksum and the hash button can copy it again using the keyboard', async t => {
  const page = await pageFor(t, '/epi/download', { permissions: ['clipboard-read', 'clipboard-write'] });
  await page.clock.install();
  const details = page.locator('.download-file details').first();
  await details.locator('summary').click();
  await details.locator('.checksum-feedback').filter({ hasText: /^Copié$/ }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), checksum);
  await page.clock.fastForward(4000);
  assert.equal(await details.locator('.checksum-feedback').innerText(), 'Copié');
  await page.evaluate(() => navigator.clipboard.writeText('replaced'));
  await details.locator('.checksum-copy').focus();
  await details.locator('.checksum-copy').press('Enter');
  await page.waitForFunction(expected => navigator.clipboard.readText().then(value => value === expected), checksum);
  assert.equal(await details.locator('.checksum-copy code').innerText(), checksum);
  await page.clock.fastForward(1000);
  assert.equal(await details.locator('.checksum-feedback').innerText(), 'Copié');
  await page.clock.fastForward(3999);
  assert.equal(await details.locator('.checksum-feedback').innerText(), 'Copié');
  await page.clock.fastForward(1);
  assert.equal(await details.locator('.checksum-feedback').innerText(), '');
});

test('a refused clipboard write keeps the checksum visible with an honest error message', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  const details = page.locator('.download-file details').first();
  await details.locator('summary').click();
  await details.locator('.checksum-feedback').filter({ hasText: 'Copie indisponible' }).waitFor();
  assert.equal(await details.locator('.checksum-copy code').isVisible(), true);
});
