import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createLocalApi } from './local-api.js';
import domain from '../tauri/domain/session.cjs';
import transactions from '../shared/transactions.cjs';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'epi-local-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = createLocalApi({ root, domain, transactions,
    storage: { resolveDataDirectory: () => root, dataFolders: ['devices', 'measures', 'profiles'] },
    verifyAccount: async token => ({ accountId: token?.endsWith('B') ? B : A,
      paid: token?.startsWith('pro'), paidUntil: '2099-01-01T00:00:00.000Z' }),
  });
  async function call(path, action, args = [], { token, datasetId, datasetGeneration } = {}) {
    const request = Readable.from([Buffer.from(JSON.stringify({ action, args, datasetId, datasetGeneration }))]);
    request.method = 'POST'; request.headers = { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) };
    const headers = new Map(); const response = { status: 0, body: null,
      writeHead(status, extra) { this.status = status; this.headersSent = true; for (const [key,value] of Object.entries(extra)) headers.set(key,value); },
      setHeader(key,value) { headers.set(key,value); }, end(value) { this.body = JSON.parse(value); },
    };
    await api.handle(request, response, path);
    return response;
  }
  const install = (action, args, options) => call('/api/installation', action, args, options);
  const session = (action, args, options) => call('/api/session', action, args, options);
  return { install, session };
}
test('local anonymous use stays available; binding, switching and explicit logout isolate data', async t => {
  const { install, session } = await setup(t);
  let context = (await install('context')).body;
  assert.equal(context.datasetId, 'local');
  let result = await session('saveProfile', [{ name: 'Alice', sex: 'F', age: 30, heightCm: 165 }], context);
  assert.equal(result.status, 200);
  context = (await install('activate', [A, 'attach', [], false], { token: 'freeA' })).body;
  result = await session('load', [], context);
  assert.equal(result.body.profiles[0].name, 'Alice');
  assert.equal((await session('pendingTransactions', [], { ...context, token: 'freeA' })).status, 403);
  const previous = context;
  context = (await install('activate', [B, 'attach', [], false], { token: 'freeB' })).body;
  assert.deepEqual((await session('load', [], context)).body.profiles, []);
  assert.equal((await session('load', [], previous)).status, 409);
  context = (await install('activate', [A, 'existing'], { token: 'freeA' })).body;
  assert.equal((await session('load', [], context)).body.profiles[0].name, 'Alice');
  assert.equal((await install('logout')).body.locked, true);
  assert.equal((await session('load', [], context)).status, 401);
});
test('PRO token for another account cannot unlock local features, and old same-account generations are rejected', async t => {
  const { install, session } = await setup(t);
  const before = (await install('activate', [A, 'attach', [], false], { token: 'freeA' })).body;
  assert.equal((await session('exportFiles', [], { ...before, token: 'proB' })).status, 403);
  assert.equal((await session('exportFiles', [], { ...before, token: 'proA' })).status, 200);
  const after = (await install('activate', [A, 'remote', [], true], { token: 'proA' })).body;
  assert.ok(after.datasetGeneration > before.datasetGeneration);
  assert.equal((await session('load', [], before)).status, 409);
  assert.equal((await session('load', [], { datasetId: A })).status, 409);
  assert.equal((await session('load', [], after)).status, 200);
});

test('manual readings remain available in FREE and survive file reloads within their dataset', async t => {
  const { install, session } = await setup(t);
  let context = (await install('context')).body;
  let result = await session('saveManualMeasurement', [{ weight: '72,4', receivedAt: '2020-01-02T10:30:00.000Z', profileUuid: null }], context);
  assert.equal(result.status, 200);
  assert.equal(result.body.measurements[0].measures.weight, 72.4);
  assert.equal(result.body.measurements[0].device.source, 'manual');
  assert.deepEqual(result.body.devices, []);
  const id = result.body.measurements[0].uuid;
  result = await session('reload', [], context);
  assert.equal(result.status, 200);
  assert.equal(result.body.measurements[0].uuid, id);
  assert.equal(result.body.measurements[0].reception, null);
  context = (await install('activate', [A, 'attach', [], false], { token: 'freeA' })).body;
  result = await session('saveProfile', [{ name: 'Alice', sex: 'F', age: 40, heightCm: 165 }], context);
  const profileUuid = result.body.profiles[0].uuid;
  result = await session('saveManualMeasurement', [{ weight: 65, fatPercent: 30, profileUuid }], context);
  assert.equal(result.status, 200);
  const row = result.body.measurements.find(row => row.profile?.uuid === profileUuid);
  assert.equal(row.measures.fatPercent, 30);
  assert.equal(row.measures.impedanceOhms, null);
  assert.ok(row.calculations.impedanceOhms > 0);
  const before = context;
  context = (await install('activate', [B, 'attach', [], false], { token: 'freeB' })).body;
  assert.deepEqual((await session('load', [], context)).body.measurements, []);
  assert.equal((await session('saveManualMeasurement', [{ weight: 70 }], before)).status, 409);
});
