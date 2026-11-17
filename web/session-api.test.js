import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import domain from '../tauri/domain/session.cjs';
import transactions from '../shared/transactions.cjs';
import { accountApi, createPaidUntilReader } from './account-api.js';
import { fileStorage } from './file-storage.js';
import { createSessionApi } from './session-api.js';

test('verified PRO rights refresh, expire and stay isolated by account during outages', async () => {
  let time = Date.parse('2026-11-17T10:00:00Z');
  let expiry = time + 120_000;
  let offline = false;
  let invalid = false;
  let calls = 0;
  const readPaidUntil = createPaidUntilReader({
    now: () => time,
    request: async (url, { headers }) => {
      calls++;
      assert.equal(url, accountApi + '/v1/account');
      assert.match(headers.Authorization, /^Bearer /);
      if (offline) throw new Error('Offline');
      if (invalid) return Response.json({}, { status: 401 });
      return Response.json(headers.Authorization === 'Bearer pro'
        ? { paid: true, paidUntil: new Date(expiry).toISOString() } : { paid: false, paidUntil: null });
    },
  });
  assert.equal(await readPaidUntil(), 0);
  assert.equal(calls, 0);
  assert.equal(await readPaidUntil('pro'), expiry);
  assert.equal(await readPaidUntil('pro'), expiry);
  assert.equal(calls, 1);
  assert.equal(await readPaidUntil('free'), 0);
  assert.equal(await readPaidUntil('free'), 0);
  assert.equal(calls, 2);
  offline = true;
  assert.equal(await readPaidUntil('other'), 0);
  time += 61_000;
  assert.equal(await readPaidUntil('pro'), expiry);
  time += 60_000;
  assert.ok(await readPaidUntil('pro') <= time);
  offline = false;
  expiry = time + 120_000;
  assert.equal(await readPaidUntil('pro', true), expiry);
  invalid = true;
  assert.equal(await readPaidUntil('pro', true), 0);
  invalid = false;
  expiry = time + 10_000;
  assert.equal(await readPaidUntil('pro', true), expiry);
  time = expiry;
  expiry = time + 120_000;
  assert.equal(await readPaidUntil('pro'), expiry);
});

test('web session enforces PRO on ZIP and named views, preserving them across FREE and renewal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'epi-web-pro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-11-17T10:00:00Z');
  let expiry = time + 120_000;
  let pro = true;
  const readPaidUntil = createPaidUntilReader({
    now: () => time,
    request: async (_url, { headers }) => {
      if (headers.Authorization === 'Bearer invalid') return Response.json({}, { status: 401 });
      return Response.json(headers.Authorization === 'Bearer pro' && pro
        ? { paid: true, paidUntil: new Date(expiry).toISOString() } : { paid: false });
    },
  });
  const files = fileStorage(root, transactions);
  const seed = domain.createSession({ storage: files });
  await seed.saveProfile({ name: 'Alice', sex: 'F', age: 45, heightCm: 165 });
  const { handleAction } = await createSessionApi({
    root, domain, transactions, now: () => time, readPaidUntil,
    storage: { dataFolders: ['devices', 'measures', 'profiles'], resolveDataDirectory: () => root },
  });
  async function request(action, args = [], token, extra = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ action, args, ...extra }))]);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) };
    const result = {};
    await handleAction(req, {
      setHeader() {},
      writeHead(status) { result.status = status; },
      end(body) { result.body = JSON.parse(body); },
    });
    return result;
  }

  const initial = await request('load');
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.proViews, false);
  for (const token of [undefined, 'free', 'invalid']) {
    for (const [action, args] of [
      ['exportFiles', []], ['importFiles', [[]]], ['importLegacy', [{}]],
      ['changeViewPreset', ['Alice', 'measurements', 'create', { name: 'Forbidden' }]],
    ]) {
      assert.equal((await request(action, args, token, { paid: true, paidUntil: new Date(expiry).toISOString() })).status, 403);
    }
  }
  assert.equal((await request('load', [], 'pro')).body.proViews, true);
  await request('setColumnPreference', ['Alice', 'fatPercent', 'columns', true], 'pro');
  const created = await request('changeViewPreset', ['Alice', 'measurements', 'create', { name: 'Mesures PRO' }], 'pro');
  assert.equal(created.status, 200);
  const presets = created.body.viewPresets;
  const preferences = (await files.load()).profilePreferences;
  const archive = await request('exportFiles', [], 'pro');
  assert.equal(archive.status, 200);
  assert.ok(archive.body.files.some(file => file.path.startsWith('prefs/measurements/')));
  assert.equal((await request('importFiles', [archive.body.files], 'pro')).status, 200);
  assert.equal((await request('importLegacy', [{}], 'pro')).status, 200);

  // Different browsers share the dataset, while every queued action uses its own account.
  const [paid, free] = await Promise.all([request('refreshView', [], 'pro'), request('refreshView')]);
  assert.equal(paid.body.proViews, true);
  assert.equal(free.body.proViews, false);
  assert.deepEqual(free.body.viewLayouts.measurements.presets, []);
  await request('setColumnPreference', ['Alice', 'impedanceOhms', 'columns', true]);
  assert.deepEqual((await files.load()).viewPresets, presets);
  assert.deepEqual((await files.load()).profilePreferences, preferences);

  time = expiry;
  assert.equal((await request('refreshView', [], 'pro')).body.proViews, false);
  assert.equal((await request('exportFiles', [], 'pro')).status, 403);
  pro = false;
  assert.equal((await request('refreshView', [], 'pro')).body.proViews, false);
  expiry = time + 120_000;
  pro = true;
  const renewed = await request('refreshView', [], 'pro');
  assert.equal(renewed.body.proViews, true);
  assert.equal(renewed.body.viewLayouts.measurements.preset.name, 'Mesures PRO');
  assert.deepEqual(renewed.body.viewPresets, presets);
  assert.equal((await request('refreshView')).body.proViews, false);
  assert.equal((await request('exportFiles')).status, 403);
});
