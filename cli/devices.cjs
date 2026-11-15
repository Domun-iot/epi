'use strict';

const { mkdirSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { listRecordFiles } = require('./record-files.cjs');
const { nameKey } = require('./profile-choice.cjs');
const { createInterface } = require('node:readline/promises');

const { normalizeName, deviceFileKey, parseDeviceMetadata, mergeDeviceMetadata, buildDevice } = require('../shared/device-fields.cjs');
const devicePaths = new WeakMap();
const services = require('../shared/bluetooth-services.json');

const { dataDirectory } = require('./storage.cjs');
const directory = join(dataDirectory, 'devices');

function listDevices(root = directory) {
  return listRecordFiles(root, /\.json$/u, (record, file) => {
    if (!record.name || !/^([A-F0-9]{2}:){5}[A-F0-9]{2}$|^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i.test(record.bluetooth?.address)) {
      throw Error('Fiche appareil invalide : ' + file);
    }
    record.bluetooth.service ??= services[record.bluetooth.serviceUuid] ?? null;
    return record;
  }).map(({ file, record }) => {
    devicePaths.set(record, join(root, file));
    return record;
  });
}

async function askDeviceName(event, devices, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) throw Error('Balance inconnue. Indique son nom avec --device NOM.');
  const questions = createInterface({ input, output });
  const abort = new AbortController();
  questions.once('close', () => abort.abort());
  questions.once('SIGINT', () => questions.close());
  try {
    for (;;) {
      const answer = await questions.question('Nom de l’appareil ' + event.address + ' : ', { signal: abort.signal });
      try {
        const name = normalizeName(answer);
        const key = deviceFileKey(name);
        if (!devices.some(device => deviceFileKey(device.name) === key)) return name;
        output.write('Ce nom est déjà utilisé.\n');
      } catch (error) {
        output.write(error.message + '\n');
      }
    }
  } catch (error) {
    if (abort.signal.aborted) throw Error('Saisie du nom de l’appareil annulée.');
    throw error;
  } finally {
    questions.close();
  }
}

function selectDevice(devices, name) {
  if (name === undefined) return {};
  name = normalizeName(name);
  const existing = devices.find(device => nameKey(device.name) === nameKey(name));
  return existing ? { existing } : { enroll: name };
}

function findDevice(event, devices) {
  return devices.find(device => device.bluetooth.address === event.address);
}

function updateDeviceMetadata(record, metadata) {
  const bluetooth = mergeDeviceMetadata(record, metadata);
  const changed = JSON.stringify(bluetooth) !== JSON.stringify(record.bluetooth);
  if (record.uuid && !changed) return;
  const updated = { ...record, bluetooth, uuid: record.uuid ?? randomUUID() };
  if (changed) updated.updatedAt = new Date().toISOString();
  const file = devicePaths.get(record);
  if (file) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' });
      renameSync(temp, file);
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  Object.assign(record, updated);
}

function registerDevice(name, event, root = directory, metadata = {}) {
  const record = { ...buildDevice(name, event, metadata), uuid: randomUUID() };
  mkdirSync(root, { recursive: true });
  const file = join(root, record.uuid + '.json');
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  devicePaths.set(record, file);
  return record;
}

module.exports = { listDevices, selectDevice, findDevice, askDeviceName, registerDevice, parseDeviceMetadata, updateDeviceMetadata };
