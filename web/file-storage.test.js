import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import domain from '../tauri/domain/session.cjs';
import transactions from '../shared/transactions.cjs';
import { fileStorage } from './file-storage.js';
import { readArchive, writeArchive } from '../tauri/src/legacy-import.js';

test('shares native dataset files across web restarts and reloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'epi-web-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, value) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }
  const get = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
  const open = () => domain.createSession({ storage: fileStorage(root, transactions) });
  const profile = { name: 'Lou', sex: 'F', birthDate: '1990-02-12', heightCm: 170 };
  const device = { name: 'Cuisine', bluetooth: { address: 'AA:BB:CC:DD:EE:FF', serviceUuid: '0x181B' } };
  const measure = { receivedAt: '2026-09-28T09:00:00.000Z', profile: { name: 'Lou' },
    measures: { weight: 70.15, unit: 'kg' } };
  await put('session.json', { profiles: [{ name: 'Obsolete' }] });
  await put('profiles/profil-lou.json', profile);
  await put('devices/cuisine.json', device);
  await put('measures/lou/first.json', measure);
  await put('prefs/profil-Lou.json', { columns: ['bmi', 'fatPercent'] });
  await put('prefs/global.json', { window: { width: 900 } });

  const web = open();
  const initial = await web.load();
  const profileId = initial.profiles[0].uuid;
  const measurementId = initial.measurements[0].uuid;
  assert.deepEqual(initial.profiles.map(row => row.name), ['Lou']);
  assert.deepEqual(initial.columns, ['bmi', 'fatPercent']);
  assert.equal((await get('measures/lou/first.json')).profile.uuid, profileId);
  assert.equal((await get('devices/' + initial.devices[0].uuid + '.json')).name, device.name);
  await assert.rejects(get('profiles/profil-lou.json'), { code: 'ENOENT' });
  await web.saveProfile({ ...profile, editUuid: profileId, name: 'Louise' });
  assert.equal((await get('profiles/' + profileId + '.json')).name, 'Louise');
  assert.deepEqual(await get('prefs/profil-Louise.json'), { columns: ['bmi', 'fatPercent'] });
  assert.equal((await get('prefs/global.json')).window.width, 900);
  const configured = await web.changeViewPreset('Louise', 'measurements', 'create', { name: 'Weekly' });
  const preset = configured.viewPresets.measurements[0];
  assert.deepEqual(await get('prefs/measurements/' + preset.id + '.json'), preset);

  await web.deleteMeasurement({ uuid: measurementId });
  await assert.rejects(get('measures/lou/first.json'), { code: 'ENOENT' });
  const restarted = open();
  const reloaded = await restarted.load();
  assert.equal(reloaded.measurements.length, 0);
  assert.deepEqual(reloaded.viewPresets.measurements, [preset]);
  const deletion = reloaded.notifications.find(row => row.type === 'measurement' && row.action === 'deleted');
  assert.equal((await get('notifications/' + deletion.id + '.json')).record.uuid, measurementId);
  const archive = readArchive(writeArchive(await fileStorage(root, transactions).exportFiles()));
  const paths = archive.map(file => file.path);
  assert.ok(paths.includes('prefs/global.json'));
  assert.ok(paths.includes('prefs/profil-Louise.json'));
  assert.ok(paths.includes('notifications/' + deletion.id + '.json'));
  assert.ok(paths.includes('transactions.index'));
  assert.ok(paths.some(path => path.startsWith('transactions/')));
  const restoredRoot = await mkdtemp(join(tmpdir(), 'epi-web-restore-'));
  t.after(() => rm(restoredRoot, { recursive: true, force: true }));
  const restored = fileStorage(restoredRoot, transactions);
  assert.ok(await restored.importFiles(archive) > 0);
  assert.equal(await restored.importFiles(archive), 0);
  assert.ok((await restored.load()).notifications.some(row => row.id === deletion.id));
  for (const file of archive.filter(file => file.path !== 'transactions.index')) {
    assert.equal(await readFile(join(restoredRoot, file.path), 'utf8'), file.contents);
  }
  const ids = await readFile(join(restoredRoot, 'transactions.index'), 'utf8');
  const originalIndex = archive.find(file => file.path === 'transactions.index').contents;
  for (const uuid of originalIndex.trim().split('\n')) assert.ok(ids.split('\n').includes(uuid));

  await restarted.restoreNotification(deletion.id);
  assert.equal((await get('measures/' + profileId + '/2026-09-28T09-00-00.000Z.json')).uuid, measurementId);

  const path = 'profiles/' + profileId + '.json';
  await put(path, { ...await get(path), heightCm: 171 });
  await assert.rejects(restarted.saveProfile({ ...profile, editUuid: profileId, name: 'Louise', heightCm: 172 }));
  assert.equal((await restarted.reload()).profiles[0].heightCm, 171);
  assert.equal((await get('session.json')).profiles[0].name, 'Obsolete');
});
