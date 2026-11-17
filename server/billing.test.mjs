import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApi } from './dist/api.js';
import { openStore } from './dist/store.js';

test('FREE accounts can sign in, and expiry pauses sync without losing transactions or receipts', async t => {
  let now = Date.parse('2026-11-17T10:00:00Z');
  let expires = null;
  let outage = false;
  const store = openStore(':memory:');
  const observed = new Set();
  const server = createApi(store, () => now, undefined, undefined, undefined, async id => {
    observed.add(id);
    if (outage) throw new Error('offline');
    return expires;
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  async function call(path, status, token, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  const credentials = { email: 'pro@example.org', password: 'test-password' };
  await call('/accounts', 201, null, credentials);
  const { token: pc, paid } = await call('/device-tokens', 200, null, { ...credentials, deviceId: 'pc' });
  assert.equal(paid, false);
  const { token: phone } = await call('/device-tokens', 200, null, { ...credentials, deviceId: 'phone' });
  const { domunId } = await call('/account', 200, pc);
  const entry = { uuid: randomUUID(), operations: [{ op: 'put', path: 'test.json', contents: '{}' }] };
  assert.equal((await call('/transactions', 403, pc, { transactions: [entry] })).error, 'pro_required');

  expires = '2026-11-18T00:00:00.000Z';
  await call('/transactions', 200, pc, { transactions: [entry] });
  assert.deepEqual((await call('/transactions/pending', 200, phone)).transactions.map(row => row.uuid), [entry.uuid]);
  now = Date.parse(expires);
  assert.equal((await call('/account', 200, phone)).paid, false);
  assert.equal((await call('/transactions/pending', 403, phone)).error, 'pro_required');
  assert.equal((await call('/transactions/acknowledge', 403, phone, { uuids: [entry.uuid] })).error, 'pro_required');
  outage = true;
  assert.equal((await call('/transactions', 503, pc, { transactions: [entry] })).error, 'subscription_unavailable');
  outage = false;

  expires = '2026-12-18T00:00:00.000Z';
  assert.deepEqual((await call('/transactions/pending', 200, phone)).transactions.map(row => row.uuid), [entry.uuid]);
  await call('/transactions/acknowledge', 200, phone, { uuids: [entry.uuid] });
  assert.deepEqual((await call('/transactions/pending', 200, phone)).transactions, []);
  assert.deepEqual([...observed], [domunId]);
});
