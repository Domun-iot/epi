import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApi, tokenLifetime } from './dist/api.js';
import { openStore } from './dist/store.js';

test('synchronizes batches per account and preserves receipts after token expiration and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'epi-sync-'));
  const path = join(directory, 'epi.sqlite');
  let now = Date.now();
  let store;
  let server;
  let baseUrl;

  async function start() {
    store = openStore(path);
    server = createApi(store, () => now);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  }

  async function stop() {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    store?.close();
    store = undefined;
  }

  async function request(route, { body, token, status = 200 } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + route, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body && JSON.stringify(body),
    });
    const result = await res.json();
    assert.equal(res.status, status, JSON.stringify(result));
    return result;
  }

  const alice = { email: 'alice@example.org', password: 'alice-password' };
  const bob = { email: 'bob@example.org', password: 'bob-password' };
  const login = async (account, deviceId) =>
    (await request('/device-tokens', { body: { ...account, deviceId } })).token;
  const pending = async token => (await request('/transactions/pending', { token })).transactions;
  const upload = (token, transactions) => request('/transactions', { token, body: { transactions } });
  const acknowledge = (token, uuids) => request('/transactions/acknowledge', { token, body: { uuids } });

  try {
    await start();
    await request('/accounts', { body: alice, status: 201 });
    await request('/accounts', { body: bob, status: 201 });
    await request('/accounts', { body: { ...alice, email: ' ALICE@example.org ' }, status: 409 });
    assert.deepEqual(await request('/device-tokens', {
      body: { ...alice, password: 'invalid', deviceId: 'pc' }, status: 401,
    }), { error: 'invalid_credentials' });

    const pc = await login(alice, 'pc');
    const phone = await login(alice, 'phone');
    const other = await login(bob, 'pc');
    const preflight = await fetch(baseUrl + '/device-tokens', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:1421',
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /DELETE/);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);

    const revoke = async token => {
      const response = await fetch(baseUrl + '/device-tokens', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      assert.equal(response.status, 204);
    };
    const replaced = await login(alice, 'temporary');
    const temporary = await login(alice, 'temporary');
    await revoke(replaced);
    assert.deepEqual(await pending(temporary), []);
    await revoke(temporary);
    await revoke(temporary);
    await request('/transactions/pending', { token: temporary, status: 401 });
    const first = { uuid: randomUUID(), type: 'create', data: { path: 'profiles/a.json', value: {} } };
    const second = { uuid: randomUUID(), type: 'delete', data: { path: 'profiles/a.json' } };
    assert.deepEqual(await request('/transactions', {
      token: pc, body: { transactions: [first, {}] }, status: 400,
    }), { error: 'invalid_transaction' });
    assert.deepEqual(await pending(pc), []);
    assert.deepEqual(await upload(pc, [first, second]), { inserted: 2, uuids: [first.uuid, second.uuid] });
    assert.deepEqual(await upload(pc, [{ data: first.data, type: first.type, uuid: first.uuid }]),
      { inserted: 0, uuids: [first.uuid] });
    assert.deepEqual(await upload(pc, [{ ...first, type: 'update' }]), { inserted: 0, uuids: [] });
    assert.deepEqual(await pending(other), []);
    assert.deepEqual(await acknowledge(other, [first.uuid]), { inserted: 0 });
    assert.deepEqual(await upload(other, [first]), { inserted: 1, uuids: [first.uuid] });
    assert.deepEqual(await pending(other), []);
    assert.deepEqual(await pending(pc), []);
    assert.deepEqual(await acknowledge(pc, [first.uuid, second.uuid]), { inserted: 0 });
    assert.deepEqual(await upload(phone, [{ ...first, type: 'update' }]), { inserted: 0, uuids: [] });
    assert.deepEqual(await pending(phone), [first, second]);
    assert.deepEqual(await pending(phone), [first, second]);
    assert.deepEqual(await acknowledge(phone, [first.uuid, first.uuid]), { inserted: 1 });
    assert.deepEqual(await pending(phone), [second]);

    const uploadPreflight = await fetch(baseUrl + '/transactions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:1421',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    assert.equal(uploadPreflight.status, 204);
    assert.equal(uploadPreflight.headers.get('Access-Control-Allow-Origin'), '*');
    const backlog = Array.from({ length: 130 }, () => ({ ...first, uuid: randomUUID() }));
    const body = backlog.map(row => JSON.stringify(row)).join('\n') + '\n';
    for (const inserted of [backlog.length, 0]) {
      const response = await fetch(baseUrl + '/transactions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + other, 'Content-Type': 'application/x-ndjson' },
        body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { inserted, uuids: backlog.map(row => row.uuid) });
    }

    assert.deepEqual(await pending(other), []);

    const timestamped = Array.from({ length: 101 }, (_, index) => {
      const uuid = randomUUID();
      return { ...first, uuid, name: '2026-01-15T17-23-21.' + String(index).padStart(6, '0') + 'Z-' + uuid + '.json' };
    });
    const chronologicalReader = await login(bob, 'chronological');
    const reversed = [...timestamped].reverse();
    await upload(other, reversed.slice(0, 100));
    await upload(other, reversed.slice(100));
    const pageOne = await request('/transactions/pending', { token: chronologicalReader });
    assert.deepEqual(pageOne.transactions, timestamped.slice(0, 100));
    const pageTwo = await request('/transactions/pending?after=' + encodeURIComponent(pageOne.next),
      { token: chronologicalReader });
    assert.deepEqual(pageTwo.transactions[0], timestamped[100]);
    assert.deepEqual(pageTwo.transactions[1], first);
    assert.deepEqual(await acknowledge(chronologicalReader, [timestamped[100].uuid]), { inserted: 1 });

    const stampedFirst = { ...first, name: '2026-01-15T17-00-00.000000Z-' + first.uuid + '.json' };
    assert.deepEqual(await upload(other, [stampedFirst]), { inserted: 0, uuids: [first.uuid] });
    assert.deepEqual(await upload(other, [first]), { inserted: 0, uuids: [first.uuid] });
    assert.deepEqual((await pending(chronologicalReader))[0], stampedFirst);
    assert.deepEqual(await upload(chronologicalReader, [stampedFirst]), { inserted: 0, uuids: [first.uuid] });
    assert.ok((await pending(chronologicalReader)).every(row => row.uuid !== first.uuid));

    now += tokenLifetime;
    assert.deepEqual(await pending(pc), []);
    now += 1;
    await stop();
    await start();

    assert.deepEqual(await request('/transactions/pending', { token: phone, status: 401 }),
      { error: 'token_expired' });
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(inspection.prepare("SELECT token_hash FROM devices WHERE device_id = 'phone'")
        .get().token_hash, null);
    } finally {
      inspection.close();
    }
    assert.deepEqual(await pending(await login(alice, 'pc')), []);
    const renewed = await login(alice, 'phone');
    assert.deepEqual(await pending(renewed), [second]);
    assert.deepEqual(await request('/transactions/pending', { token: phone, status: 401 }),
      { error: 'invalid_token' });
    assert.deepEqual(await acknowledge(renewed, [second.uuid]), { inserted: 1 });
    assert.deepEqual(await pending(renewed), []);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
