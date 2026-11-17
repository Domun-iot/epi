'use strict';
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const contexts = new AsyncLocalStorage();
const manualContext = Symbol('manual installation lock');
const held = new Map();
const orphanGraceMs = 30000;
const busy = () => Object.assign(new Error('The data directory is in use by another process.'), { code: 'installation_busy', status: 409 });
function read(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw busy(); }
}
function lockOwner(path) {
  const value = read(path);
  return value && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff
    && typeof value.token === 'string' ? value : null;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function same(left, right) { return left?.token === right?.token && left?.pid === right?.pid; }
function stale(path, owner) {
  if (owner) return !alive(owner.pid);
  try { return Date.now() - fs.statSync(path).mtimeMs > orphanGraceMs; }
  catch { return false; }
}
function recoveryClaims(directory, ownName) {
  const claims = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ownName) continue;
    const match = /^([1-9]\d*)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) throw busy();
    const path = join(directory, entry.name), pid = Number(match[1]);
    if (!alive(pid)) { fs.rmSync(path, { recursive: true, force: true }); continue; }
    const value = read(join(path, 'ticket.json'));
    if (!value || value.pid !== pid || value.token !== match[2] || !Number.isSafeInteger(value.ticket) || value.ticket < 1) throw busy();
    claims.push(value);
  }
  return claims;
}
function withRecoveryClaim(lockPath, callback) {
  const directory = join(require('node:path').dirname(lockPath), '.installation.recovery');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw busy();
  const claim = { pid: process.pid, token: randomUUID() };
  const name = claim.pid + '-' + claim.token, path = join(directory, name);
  fs.mkdirSync(path, { mode: 0o700 });
  try {
    const earlier = recoveryClaims(directory, name);
    claim.ticket = Math.max(0, ...earlier.map(value => value.ticket)) + 1;
    if (!Number.isSafeInteger(claim.ticket)) throw busy();
    fs.writeFileSync(join(path, 'ticket.json'), JSON.stringify(claim), { flag: 'wx', mode: 0o600, flush: true });
    // An incomplete live claim is still choosing its ticket; fail closed and retry later.
    for (const other of recoveryClaims(directory, name)) {
      if (other.ticket < claim.ticket || (other.ticket === claim.ticket &&
          (other.pid < claim.pid || (other.pid === claim.pid && other.token < claim.token)))) throw busy();
    }
    return callback();
  } finally { fs.rmSync(path, { recursive: true, force: true }); }
}
function reclaim(path) {
  return withRecoveryClaim(path, () => {
    const info = fs.lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw busy();
    const ownerFile = join(path, 'owner.json'); const owner = lockOwner(ownerFile);
    if (!stale(path, owner)) throw busy();
    // A process from the earlier protocol may still be completing recovery.
    const legacyRecovery = lockOwner(join(path, 'recovery.json'));
    if (legacyRecovery && alive(legacyRecovery.pid)) throw busy();
    const current = lockOwner(ownerFile);
    if (!same(owner, current) || (current ? alive(current.pid) : Date.now() - info.mtimeMs <= orphanGraceMs)) throw busy();
    const quarantine = path + '.recovered-' + randomUUID();
    fs.renameSync(path, quarantine);
    fs.rmSync(quarantine, { recursive: true, force: true });
  });
}
function acquireInstallationLock(root) {
  const context = contexts.getStore() ?? manualContext;
  fs.mkdirSync(root, { recursive: true });
  const key = fs.realpathSync(resolve(root));
  const existing = held.get(key);
  if (existing) {
    if (existing.context !== context) throw busy();
    existing.count += 1;
    let released = false;
    return () => { if (!released) { released = true; release(key, existing); } };
  }
  const path = join(key, '.installation.lock');
  try { fs.mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { reclaim(path); }
    catch (recoveryError) {
      if (recoveryError.code === 'ENOENT' || recoveryError.code === 'EEXIST') throw busy();
      throw recoveryError;
    }
    try { fs.mkdirSync(path); } catch { throw busy(); }
  }
  const owner = { pid: process.pid, token: randomUUID() };
  try { fs.writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) { try { fs.rmdirSync(path); } catch {} throw error; }
  const state = { count: 1, owner, path, context }; held.set(key, state);
  let released = false;
  return () => { if (!released) { released = true; release(key, state); } };
}
function release(key, state) {
  state.count -= 1;
  if (state.count) return;
  held.delete(key);
  if (same(state.owner, read(join(state.path, 'owner.json')))) fs.rmSync(state.path, { recursive: true, force: true });
}
function withInstallationLock(root, callback) {
  if (contexts.getStore() === undefined) return contexts.run(Symbol('installation operation'), () => withInstallationLock(root, callback));
  const release = acquireInstallationLock(root);
  try {
    const result = callback();
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release(); return result;
  } catch (error) { release(); throw error; }
}
module.exports = { acquireInstallationLock, withInstallationLock };
