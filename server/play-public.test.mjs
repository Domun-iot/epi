import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { playPublicPages } from './dist/play-public.js';
import { openStore } from './dist/store.js';

test('Play pages contain working contact links and escape publisher settings', t => {
  const directory = mkdtempSync(join(tmpdir(), 'epi-play-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'play-public.json');
  assert.equal(playPublicPages(file), undefined);
  writeFileSync(file, '\uFEFF' + JSON.stringify({
    publisher: '<éditeur>', contact: 'support@example.org', retention: '30 jours',
  }));
  const page = playPublicPages(file);
  let html;
  const response = {
    writeHead(status, headers) {
      assert.equal(status, 200);
      assert.equal(headers['Content-Type'], 'text/html; charset=utf-8');
    },
    end(content) { html = content; },
  };
  assert.equal(page('/confidentialite', response), true);
  assert.match(html, /&lt;éditeur&gt;/);
  assert.match(html, /href="\/supprimer-compte"/);
  assert.equal(page('/supprimer-compte', response), true);
  assert.match(html, /href="mailto:support@example.org\?subject=/);
  assert.match(html, /30 jours/);
  assert.equal(page('/other', response), false);
});

test('account deletion removes synchronized data and all credentials for only that account', t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const account = store.createGoogle('delete@example.org', 'google-id', null, null);
  store.createAccount('keep@example.org', 'hash', null);
  const other = store.findAccount('keep@example.org');
  store.issueToken(account.id, 'device', 'selector', 'hash', 100);
  store.issueToken(other.id, 'device', 'other-selector', 'hash', 100);
  const row = { uuid: 'ad81fa9d-f2ab-403f-a04b-a28eb6727d6b', payload: '{}' };
  store.upload(account.id, 'device', [row]);
  store.upload(other.id, 'device', [row]);
  store.acknowledge(account.id, 'device', [row.uuid]);

  store.deleteAccount(account.id);
  assert.equal(store.findAccount(account.email), undefined);
  assert.equal(store.findGoogle('google-id'), undefined);
  assert.equal(store.useToken(101, 'selector', 'hash', 0), undefined);
  assert.equal([...store.pending(account.id, 'another-device', '', 10)].length, 0);
  assert.equal([...store.pending(other.id, 'another-device', '', 10)].length, 1);
  assert.equal(store.useToken(101, 'other-selector', 'hash', 0).account_id, other.id);
});
