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

    for (const [path, method] of [
      ['/account', 'GET'],
      ['/transactions', 'POST'],
      ['/transactions/pending?after=~00000000000000000001', 'GET'],
      ['/transactions/acknowledge', 'POST'],
    ]) {
      const origin = 'http://localhost:1421';
      const requestedHeaders = method === 'POST' ? 'authorization,content-type' : 'authorization';
      const preflight = await fetch(baseUrl + path, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': requestedHeaders,
        },
      });
      assert.equal(preflight.status, 204, path);
      assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*', path);
      const response = await fetch(baseUrl + path, {
        method,
        headers: { Origin: origin, Authorization: 'Bearer ' + pc, ...(method === 'POST' && { 'Content-Type': 'application/json' }) },
        body: method === 'POST' ? JSON.stringify(path.endsWith('/acknowledge') ? { uuids: [] } : { transactions: [] }) : undefined,
      });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*', path);
      await response.text();
    }
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

test('gives domun access to paginated account entitlements without sharing credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'epi-domun-'));
  const path = join(directory, 'epi.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL) STRICT;" +
    "INSERT INTO accounts (email, password_hash) VALUES ('legacy@example.org', 'legacy-hash')"
  );
  legacy.close();
  const store = openStore(path);
  const token = 'b'.repeat(64);
  let now = Date.parse('2026-11-16T09:00:00.000Z');
  const server = createApi(store, () => now, undefined, undefined, token);
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  const auth = key => ({ Authorization: 'Bearer ' + key });
  const send = (path, key, body, method = 'POST') => fetch(url + path, {
    method,
    headers: { ...auth(key), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const credentials = { email: 'new@example.org', password: 'password', deviceId: 'test-pc' };
  assert.equal((await send('/accounts', '', credentials)).status, 201);
  async function login() {
    const response = await send('/device-tokens', '', credentials);
    assert.equal(response.status, 200);
    return response.json();
  }
  const device = await login();
  assert.equal(device.paid, false);
  assert.equal(device.paidUntil, null);
  assert.equal((await fetch(url + '/domun/accounts')).status, 401);
  assert.equal((await fetch(url + '/domun/accounts', { headers: auth(device.token) })).status, 401);
  assert.equal((await fetch(url + '/domun/accounts?after=wrong', { headers: auth(token) })).status, 400);
  for (let i = 0; i < 100; i++) store.createAccount(i + '@example.org', 'hash', null);
  const first = await (await fetch(url + '/domun/accounts', { headers: auth(token) })).json();
  assert.equal(first.accounts.length, 100);
  assert.equal(first.next, first.accounts[99].id);
  const second = await (await fetch(url + '/domun/accounts?after=' + first.next, { headers: auth(token) })).json();
  assert.equal(second.accounts.length, 2);
  assert.equal(second.next, null);
  const accounts = [...first.accounts, ...second.accounts];
  assert.equal(new Set(accounts.map(account => account.id)).size, 102);
  const previous = accounts.find(account => account.email === 'legacy@example.org');
  assert.match(previous.id, /^[a-f0-9]{32}$/u);
  assert.deepEqual(previous, { id: previous.id, email: 'legacy@example.org', paidUntil: null });
  const account = accounts.find(account => account.email === credentials.email);
  const update = '/domun/accounts/' + account.id + '/entitlement';
  const status = async () => {
    const response = await fetch(url + '/account', { headers: auth(device.token) });
    assert.equal(response.status, 200);
    const { paid, paidUntil } = await response.json();
    return { paid, paidUntil };
  };
  assert.equal((await send(update, token, { paidUntil: '2026-02-30T09:00:00.000Z' }, 'PUT')).status, 400);
  const paidUntil = '2026-11-16T10:00:00.000Z';
  assert.equal((await send(update, device.token, { paidUntil }, 'PUT')).status, 401);
  assert.equal((await send(update, token, { paidUntil }, 'PUT')).status, 204);
  assert.deepEqual(await status(), { paid: true, paidUntil });
  const renewed = await login();
  assert.equal(renewed.paid, true);
  assert.equal(renewed.paidUntil, paidUntil);
  device.token = renewed.token;
  now = Date.parse(paidUntil);
  assert.deepEqual(await status(), { paid: false, paidUntil });
  assert.equal((await send(update, token, { paidUntil: null }, 'PUT')).status, 204);
  assert.deepEqual(await status(), { paid: false, paidUntil: null });
  store.deleteAccount(store.findAccount(credentials.email).id);
  assert.equal((await send('/accounts', '', credentials)).status, 201);
  assert.equal((await send(update, token, { paidUntil }, 'PUT')).status, 404);
  assert.equal((await login()).paid, false);
});

test('marks a connected account, blocks its devices and purges only eligible accounts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'epi-purge-'));
  const path = join(directory, 'epi.sqlite');
  const store = openStore(path);
  const token = 'c'.repeat(64);
  let now = Date.parse('2026-02-28T09:00:00.000Z');
  const server = createApi(store, () => now, undefined, undefined, token);
  const db = new DatabaseSync(path);
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/v1';
  const credentials = { email: 'delete@example.org', password: 'password', deviceId: 'desktop' };
  const auth = key => ({ Authorization: 'Bearer ' + key });
  const send = (path, body, key = '') => fetch(url + path, {
    method: 'POST', headers: { ...auth(key), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const register = () => send('/accounts', credentials);
  const login = (deviceId = credentials.deviceId) => send('/device-tokens', { ...credentials, deviceId });
  assert.equal((await register()).status, 201);
  const device = (await (await login()).json()).token;
  const otherDevice = (await (await login('phone')).json()).token;
  const transaction = { uuid: randomUUID() };
  assert.equal((await send('/transactions', { transactions: [transaction] }, device)).status, 200);
  const account = store.findAccount(credentials.email);
  store.createAccount('active@example.org', 'hash', null);
  const active = store.findAccount('active@example.org');
  store.createAccount('second@example.org', 'hash', null);
  const second = store.findAccount('second@example.org');
  store.markDeleted(second.domun_id, new Date(now).toISOString());

  const mark = (key, deviceToken) => fetch(url + '/domun/account-deletion', {
    method: 'DELETE', headers: { ...auth(key), 'X-Domun-Device': deviceToken }
  });
  const purgePath = '/domun/accounts/purge';
  const preview = async () => (await (await fetch(url + purgePath, { headers: auth(token) })).json()).accounts;
  const purge = async ids => (await send(purgePath, { ids }, token)).json();
  assert.equal((await mark(device, device)).status, 401);
  assert.equal((await mark(token, 'wrong')).status, 401);
  assert.equal((await mark(token, device)).status, 204);
  assert.equal((await mark(token, device)).status, 401);
  assert.equal((await login()).status, 401);
  assert.equal((await fetch(url + '/transactions/pending', { headers: auth(otherDevice) })).status, 401);
  assert.equal((await register()).status, 409);
  for (const table of ['accounts', 'devices', 'transactions', 'receipts']) {
    const idColumn = table === 'accounts' ? 'id' : 'account_id';
    assert.ok(db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + idColumn + ' = ?').get(account.id), table);
  }
  now = Date.parse('2026-03-31T09:00:00.000Z');
  assert.deepEqual(await preview(), []);
  assert.deepEqual(await purge([account.domun_id, active.domun_id]), { purged: 0 });
  now++;
  assert.deepEqual(new Set((await preview()).map(row => row.id)), new Set([account.domun_id, second.domun_id]));
  assert.deepEqual(await purge([account.domun_id, active.domun_id]), { purged: 1 });
  for (const table of ['accounts', 'devices', 'transactions', 'receipts']) {
    const idColumn = table === 'accounts' ? 'id' : 'account_id';
    assert.equal(db.prepare('SELECT 1 FROM ' + table + ' WHERE ' + idColumn + ' = ?').get(account.id), undefined, table);
  }
  assert.deepEqual((await preview()).map(row => row.id), [second.domun_id]);
  assert.deepEqual(await purge([account.domun_id, second.domun_id]), { purged: 1 });
  assert.deepEqual(await preview(), []);
  assert.equal((await register()).status, 201);
  assert.equal((await fetch(url + '/account', { headers: auth(device) })).status, 401);
  assert.ok(store.findAccount(active.email));
});
