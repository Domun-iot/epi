'use strict';

const { saveChanges, serialize } = require('../shared/transactions.cjs');
const { stampRecord } = require('../shared/record-version.cjs');
const { randomUUID } = require('node:crypto');
const { basename, dirname, join } = require('node:path');
const { listRecordFiles } = require('./record-files.cjs');
const { nameKey } = require('./profile-choice.cjs');
const { createInterface } = require('node:readline/promises');

const { normalizeName, deviceFileKey, parseDeviceMetadata, mergeDeviceMetadata, buildDevice } = require('../shared/device-fields.cjs');
const devicePaths = new WeakMap();
const services = require('../shared/bluetooth-services.json');

const { dataDirectory, assertActiveDataset, withActiveDataset } = require('./storage.cjs');
const directory = join(dataDirectory, 'devices');

function listDevices(root = directory) {
  if (root === directory) assertActiveDataset();
  return listRecordFiles(root, /\.json$/u, (record, file) => {
    if (!record.name || !/^([A-F0-9]{2}:){5}[A-F0-9]{2}$|^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/i.test(record.bluetooth?.address)) {
      throw Error('Fiche appareil invalide : ' + file);
    }
    record.bluetooth.service ??= services[record.bluetooth.serviceUuid] ?? null;
    return record;
  }).map(({ file, record, contents }) => {
    devicePaths.set(record, { file: join(root, file), contents });
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
  const updated = stampRecord({ ...record, bluetooth, uuid: record.uuid ?? randomUUID() }, record);
  const source = devicePaths.get(record);
  if (source) {
    const { file, contents } = source;
    const root = dirname(file);
    const after = serialize(updated);
    const write = () => saveChanges(dirname(root), [{
      path: basename(root) + '/' + basename(file), before: contents, after,
    }]);
    if (root === directory) withActiveDataset(write); else write();
    source.contents = after;
  }
  Object.assign(record, updated);
}

function registerDevice(name, event, root = directory, metadata = {}) {
  const record = { ...buildDevice(name, event, metadata), uuid: randomUUID() };
  const nameOnDisk = record.uuid + '.json';
  const file = join(root, nameOnDisk);
  const contents = serialize(record);
  const write = () => saveChanges(dirname(root), [{ path: basename(root) + '/' + nameOnDisk, after: contents }]);
  if (root === directory) withActiveDataset(write); else write();
  devicePaths.set(record, { file, contents });
  return record;
}

module.exports = { listDevices: (root = directory) => root === directory
  ? withActiveDataset(() => listDevices(root)) : listDevices(root),
  selectDevice, findDevice, askDeviceName, registerDevice, parseDeviceMetadata, updateDeviceMetadata };
