'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { withInstallationLock } = require('../shared/installation-lock.cjs');
const accounts = require('../shared/account-storage.cjs');
const storage = require('./storage.cjs');
function root(t) { const path = fs.mkdtempSync(join(tmpdir(), 'epi-cli-storage-')); t.after(() => fs.rmSync(path, { recursive: true, force: true })); return path; }

test('profile enumeration cannot rename legacy records while another process holds the installation', t => {
  const dir = root(t); accounts.initializeInstallation(dir); fs.mkdirSync(join(dir, 'local/profiles'));
  fs.writeFileSync(join(dir, 'local/profiles/profil-alice.json'), '{"name":"Alice"}');
  withInstallationLock(dir, () => {
    const child = spawnSync(process.execPath, ['-e',
      "require(process.argv[1]).listProfiles(require(process.argv[2]).profileDirectory).then(() => process.exitCode=2).catch(e => { process.stdout.write(e.code || e.message); process.exitCode=e.code === 'installation_busy' ? 0 : 3; });",
      require.resolve('./profile-choice.cjs'), require.resolve('./storage.cjs')], { env: { ...process.env, EPI_DATA_DIR: dir }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'installation_busy');
    assert.deepEqual(fs.readdirSync(join(dir, 'local/profiles')), ['profil-alice.json']);
  });
});
test('measurement storage rejects a profile UUID that could escape its dataset', t => {
  const dir = root(t); const measures = join(dir, 'data/measures');
  assert.throws(() => storage.writeMeasurement({ profile: { uuid: '../../escaped', name: 'Alice' }, receivedAt: '2026-01-01T00:00:00Z' }, measures), /UUID/);
  assert.equal(fs.existsSync(join(dir, 'escaped')), false); assert.equal(fs.existsSync(measures), false);
});
