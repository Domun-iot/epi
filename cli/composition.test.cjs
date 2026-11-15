'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { calculateComposition, formatComposition } = require('./composition.cjs');
const { prepareProfile } = require('./profiles.cjs');

const profile = { sex: 'H', age: 40, heightCm: 180 };
const reading = { weight: 80, unit: 'kg', impedanceOhms: 500,
  receivedAt: '2026-11-14T12:00:00Z', address: 'AA:BB:CC:DD:EE:FF' };
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.000001, actual);

test('compares reference equations, using kg and cm and the declared sex coding', () => {
  const { methods } = calculateComposition(reading, profile);
  closeTo(methods['Sun*'].leanKg, 62.24);
  closeTo(methods['Sun*'].waterL, 44.76);
  closeTo(methods['Jan*'].skeletalMuscleKg, 32.0718);
  closeTo(methods.MSJ.restingEnergy, 1732.4);
  closeTo(methods.Mi.fatPercent, 23.9926);
  const female = calculateComposition(reading, { ...profile, sex: 'F' }).methods;
  closeTo(female['Sun*'].leanKg, 58.782);
  closeTo(female['Sun*'].waterL, 41.71);
  closeTo(female.MSJ.restingEnergy, 1566.4);
  closeTo(female.CUN.fatPercent, 35.07964959609815);
  assert.deepEqual(methods['D60*'], {});
  closeTo(calculateComposition(reading, { ...profile, age: 65 }).methods['D60*'].leanKg, 50.4808);
  const pounds = calculateComposition({ ...reading, unit: 'lb', weight: 80 / 0.45359237 }, profile);
  closeTo(pounds.methods['Sun*'].leanKg, 62.24);
});

test('renders one row per metric and keeps anthropometric estimates without impedance', () => {
  const event = { ...reading, impedanceOhms: null };
  const { methods } = calculateComposition(event, profile);
  assert.deepEqual(methods['Sun*'], {});
  assert.equal(methods.Mi.fatPercent, undefined);
  assert.ok(methods.Deu.fatPercent > 0);
  assert.ok(methods.Mi.restingEnergy > 0);
  const table = formatComposition({ ...event, weight: 80.85 }, profile);
  assert.match(table, /80,9 kg/);
  assert.match(table, /Sun\* = Sun et al/);
  assert.match(table, /^Donnée .*\| .*Mi .*\| .*Sun\*/m);
  assert.match(table, /^Masse grasse \(%\).*—/m);
});

test('creates a named profile, reloads it and applies only supplied overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaomi-profile-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, input: { isTTY: false }, output: { write() {} } };
  await assert.rejects(prepareProfile({ utilisateur: 'Camille', age: '40' }, options),
    /Aucun profil enregistré.*--sexe, --taille/);
  await assert.rejects(prepareProfile({ utilisateur: '../Camille' }, options), /nom d’utilisateur/);
  const initial = await prepareProfile({ utilisateur: 'Camille', sexe: 'H', age: '40', taille: '180' }, options);
  assert.match(initial.uuid, /^[\da-f-]{36}$/);
  assert.deepEqual(initial, { ...profile, user: 'Camille', uuid: initial.uuid });
  const file = join(directory, initial.uuid + '.json');
  const created = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
  assert.equal(created.updatedAt, undefined);
  assert.deepEqual(await prepareProfile({ utilisateur: 'Camille' }, options), initial);
  await assert.rejects(prepareProfile({ utilisateur: 'Camille', age: '-1' }, options), /--age/);
  await prepareProfile({ utilisateur: 'Camille', taille: '181,5' }, options);
  const { updatedAt, ...stored } = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
  assert.deepEqual(stored, { ...profile, heightCm: 181.5, name: 'Camille', uuid: initial.uuid, createdAt: created.createdAt });
  assert.equal(await prepareProfile({}, options), null);
});

test('asks for missing fields on a new profile, then saves it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaomi-prompt-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  input.isTTY = true;
  let message = '';
  const output = { write(chunk) {
    message += chunk;
    if (chunk.startsWith('Sexe utilisé')) setImmediate(() => input.write('F\n'));
    if (chunk.startsWith('Taille en centimètres')) setImmediate(() => input.write('171,5\n'));
  } };
  const result = await prepareProfile({ utilisateur: 'Camille', age: '42' }, { directory, input, output });
  assert.match(message, /Aucun profil enregistré/);
  assert.doesNotMatch(message, /Âge en années/);
  assert.deepEqual(result, { user: 'Camille', age: 42, sex: 'F', heightCm: 171.5, uuid: result.uuid });
  assert.match(await readFile(join(directory, result.uuid + '.json'), 'utf8'), /171\.5/);
});
