'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { withInstallationLock, acquireInstallationLock } = require('./installation-lock.cjs');
const accounts = require('./account-storage.cjs');
const A = '11111111-1111-4111-8111-111111111111';
function root(t) { const path = fs.mkdtempSync(join(tmpdir(), 'epi-lock-')); t.after(() => fs.rmSync(path, { recursive: true, force: true })); return path; }

test('a live writer prevents another process from migrating or switching the installation', t => {
  const dir = root(t); accounts.initializeInstallation(dir);
  withInstallationLock(dir, () => {
    fs.writeFileSync(join(dir, 'local', 'session.json'), '{}');
    const child = spawnSync(process.execPath, ['-e',
      "try { require(process.argv[1]).activateAccountDataset(process.argv[2], process.argv[3], 'attach'); process.exitCode=2; } catch(e) { process.stdout.write(e.code || e.message); process.exitCode=e.code === 'installation_busy' ? 0 : 3; }",
      require.resolve('./account-storage.cjs'), dir, A], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'installation_busy');
    assert.equal(fs.existsSync(join(dir, 'accounts', A)), false);
    assert.equal(fs.readFileSync(join(dir, 'local/session.json'), 'utf8'), '{}');
  });
  accounts.activateAccountDataset(dir, A, 'attach'); assert.equal(accounts.getDatasetContext(dir).activeAccountId, A);
});
test('nested and asynchronous holders release only when their outer operation completes', async t => {
  const dir = root(t); const release = acquireInstallationLock(dir); const second = acquireInstallationLock(dir);
  second(); assert.equal(fs.existsSync(join(dir, '.installation.lock')), true); release();
  await withInstallationLock(dir, async () => { await Promise.resolve(); assert.equal(fs.existsSync(join(dir, '.installation.lock')), true); });
  assert.equal(fs.existsSync(join(dir, '.installation.lock')), false);
});
test('dead PID and old ownerless directory are recovered, fresh ownerless directory stays locked', t => {
  const dir = root(t); const path = join(dir, '.installation.lock'); fs.mkdirSync(path);
  fs.writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  acquireInstallationLock(dir)(); assert.equal(fs.existsSync(path), false);
  fs.mkdirSync(path); assert.throws(() => acquireInstallationLock(dir), error => error.code === 'installation_busy');
  const old = new Date(Date.now() - 60000); fs.utimesSync(path, old, old);
  acquireInstallationLock(dir)(); assert.equal(fs.existsSync(path), false);
});
test('a stage refuses to discard source files written after its snapshot', t => {
  const dir = root(t); accounts.initializeInstallation(dir);
  fs.mkdirSync(join(dir, 'local/profiles'), { recursive: true });
  fs.writeFileSync(join(dir, 'local/profiles/profil-alice.json'), '{"name":"Alice"}');
  const stage = accounts.stageAccountDataset(dir, A, 'attach');
  fs.writeFileSync(join(dir, 'local/profiles/profil-bob.json'), '{"name":"Bob"}');
  assert.throws(() => stage.commit(), error => error.code === 'dataset_changed'); stage.abort();
  assert.equal(accounts.getDatasetContext(dir).datasetId, 'local');
  assert.equal(fs.existsSync(join(dir, 'local/profiles/profil-bob.json')), true);
});
