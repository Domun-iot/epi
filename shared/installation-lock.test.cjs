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

test('unrelated asynchronous work in the same process cannot enter another operation lock', async t => {
  const dir = root(t); let release; const gate = new Promise(resolve => { release = resolve; });
  const first = withInstallationLock(dir, async () => { await gate; });
  assert.throws(() => withInstallationLock(dir, () => {}), error => error.code === 'installation_busy');
  release(); await first; withInstallationLock(dir, () => {});
});
test('a dead immutable recovery claimant is cleaned without touching a live choosing claimant', t => {
  const dir = root(t); const locks = join(dir, '.installation.lock'), claims = join(dir, '.installation.recovery');
  fs.mkdirSync(locks); fs.writeFileSync(join(locks, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const dead = '2147483647-11111111-1111-4111-8111-111111111111'; fs.mkdirSync(join(claims, dead), { recursive: true });
  acquireInstallationLock(dir)(); assert.equal(fs.existsSync(join(claims, dead)), false);
  fs.mkdirSync(locks); fs.writeFileSync(join(locks, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const choosing = process.pid + '-22222222-2222-4222-8222-222222222222'; fs.mkdirSync(join(claims, choosing));
  assert.throws(() => acquireInstallationLock(dir), error => error.code === 'installation_busy');
  assert.equal(fs.existsSync(join(claims, choosing)), true);
});

test('simultaneous recovery attempts never overlap live process critical sections', async t => {
  const dir = root(t); fs.mkdirSync(join(dir, '.installation.lock'));
  fs.writeFileSync(join(dir, '.installation.lock/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const { spawn } = require('node:child_process');
  const script = "const fs=require('node:fs'),path=require('node:path'); const acquire=require(process.argv[1]).acquireInstallationLock; const root=process.argv[2]; const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)); (async()=>{ while(!fs.existsSync(path.join(root,'go'))) await delay(2); for(let i=0;i<200;i++){ let release; try{ release=acquire(root); }catch(e){ if(e.code==='installation_busy'){await delay(2);continue;} throw e; } try{ fs.writeFileSync(path.join(root,'critical'),String(process.pid),{flag:'wx'}); await delay(15); fs.unlinkSync(path.join(root,'critical')); }finally{release();} return;} throw Error('lock starvation'); })().catch(e=>{console.error(e.stack);process.exitCode=1});";
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', script, require.resolve('./installation-lock.cjs'), dir], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const completions = children.map(child => new Promise((resolve, reject) => { let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject); child.once('close', status => status === 0 ? resolve() : reject(new Error(stderr))); }));
  fs.writeFileSync(join(dir, 'go'), ''); const results = await Promise.allSettled(completions);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assert.equal(fs.existsSync(join(dir, 'critical')), false); assert.equal(fs.existsSync(join(dir, '.installation.lock')), false);
});
