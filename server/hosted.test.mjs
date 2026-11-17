import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, access, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApi } from './dist/api.js';
import { openStore } from './dist/store.js';
import { createHostedApi } from '../web/hosted-api.js';

const expires = '2099-01-01T00:00:00.000Z';
const domunToken = 'a'.repeat(64);
async function fixture(t, { now = Date.now } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'epi-hosted-'));
  const store = openStore(join(root, 'epi.sqlite'));
  const rights = new Map();
  const hosted = createHostedApi({ dataRoot: root, store, now });
  const server = createApi(store, now, undefined, undefined, domunToken,
    async id => { if (rights.fail) throw new Error('Billing unavailable'); return rights.get(id) ?? null; }, hosted).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(root, { recursive: true, force: true }); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { token, body, method, headers, status = 200, onResponse } = {}) {
    const response = await fetch(origin + path, { method: method ?? (body ? 'POST' : 'GET'),
      headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }), ...headers },
      body: body && JSON.stringify(body) });
    const result = response.status === 204 ? undefined : await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    onResponse?.(response);
    return result;
  }
  async function login(name, deviceId = 'browser', pro = false) {
    const credentials = { email: name + '@example.org', password: name + '-password' };
    if (!store.findAccount(credentials.email)) await call('/v1/accounts', { body: credentials, status: 201 });
    const record = store.findAccount(credentials.email);
    if (pro) rights.set(record.domun_id, expires);
    return call('/v1/device-tokens', { body: { ...credentials, deviceId } });
  }
  const action = (session, action, args = [], options = {}) => call('/api/session', { token: session.token,
    body: { action, args, datasetId: session.accountId }, ...options });
  return { root, store, rights, call, login, action, hosted };
}

function transaction(type, path, value, stamp = '2026-11-17T12-00-00.000001Z') {
  const uuid = randomUUID();
  return { uuid, name: stamp + '-' + uuid + '.json', type, data: { path, ...(type !== 'delete' && { value }) } };
}

test('hosted requests require a valid PRO token and isolate account datasets', async t => {
  const f = await fixture(t);
  await f.call('/api/session', { body: { action: 'load', args: [] }, status: 401 });
  const alice = await f.login('alice', 'browser', true);
  const bob = await f.login('bob', 'browser', true);
  assert.match(alice.accountId, /^[a-f0-9-]{36}$/);
  assert.notEqual(alice.accountId, bob.accountId);
  assert.equal((await f.call('/v1/account', { token: alice.token })).accountId, alice.accountId);
  await f.action(alice, 'saveProfile', [{ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }]);
  assert.equal((await f.action(alice, 'load')).profiles[0].name, 'Alice');
  assert.deepEqual((await f.action(bob, 'load')).profiles, []);
  await f.action(alice, 'load', [], { body: { action: 'load', args: [], datasetId: bob.accountId }, status: 409 });
  for (const action of ['pendingTransactions', 'archiveTransactions', 'integrateTransactions']) {
    await f.action(alice, action, [], { status: 403 });
  }
  const localProfile = (await f.action(alice, 'load')).profiles[0];
  assert.equal(JSON.parse(await readFile(join(f.root, 'accounts', alice.accountId, 'profiles', localProfile.uuid + '.json'), 'utf8')).name, 'Alice');
  await f.call('/v1/device-tokens', { token: alice.token, method: 'DELETE', status: 204 });
  await f.action(alice, 'load', [], { status: 401 });
  assert.deepEqual((await f.action(bob, 'load')).profiles, []);
});

test('PRO hosted mutations join the durable account log and uploaded data is visible in the web session', async t => {
  const f = await fixture(t);
  const browser = await f.login('alice', 'browser', true);
  const phone = await f.login('alice', 'phone');
  await f.action(browser, 'saveProfile', [{ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }]);
  const pending = await f.call('/v1/transactions/pending', { token: phone.token });
  assert.ok(pending.transactions.length);
  assert.ok(pending.transactions.some(row => row.type === 'batch' || row.data?.path?.startsWith('profiles/')));
  const id = randomUUID();
  const entry = transaction('create', 'measures/' + randomUUID() + '/2026-01-02T03-04-05.000Z.json', {
    uuid: id, receivedAt: '2026-01-02T03:04:05.000Z', profile: { name: 'Alice' }, measures: { weight: 70, unit: 'kg' },
  });
  await f.call('/v1/transactions', { token: phone.token, body: { transactions: [entry] } });
  assert.equal((await f.action(browser, 'load')).measurements[0].uuid, id);
  const snapshot = await f.call('/v1/dataset', { token: phone.token });
  assert.equal(snapshot.accountId, phone.accountId);
  assert.deepEqual(snapshot.summary, { count: 1, from: '2026-01-02T03:04:05.000Z', to: '2026-01-02T03:04:05.000Z', hasData: true });
  assert.ok(snapshot.files.some(file => file.path === 'transactions.index'));
  assert.ok(snapshot.files.some(file => file.path.startsWith('transactions.sent/')));
  const brief = await f.call('/v1/dataset/summary', { token: phone.token });
  assert.deepEqual(brief.summary, snapshot.summary);
  assert.equal(brief.revision, snapshot.revision);
  assert.equal(brief.files, undefined);
});

test('materialization recovers already acknowledged legacy transactions and rejects stale merge revisions', async t => {
  const f = await fixture(t);
  const pc = await f.login('alice', 'pc', true);
  const account = f.store.findAccount('alice@example.org');
  const id = randomUUID();
  const entry = transaction('create', 'profiles/' + id + '.json', { uuid: id, name: 'Recover', sex: 'F', age: 30, heightCm: 160 });
  f.store.upload(account.id, 'pc', [{ uuid: entry.uuid, payload: JSON.stringify(entry) }]);
  // Canonical preparation may publish new default preferences; the acknowledged original stays hidden.
  assert.equal((await f.call('/v1/transactions/pending', { token: pc.token })).transactions.some(row => row.uuid === entry.uuid), false);
  const snapshot = await f.call('/v1/dataset', { token: pc.token });
  assert.ok(snapshot.files.some(file => file.path === 'profiles/' + id + '.json'));
  const fresh = transaction('update', 'profiles/' + id + '.json', { uuid: id, name: 'Updated', sex: 'F', age: 31, heightCm: 160,
    updatedAt: '2026-11-17T12:00:01.000Z' }, '2026-11-17T12-00-01.000001Z');
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [fresh] }, headers: { 'If-Match': snapshot.revision } });
  const stale = transaction('delete', 'profiles/' + id + '.json', undefined, '2026-11-17T12-00-02.000001Z');
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [stale] }, headers: { 'If-Match': snapshot.revision }, status: 409 });
  assert.equal(f.store.allTransactions(account.id).some(row => JSON.parse(row.payload).uuid === stale.uuid), false);
});

test('FREE cannot read or mutate hosted data; expiry preserves existing PRO files until renewal', async t => {
  const f = await fixture(t);
  const browser = await f.login('alice', 'browser');
  for (const action of ['load', 'saveProfile', 'exportFiles', 'importFiles', 'changeViewPreset']) {
    await f.action(browser, action, action === 'saveProfile' ? [{ name: 'Forbidden' }] : [], { status: 403 });
  }
  await assert.rejects(access(join(f.root, 'accounts', browser.accountId)), { code: 'ENOENT' });
  const account = f.store.findAccount('alice@example.org');
  assert.equal(f.store.allTransactions(account.id).length, 0);
  f.rights.set(account.domun_id, expires);
  await f.action(browser, 'saveProfile', [{ name: 'PRO data', sex: 'H', age: 33, heightCm: 175 }]);
  const phone = await f.login('alice', 'phone');
  assert.equal((await f.call('/v1/dataset', { token: phone.token })).summary.hasData, true);
  f.rights.delete(account.domun_id);
  await f.action(browser, 'saveProfile', [{ name: 'Forbidden free' }], { status: 403 });
  await f.action(browser, 'load', [], { status: 403 });
  await f.call('/v1/dataset', { token: phone.token, status: 403 });
  await f.call('/v1/transactions/pending', { token: phone.token, status: 403 });
  await f.call('/v1/transactions', { token: phone.token, body: { transactions: [] }, status: 403 });
  f.rights.set(account.domun_id, expires);
  assert.deepEqual((await f.action(browser, 'load')).profiles.map(row => row.name), ['PRO data']);
});


test('invalid hosted uploads do not poison the log, and late changes cannot resurrect deleted data', async t => {
  const f = await fixture(t);
  const pc = await f.login('alice', 'pc', true);
  const account = f.store.findAccount('alice@example.org');
  const bad = transaction('create', '../escape.json', {});
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [bad] }, status: 400 });
  assert.equal(f.store.allTransactions(account.id).length, 0);
  const id = randomUUID();
  const path = 'profiles/' + id + '.json';
  const create = transaction('create', path, { uuid: id, name: 'Alice', sex: 'F', age: 40, heightCm: 165, createdAt: '2026-01-01T00:00:00.000Z' });
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [create] } });
  const remove = transaction('delete', path, undefined, '2026-11-17T12-00-01.000001Z');
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [remove] } });
  const late = transaction('create', path, { ...create.data.value, updatedAt: '2026-02-01T00:00:00.000Z' }, '2026-11-17T12-00-02.000001Z');
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [late] } });
  assert.equal((await f.call('/v1/dataset', { token: pc.token })).files.some(file => file.path === path), false);
});

test('final account purge removes its hosted files and leaves the other account intact', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice', 'browser', true);
  const bob = await f.login('bob', 'browser', true);
  await f.action(alice, 'saveProfile', [{ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }]);
  await f.action(bob, 'saveProfile', [{ name: 'Bob', sex: 'H', age: 40, heightCm: 175 }]);
  const account = f.store.findAccount('alice@example.org');
  f.store.markDeleted(account.domun_id, '2020-01-01T00:00:00.000Z');
  const result = await f.call('/v1/domun/accounts/purge', { token: domunToken, body: { ids: [account.domun_id] } });
  assert.equal(result.purged, 1);
  await assert.rejects(access(join(f.root, 'accounts', alice.accountId)), { code: 'ENOENT' });
  await f.action(alice, 'load', [], { status: 401 });
  assert.equal((await f.action(bob, 'load')).profiles[0].name, 'Bob');
});


test('legacy deletions without timestamps require explicit recovery instead of recreating data', async t => {
  const f = await fixture(t);
  const pc = await f.login('alice', 'pc', true);
  const account = f.store.findAccount('alice@example.org');
  const entry = { uuid: randomUUID(), type: 'delete', data: { path: 'profiles/' + randomUUID() + '.json' } };
  f.store.upload(account.id, 'pc', [{ uuid: entry.uuid, payload: JSON.stringify(entry) }]);
  const result = await f.call('/v1/dataset', { token: pc.token, status: 503 });
  assert.equal(result.error, 'dataset_recovery_required');
});


test('PRO expiry during canonical preparation blocks upload and snapshot response', async t => {
  const initial = Date.now();
  let time = initial;
  const f = await fixture(t, { now: () => time });
  const pc = await f.login('alice', 'pc');
  const account = f.store.findAccount('alice@example.org');
  const deadline = initial + 1000;
  f.rights.set(account.domun_id, new Date(deadline).toISOString());
  const readAll = f.store.allTransactions;
  f.store.allTransactions = (...args) => { time = deadline; return readAll(...args); };
  const entry = transaction('create', 'profiles/' + randomUUID() + '.json', { name: 'Must not be stored' });
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [entry] }, status: 403 });
  assert.equal(readAll(account.id).length, 0);
  time = initial;
  await f.call('/v1/dataset', { token: pc.token, status: 403 });
});

test('a durable hosted edit reports success with deferred publication and recovers after a DB write failure', async t => {
  const f = await fixture(t);
  const browser = await f.login('alice', 'browser', true);
  const account = f.store.findAccount('alice@example.org');
  const publish = f.store.uploadServer;
  let broken = true;
  f.store.uploadServer = (...args) => { if (broken) throw new Error('Simulated SQLite write failure'); return publish(...args); };
  const saved = await f.action(browser, 'saveProfile', [{ name: 'Durable', sex: 'F', age: 40, heightCm: 165 }], {
    onResponse: response => assert.equal(response.headers.get('X-Epi-Sync'), 'pending'),
  });
  assert.equal(saved.profiles[0].name, 'Durable');
  assert.equal(f.store.allTransactions(account.id).length, 0);
  assert.equal((await f.action(browser, 'load')).profiles[0].name, 'Durable');
  broken = false;
  // Replace the adapter to simulate a process restart; the web browser stays idle.
  Object.assign(f.hosted, createHostedApi({ dataRoot: f.root, store: f.store }));
  const phone = await f.login('alice', 'phone');
  assert.ok((await f.call('/v1/transactions/pending', { token: phone.token })).transactions.length > 0);
});


test('pending-only account data is not described as an empty dataset', async t => {
  const f = await fixture(t);
  const pc = await f.login('alice', 'pc', true);
  const entry = transaction('create', 'prefs/global.json', { pending: [{ id: randomUUID(), event: { weightKg: 70 } }] });
  await f.call('/v1/transactions', { token: pc.token, body: { transactions: [entry] } });
  const snapshot = await f.call('/v1/dataset', { token: pc.token });
  assert.equal(snapshot.summary.hasData, true);
  assert.equal(snapshot.summary.count, 0);
});

test('canonical recovery remains available after the same device acknowledged all transactions', async t => {
  const f = await fixture(t);
  const pc = await f.login('alice', 'pc', true);
  const phone = await f.login('alice', 'phone');
  const id = randomUUID();
  const entry = transaction('create', 'profiles/' + id + '.json', { uuid: id, name: 'Recover after old backup', sex: 'F', age: 40, heightCm: 165 });
  await f.call('/v1/transactions', { token: phone.token, body: { transactions: [entry] } });
  const pending = await f.call('/v1/transactions/pending', { token: pc.token });
  await f.call('/v1/transactions/acknowledge', { token: pc.token, body: { uuids: pending.transactions.map(row => row.uuid) } });
  assert.deepEqual((await f.call('/v1/transactions/pending', { token: pc.token })).transactions, []);
  const snapshot = await f.call('/v1/dataset', { token: pc.token });
  assert.ok(snapshot.files.some(file => file.path === 'profiles/' + id + '.json'));
});


test('hosted account data rejects a nested directory link before reading another directory', async t => {
  const f = await fixture(t);
  const browser = await f.login('alice', 'browser', true);
  await f.action(browser, 'load');
  const external = join(f.root, 'external');
  await mkdir(external);
  const profiles = join(f.root, 'accounts', browser.accountId, 'profiles');
  await rm(profiles, { recursive: true });
  try { await symlink(external, profiles, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Directory links are unavailable on this host.'); throw error; }
  const result = await f.action(browser, 'load', [], { status: 409 });
  assert.equal(result.error, 'invalid_dataset_path');
});


test('a billing outage does not confirm FREE and cannot open remote storage', async t => {
  const f = await fixture(t);
  const session = await f.login('alice');
  f.rights.fail = true;
  const info = await f.call('/v1/account', { token: session.token });
  assert.equal(info.entitlementVerified, false);
  assert.equal(info.paid, false);
  await f.action(session, 'load', [], { status: 503 });
  await assert.rejects(access(join(f.root, 'accounts', session.accountId)), { code: 'ENOENT' });
});


test('hosted manual readings persist body fat and calculated impedance in the authenticated dataset', async t => {
  const f = await fixture(t);
  const alice = await f.login('manual-alice', 'browser', true);
  const bob = await f.login('manual-bob', 'browser', true);
  const state = await f.action(alice, 'saveProfile', [{ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }]);
  const profileUuid = state.profiles[0].uuid;
  const saved = await f.action(alice, 'saveManualMeasurement', [{ weight: 65, fatPercent: 30.02,
    profileUuid, receivedAt: '2020-01-02T10:30:00Z' }]);
  const row = saved.measurements[0];
  assert.equal(row.measures.fatPercent, 30.02);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  assert.equal(row.device.source, 'manual');
  assert.equal(row.reception, null);
  assert.deepEqual(saved.devices, []);
  const stored = JSON.parse(await readFile(join(f.root, 'accounts', alice.accountId, 'measures', profileUuid,
    '2020-01-02T10-30-00.000Z.json'), 'utf8'));
  assert.deepEqual(stored.measures, row.measures);
  assert.deepEqual(stored.calculations, row.calculations);
  assert.equal((await f.action(alice, 'reload')).measurements[0].uuid, row.uuid);
  assert.deepEqual((await f.action(bob, 'load')).measurements, []);
});
