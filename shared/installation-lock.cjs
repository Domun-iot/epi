'use strict';
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const held = new Map();
const orphanGraceMs = 30000;
const busy = () => Object.assign(new Error('The data directory is in use by another process.'), { code: 'installation_busy', status: 409 });
function read(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw busy(); }
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
function reclaim(path) {
  const info = fs.lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw busy();
  const ownerFile = join(path, 'owner.json'); const owner = read(ownerFile);
  if (!stale(path, owner)) throw busy();
  const recoveryFile = join(path, 'recovery.json');
  const previous = read(recoveryFile);
  if (previous) {
    if (alive(previous.pid)) throw busy();
    if (!same(previous, read(recoveryFile))) throw busy();
    fs.unlinkSync(recoveryFile);
  } else if (fs.existsSync(recoveryFile)) {
    if (Date.now() - fs.statSync(recoveryFile).mtimeMs <= orphanGraceMs) throw busy();
    fs.unlinkSync(recoveryFile);
  }
  const recovery = { pid: process.pid, token: randomUUID() };
  let claimed = false;
  try {
    fs.writeFileSync(recoveryFile, JSON.stringify(recovery), { flag: 'wx', mode: 0o600, flush: true }); claimed = true;
    const current = read(ownerFile);
    if (!same(owner, current) || (current ? alive(current.pid) : Date.now() - info.mtimeMs <= orphanGraceMs)
        || !same(recovery, read(recoveryFile))) throw busy();
    const quarantine = path + '.recovered-' + recovery.token;
    fs.renameSync(path, quarantine);
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (claimed && same(recovery, read(recoveryFile))) fs.rmSync(recoveryFile, { force: true });
    throw error.code === 'EEXIST' || error.code === 'ENOENT' ? busy() : error;
  }
}
function acquireInstallationLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const key = fs.realpathSync(resolve(root));
  const existing = held.get(key);
  if (existing) {
    existing.count += 1;
    let released = false;
    return () => { if (!released) { released = true; release(key, existing); } };
  }
  const path = join(key, '.installation.lock');
  try { fs.mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    reclaim(path);
    try { fs.mkdirSync(path); } catch { throw busy(); }
  }
  const owner = { pid: process.pid, token: randomUUID() };
  try { fs.writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600, flush: true }); }
  catch (error) { try { fs.rmdirSync(path); } catch {} throw error; }
  const state = { count: 1, owner, path }; held.set(key, state);
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
  const release = acquireInstallationLock(root);
  try {
    const result = callback();
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release(); return result;
  } catch (error) { release(); throw error; }
}
module.exports = { acquireInstallationLock, withInstallationLock };
