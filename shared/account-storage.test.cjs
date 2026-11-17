'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const accounts = require('./account-storage.cjs');
const { findSharedData, resolveDataDirectory } = require('./data-directory.cjs');
const { integrateTransactions } = require('./transactions.cjs');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function root(t) { const path = fs.mkdtempSync(join(tmpdir(), 'epi-datasets-')); t.after(() => fs.rmSync(path, { recursive: true, force: true })); return path; }
function file(root, name, value) { const path = join(root, name); fs.mkdirSync(require('node:path').dirname(path), { recursive: true }); fs.writeFileSync(path, JSON.stringify(value)); }

test('portable discovery recognizes legacy, local and accounts-only layouts and keeps override priority', t => {
  const base = root(t); const project = join(base, 'project'); const release = join(project, 'release', 'linux');
  fs.mkdirSync(release, { recursive: true });
  for (const name of ['devices', 'measures', 'profiles']) fs.mkdirSync(join(project, 'data', name), { recursive: true });
  assert.equal(findSharedData(release), join(project, 'data'));
  fs.rmSync(join(project, 'data'), { recursive: true }); fs.mkdirSync(join(project, 'data', 'local'), { recursive: true });
  assert.equal(findSharedData(release), join(project, 'data'));
  fs.rmSync(join(project, 'data'), { recursive: true }); fs.mkdirSync(join(project, 'data', 'accounts', A), { recursive: true });
  assert.equal(findSharedData(release), join(project, 'data'));
  const previous = process.env.EPI_DATA_DIR; process.env.EPI_DATA_DIR = join(base, 'explicit');
  try { assert.equal(resolveDataDirectory(release), join(base, 'explicit')); }
  finally { if (previous === undefined) delete process.env.EPI_DATA_DIR; else process.env.EPI_DATA_DIR = previous; }
});
test('migrates legacy data and window settings without changing records and keeps backup', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice' });
  file(dir, 'prefs/global.json', { languagePreference: 'fr-FR', window: { maximized: true } });
  assert.equal(accounts.getDatasetContext(dir).datasetId, 'local');
  assert.equal(fs.existsSync(join(dir, 'profiles')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'local/profiles/profil-alice.json'))), { name: 'Alice' });
  assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, 'installation.json'))).window, { maximized: true });
  assert.equal(fs.readdirSync(join(dir, 'backups')).length, 1);
  assert.equal(accounts.getDatasetContext(dir).localSummary.hasData, true);
});
test('migration resumes after a directory was already moved', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice' });
  fs.mkdirSync(join(dir, 'local/devices'), { recursive: true });
  file(dir, 'migration.json', { entries: ['devices', 'profiles'] }); accounts.initializeInstallation(dir);
  assert.equal(fs.existsSync(join(dir, 'local/profiles/profil-alice.json')), true);
  assert.equal(fs.existsSync(join(dir, 'migration.json')), false);
});
test('binding snapshots legacy files for future PRO sync, keeps backup and switches accounts without merging', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice' });
  const first = accounts.activateAccountDataset(dir, A, 'attach'); assert.equal(first.datasetId, A);
  const a = accounts.resolveActiveDataset(dir, A);
  assert.equal(fs.existsSync(join(a, 'profiles/profil-alice.json')), true);
  assert.ok(fs.readdirSync(join(a, 'transactions')).length);
  assert.equal(fs.existsSync(join(dir, 'local')), false);
  assert.throws(() => accounts.resolveActiveDataset(dir, 'local'), /changed/);
  accounts.activateAccountDataset(dir, B, 'attach');
  assert.equal(fs.existsSync(join(accounts.resolveActiveDataset(dir, B), 'profiles/profil-alice.json')), false);
  accounts.activateAccountDataset(dir, A, 'existing'); assert.equal(accounts.resolveActiveDataset(dir, A), a);
});
test('logout locks permanently even if account folders are removed', t => {
  const dir = root(t); accounts.activateAccountDataset(dir, A, 'attach');
  assert.equal(accounts.logoutDataset(dir).locked, true); assert.throws(() => accounts.resolveActiveDataset(dir), /sign-in/);
  fs.rmSync(join(dir, 'accounts'), { recursive: true });
  assert.equal(accounts.getDatasetContext(dir).locked, true); assert.equal(fs.existsSync(join(dir, 'local')), false);
});
test('aborting a remote stage preserves anonymous originals and does not select the account', t => {
  const dir = root(t); file(dir, 'measures/a/2026.json', { uuid: A, receivedAt: '2026-03-01T12:00:00Z' });
  const stage = accounts.stageAccountDataset(dir, A, 'remote'); file(stage.root, 'profiles/test.json', {}); stage.abort();
  assert.equal(accounts.getDatasetContext(dir).datasetId, 'local');
  assert.equal(accounts.getDatasetContext(dir).localSummary.count, 1);
  assert.equal(accounts.getDatasetContext(dir).localSummary.from, '2026-03-01T12:00:00.000Z');
});
test('merge uses newer remote records and preserves independent anonymous files', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice', heightCm: 160, createdAt: '2026-01-01T00:00:00.000Z' });
  file(dir, 'profiles/profil-bob.json', { name: 'Bob', createdAt: '2026-01-01T00:00:00.000Z' });
  const stage = accounts.stageAccountDataset(dir, A, 'merge');
  file(stage.root, 'profiles/profil-alice.json', { name: 'Alice', heightCm: 170, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' });
  accounts.mergeAnonymousIntoStage(dir, stage.root); stage.commit();
  const selected = accounts.resolveActiveDataset(dir, A);
  assert.equal(JSON.parse(fs.readFileSync(join(selected, 'profiles/profil-alice.json'))).heightCm, 170);
  assert.equal(JSON.parse(fs.readFileSync(join(selected, 'profiles/profil-bob.json'))).name, 'Bob');
});
test('merge respects a remote deletion against a stale anonymous record', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' });
  const stage = accounts.stageAccountDataset(dir, A, 'merge');
  const uuid = randomUUID(); integrateTransactions(stage.root, [{ uuid, name: '2026-02-01T00-00-00.000000Z-' + uuid + '.json', type: 'delete', data: { path: 'profiles/profil-alice.json' } }]);
  accounts.mergeAnonymousIntoStage(dir, stage.root); stage.commit();
  assert.equal(fs.existsSync(join(accounts.resolveActiveDataset(dir, A), 'profiles/profil-alice.json')), false);
});

test('FREE attachment stays unsynchronized until explicit PRO review and replacing its dataset invalidates old work', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice' });
  const initial = accounts.activateAccountDataset(dir, A, 'attach'); assert.equal(initial.syncReady, false);
  accounts.markDatasetSyncReady(dir, A); assert.equal(accounts.getDatasetContext(dir).syncReady, true);
  const stage = accounts.stageAccountDataset(dir, A, 'remote', true);
  file(stage.root, 'profiles/profil-bob.json', { name: 'Bob' });
  const selected = stage.commit(); assert.ok(selected.datasetGeneration > initial.datasetGeneration);
  assert.throws(() => accounts.resolveActiveDataset(dir, A, initial.datasetGeneration), /changed/);
  assert.equal(fs.existsSync(join(accounts.resolveActiveDataset(dir, A), 'profiles/profil-alice.json')), false);
  assert.equal(fs.existsSync(join(accounts.resolveActiveDataset(dir, A), 'profiles/profil-bob.json')), true);
  assert.ok(fs.readdirSync(join(dir, 'backups')).some(name => name.startsWith('account-' + A)));
  assert.equal(selected.syncReady, true);
});
test('review can merge existing FREE account with newer remote snapshot and preserve another account', t => {
  const dir = root(t); file(dir, 'profiles/profil-alice.json', { name: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' });
  accounts.activateAccountDataset(dir, A, 'attach'); accounts.activateAccountDataset(dir, B, 'attach');
  const stage = accounts.stageAccountDataset(dir, A, 'merge', true);
  file(stage.root, 'profiles/profil-bob.json', { name: 'Bob', createdAt: '2026-01-01T00:00:00.000Z' });
  accounts.mergeAccountIntoStage(dir, A, stage.root); const selected = stage.commit();
  assert.equal(selected.activeAccountId, A); assert.equal(selected.syncReady, true);
  assert.equal(fs.existsSync(join(accounts.resolveActiveDataset(dir, A), 'profiles/profil-alice.json')), true);
  assert.equal(fs.existsSync(join(dir, 'accounts', B, 'profiles/profil-alice.json')), false);
});
test('a staged activation cannot overwrite a more recent account switch', t => {
  const dir = root(t); const stage = accounts.stageAccountDataset(dir, A, 'attach');
  accounts.activateAccountDataset(dir, B, 'attach');
  assert.throws(() => stage.commit(), /changed/); stage.abort();
  assert.equal(accounts.getDatasetContext(dir).activeAccountId, B);
});
