import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import domain from '../domain/session.cjs';
import versions from '../../shared/record-version.cjs';
import transactions from '../../shared/transactions.cjs';
import { fileStorage } from '../../web/file-storage.js';
import { createBrowserStorage, browserStorageKey } from '../src/storage/browser-storage.js';
import { sharedWebAdapter } from '../src/storage/adapters.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const pro = { accountId, paid: true, paidUntil: '2099-01-01T00:00:00.000Z' };
const free = { accountId, paid: false, paidUntil: null };
const alice = { name: 'Alice', sex: 'F', age: 40, heightCm: 165 };
class MemoryStorage {
  data = new Map();
  fail = false;
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { if (this.fail) throw new Error('QuotaExceededError'); this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}
function setup(storage = new MemoryStorage()) {
  const adapter = createBrowserStorage({ storage, domain, versions });
  return { storage, adapter, session: async () => {
    const context = await adapter.backend.context();
    const files = adapter.files(context);
    const session = domain.createSession({ storage: files, hasProViews: () => true });
    await session.load();
    return { context, files, session };
  } };
}
async function attach(adapter, info = free, mode = 'attach', files = [], revision) {
  await adapter.backend.prepare(info.accountId);
  return adapter.backend.activate(info.accountId, mode, files, '', info.paid, revision);
}
function row(type, path, value, stamp) {
  const uuid = crypto.randomUUID();
  return { uuid, name: stamp + '-' + uuid + '.json', type, data: { path, ...(type !== 'delete' && { value }) } };
}

test('an empty visit writes no flag; first persisted data pins the browser and survives restart', async () => {
  const f = setup(), { session } = await f.session();
  assert.equal(await f.adapter.hasLocalUsage(), false);
  assert.equal(f.storage.getItem(browserStorageKey), null);
  await session.saveProfile(alice);
  assert.equal(await f.adapter.hasLocalUsage(), true);
  const restarted = setup(f.storage), current = await restarted.session();
  assert.equal((await current.session.load()).profiles[0].name, 'Alice');
  assert.ok((await current.files.pendingTransactions()).length);
});

test('confirmed FREE pins even an empty browser; PRO after FREE or guest data stays local', async () => {
  for (const useGuest of [false, true]) {
    const storage = new MemoryStorage();
    const adapter = sharedWebAdapter({ storage, domain, versions, getToken: () => '', hasSavedAccount: () => false });
    await adapter.backend.context();
    if (useGuest) {
      const opened = adapter.open({ binding: await adapter.backend.context(), current: () => true,
        onState: () => {}, onTransactions: () => {}, hasProViews: () => false });
      await opened.load(); await opened.saveProfile(alice);
    } else {
      await adapter.backend.select(free);
      assert.equal(JSON.parse(storage.getItem(browserStorageKey)).usageLocal, true);
    }
    await adapter.backend.select(pro);
    assert.equal(adapter.kind, 'browser-local');
    assert.equal(adapter.remote, false);
  }
});

test('a new PRO browser selects the API without creating local data; an unverified saved login starts locked', async () => {
  const storage = new MemoryStorage();
  const adapter = sharedWebAdapter({ storage, domain, versions, getToken: () => 'token', hasSavedAccount: () => true });
  assert.equal((await adapter.backend.context()).locked, true);
  await adapter.backend.select(pro);
  assert.equal(adapter.kind, 'hosted-api');
  assert.equal(adapter.synchronizes, false);
  assert.equal(storage.getItem(browserStorageKey), null);
  await adapter.backend.select(free);
  assert.equal(adapter.kind, 'browser-local');
  assert.equal(JSON.parse(storage.getItem(browserStorageKey)).usageLocal, true);
});

test('account attachment, logout and A/B/A preserve isolation and reject stale generations', async () => {
  const f = setup();
  let { session, files } = await f.session();
  await session.saveProfile(alice);
  const first = await attach(f.adapter);
  await assert.rejects(files.save(await session.load()), { code: 'dataset_changed' });
  ({ session } = await f.session());
  assert.equal((await session.load()).profiles[0].name, 'Alice');
  await f.adapter.backend.logout();
  assert.equal((await f.adapter.backend.context()).locked, true);
  await attach(f.adapter, { ...free, accountId: secondId });
  ({ session } = await f.session());
  assert.deepEqual((await session.load()).profiles, []);
  await session.saveProfile({ ...alice, name: 'Bob' });
  await attach(f.adapter, free, 'existing');
  const current = await f.session();
  assert.equal((await current.session.load()).profiles[0].name, 'Alice');
  await assert.rejects(f.adapter.backend.confirmSync(accountId, first.datasetGeneration), { code: 'dataset_changed' });
});

test('quota failures leave both data and journal unchanged and retry remains possible', async () => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  const before = f.storage.getItem(browserStorageKey), pending = await files.pendingTransactions();
  f.storage.fail = true;
  await assert.rejects(session.saveProfile({ ...alice, name: 'Bob' }), /browserStorageUnavailable/);
  assert.equal(f.storage.getItem(browserStorageKey), before);
  assert.deepEqual(await files.pendingTransactions(), pending);
  assert.equal((await session.load()).profiles.length, 1);
  f.storage.fail = false;
  await session.saveProfile({ ...alice, name: 'Bob' });
  assert.equal((await session.load()).profiles.length, 2);
});

test('a concurrent tab cannot overwrite data loaded before another tab saved', async () => {
  const f = setup(), first = await f.session(), second = await setup(f.storage).session();
  await first.session.saveProfile(alice);
  await assert.rejects(second.session.saveProfile({ ...alice, name: 'Bob' }), { code: 'dataset_changed' });
  await second.session.reload();
  await second.session.saveProfile({ ...alice, name: 'Bob' });
  assert.equal((await second.session.load()).profiles.length, 2);
});

test('a mutation during the first-sync choice invalidates activation without replacing the dataset', async () => {
  const f = setup(), { session } = await f.session();
  await session.saveProfile(alice);
  await f.adapter.backend.prepare(accountId);
  await session.setTheme('Alice', 'dark');
  await assert.rejects(f.adapter.backend.activate(accountId, 'remote', [], '', true, 'a'.repeat(64)), { code: 'dataset_changed' });
  assert.equal((await f.adapter.backend.context()).datasetId, 'local');
  assert.equal((await session.load()).profiles[0].name, 'Alice');
});

test('preferences, notifications, pending readings and presets survive ZIP and Node file adapter roundtrips', async t => {
  const f = setup(), current = await f.session();
  await current.session.saveProfile(alice);
  await current.session.setTheme('Alice', 'dark');
  const state = await current.session.load();
  assert.equal(state.theme, 'dark');
  const pendingId = crypto.randomUUID(), presetId = crypto.randomUUID();
  await current.files.save({ ...state,
    pending: [{ uuid: pendingId, receivedAt: '2026-11-17T12:00:00.000Z', measures: { weight: 70, unit: 'kg' } }],
    viewPresets: { measurements: [{ id: presetId, name: 'Overview', layout: { columns: ['bmi'], splitColumns: [], columnOrder: [] } }], details: [] },
  });
  const archive = await current.files.exportFiles();
  const g = setup(), other = await g.session();
  await other.files.importFiles(archive);
  assert.equal((await other.session.reload()).theme, 'dark');
  const root = await mkdtemp(join(tmpdir(), 'epi-browser-port-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['profiles', 'devices', 'measures']) await mkdir(join(root, name), { recursive: true });
  const disk = fileStorage(root, transactions);
  await disk.importFiles(archive);
  assert.equal((await disk.load()).profiles[0].name, 'Alice');
  const diskState = await disk.load();
  assert.equal(diskState.profilePreferences.Alice.theme, 'dark');
  assert.equal(diskState.pending[0].uuid, pendingId);
  assert.equal(diskState.viewPresets.measurements[0].id, presetId);
  assert.ok(diskState.notifications.length);
  // A second browser can consume the exact existing server/native ZIP protocol.
  const h = setup(), third = await h.session();
  await third.files.importFiles(await disk.exportFiles());
  assert.equal((await third.session.reload()).theme, 'dark');
});

test('browser transactions replay in Node, and Node transactions replay in the browser', async t => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  const root = await mkdtemp(join(tmpdir(), 'epi-browser-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = await files.pendingTransactions();
  const rows = pending.map(({ name, transaction }) => ({ ...transaction, name }));
  assert.deepEqual(transactions.integrateTransactions(root, rows).uuids.sort(), rows.map(row => row.uuid).sort());
  const disk = fileStorage(root, transactions), snapshot = await disk.load();
  assert.equal(snapshot.profiles[0].name, 'Alice');
  const update = row('update', 'profiles/' + snapshot.profiles[0].uuid + '.json',
    { ...snapshot.profiles[0], name: 'Updated', updatedAt: '2090-01-01T00:00:00.000Z' }, '2090-01-01T00-00-00.000001Z');
  assert.deepEqual((await files.integrateTransactions([update])).uuids, [update.uuid]);
  assert.equal((await session.reload()).profiles[0].name, 'Updated');
  await files.archiveTransactions(pending.map(entry => entry.name));
  assert.deepEqual(await files.pendingTransactions(), []);
});

test('deletions survive duplicate delivery, old writes, ZIP backup and repair', async () => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  const profile = (await session.load()).profiles[0], path = 'profiles/' + profile.uuid + '.json';
  const deletion = row('delete', path, undefined, '2090-01-01T00-00-00.000001Z');
  const old = row('update', path, { ...profile, updatedAt: '2089-01-01T00:00:00.000Z' }, '2091-01-01T00-00-00.000001Z');
  await files.integrateTransactions([deletion, deletion, old]);
  assert.deepEqual((await session.reload()).profiles, []);
  const archive = await files.exportFiles(), g = setup(), other = await g.session();
  await other.files.importFiles(archive);
  const staleAfterRestore = row('update', path, old.data.value, '2091-02-01T00-00-00.000001Z');
  await other.files.integrateTransactions([staleAfterRestore]);
  assert.deepEqual((await other.session.reload()).profiles, []);
  const restored = row('create', path, { ...profile, updatedAt: '2092-01-01T00:00:00.000Z' }, '2092-01-01T00-00-00.000001Z');
  await other.files.integrateTransactions([restored]);
  assert.equal((await other.session.reload()).profiles.length, 1);
});

test('legacy browser data migrates with a baseline journal while retaining original recovery keys', async () => {
  const storage = new MemoryStorage();
  storage.setItem('epi-session-v1', JSON.stringify({ profiles: [alice] }));
  const f = setup(storage), { session, files } = await f.session();
  assert.equal((await session.load()).profiles[0].name, 'Alice');
  assert.equal(await f.adapter.hasLocalUsage(), true);
  assert.ok((await files.pendingTransactions()).length);
  assert.ok(storage.getItem('epi-session-v1'));
});

test('malformed archives and unsupported storage versions fail before replacing any saved data', async () => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  const before = f.storage.getItem(browserStorageKey);
  await assert.rejects(files.importFiles([{ path: '../unsafe.json', contents: '{}' }]));
  assert.equal(f.storage.getItem(browserStorageKey), before);
  f.storage.setItem(browserStorageKey, JSON.stringify({ version: 7, datasets: {} }));
  await assert.rejects(f.adapter.backend.context(), /browserStorageUnavailable/);
});


test('unknown billing rights never pin a clean browser, while an existing local mode remains local', async () => {
  const storage = new MemoryStorage();
  const adapter = sharedWebAdapter({ storage, domain, versions, getToken: () => '', hasSavedAccount: () => false });
  await adapter.backend.context();
  await assert.rejects(adapter.backend.select({ ...free, entitlementVerified: false }), /accountServerUnavailable/);
  assert.equal(storage.getItem(browserStorageKey), null);
  await adapter.backend.select(free);
  await adapter.backend.select({ ...pro, entitlementVerified: false });
  assert.equal(adapter.kind, 'browser-local');
});

test('first merge and same-account repair retain local deletions and the reviewed revision', async () => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  const oldRemote = await files.exportFiles();
  await session.deleteProfile('Alice');
  const context = await attach(f.adapter, pro, 'merge', oldRemote, 'a'.repeat(64));
  assert.equal(context.syncReady, true);
  assert.equal(context.syncRevision, 'a'.repeat(64));
  let current = await f.session();
  assert.deepEqual((await current.session.load()).profiles, []);
  await f.adapter.backend.confirmSync(accountId, context.datasetGeneration);
  assert.equal((await f.adapter.backend.context()).syncRevision, undefined);
  await attach(f.adapter, pro, 'merge', oldRemote, 'b'.repeat(64));
  current = await f.session();
  assert.deepEqual((await current.session.load()).profiles, []);
  assert.equal(current.context.syncRevision, 'b'.repeat(64));
  assert.ok((await current.files.pendingTransactions()).length);
});

test('incoming ZIP transactions are replayed once and remain queued for future PRO sync', async () => {
  const f = setup(), { session, files } = await f.session();
  const id = crypto.randomUUID();
  const entry = row('create', 'profiles/' + id + '.json', { ...alice, uuid: id }, '2026-11-17T12-00-00.000001Z');
  const { name, ...transaction } = entry;
  const archive = [{ path: 'transactions.incoming/' + name, contents: JSON.stringify(transaction) }];
  await files.importFiles(archive);
  assert.equal((await session.reload()).profiles[0].name, 'Alice');
  assert.ok((await files.pendingTransactions()).some(row => row.transaction.uuid === entry.uuid));
  await files.importFiles(archive);
  assert.equal((await session.reload()).profiles.length, 1);
});


test('reimporting legacy ZIP paths does not duplicate canonical records or overwrite newer local data', async () => {
  const f = setup(), { session, files } = await f.session();
  await session.saveProfile(alice);
  await session.setTheme('Alice', 'dark');
  const original = (await session.load()).profiles[0];
  const archive = [
    { path: 'profiles/profil-alice.json', contents: JSON.stringify({ ...alice, age: 20 }) },
    { path: 'profiles/' + original.uuid.toUpperCase() + '.json', contents: JSON.stringify({ ...original, age: 25 }) },
  ];
  await files.importFiles(archive);
  const state = await session.reload();
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0].age, 40);
  assert.equal(state.theme, 'dark');
});
