'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { replayTransactions, saveChanges, serialize } = require('./transactions.cjs');

function directory(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'epi-transactions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('replays a batch, an update and a delete, then purges duplicates without applying them', t => {
  const origin = directory(t);
  const replica = directory(t);
  const incoming = join(replica, 'transactions.incoming');
  const profile = 'profiles/profil-alice.json';
  const prefs = 'prefs/profil-Alice.json';
  const alice = serialize({ name: 'Alice' });
  const updated = serialize({ name: 'Alice', heightCm: 170 });
  saveChanges(origin, [{ path: profile, after: alice }, { path: prefs, after: serialize({ theme: 'dark' }) }]);
  saveChanges(origin, [{ path: profile, before: alice, after: updated }]);
  saveChanges(origin, [{ path: prefs, before: serialize({ theme: 'dark' }) }]);
  const archive = join(origin, 'transactions');
  const names = fs.readdirSync(archive).sort();
  assert.equal(names.length, 3);
  assert.deepEqual(names.map(name => JSON.parse(fs.readFileSync(join(archive, name))).type),
    ['batch', 'update', 'delete']);
  fs.cpSync(archive, incoming, { recursive: true });

  assert.equal(replayTransactions(replica), 3);
  assert.equal(fs.readFileSync(join(replica, profile), 'utf8'), updated);
  assert.equal(fs.existsSync(join(replica, prefs)), false);
  assert.deepEqual(fs.readdirSync(incoming), []);
  assert.deepEqual(fs.readdirSync(join(replica, 'transactions')).sort(), names);
  const index = join(replica, 'transactions.index');
  assert.equal(fs.readFileSync(index, 'utf8'), fs.readFileSync(join(origin, 'transactions.index'), 'utf8'));
  for (const name of names) {
    assert.deepEqual(fs.readFileSync(join(replica, 'transactions', name)), fs.readFileSync(join(archive, name)));
  }

  const edited = serialize({ name: 'Alice', heightCm: 171 });
  saveChanges(replica, [{ path: profile, before: updated, after: edited }]);
  const currentIndex = fs.readFileSync(index, 'utf8');
  fs.cpSync(archive, incoming, { recursive: true });
  assert.equal(replayTransactions(replica), 0);
  assert.equal(fs.readFileSync(join(replica, profile), 'utf8'), edited);
  assert.deepEqual(fs.readdirSync(incoming), []);
  assert.equal(fs.readFileSync(index, 'utf8'), currentIndex);
  assert.equal(fs.readdirSync(join(replica, 'transactions')).length, 4);
});

test('recovers an archived transaction missing from the index without applying it again', t => {
  const origin = directory(t);
  const replica = directory(t);
  const path = 'prefs/global.json';
  saveChanges(origin, [{ path, after: serialize({ selectedProfile: 'Alice' }) }]);
  const incoming = join(replica, 'transactions.incoming');
  fs.cpSync(join(origin, 'transactions'), incoming, { recursive: true });
  const index = join(replica, 'transactions.index');
  fs.cpSync(incoming, join(replica, 'transactions'), { recursive: true });
  const newer = serialize({ selectedProfile: 'Bob' });
  fs.mkdirSync(join(replica, 'prefs'));
  fs.writeFileSync(join(replica, path), newer);
  assert.equal(replayTransactions(replica), 1);
  assert.equal(fs.readFileSync(join(replica, path), 'utf8'), newer);
  assert.equal(fs.readFileSync(index, 'utf8'), fs.readFileSync(join(origin, 'transactions.index'), 'utf8'));
  assert.deepEqual(fs.readdirSync(incoming), []);
});

test('rejects a path outside the data folders and retains the incoming file', t => {
  const root = directory(t);
  const incoming = join(root, 'transactions.incoming');
  const uuid = '12345678-1234-4321-8123-123456789abc';
  const name = '2026-11-15T12-00-00.000000Z-' + uuid + '.json';
  fs.mkdirSync(incoming);
  fs.writeFileSync(join(incoming, name), serialize({
    uuid, type: 'create', data: { path: 'profiles/../interface.json', value: {} },
  }));
  assert.throws(() => replayTransactions(root), /Chemin de transaction invalide/u);
  assert.deepEqual(fs.readdirSync(incoming), [name]);
  assert.equal(fs.existsSync(join(root, 'transactions.index')), false);
});
