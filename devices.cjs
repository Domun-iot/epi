'use strict';

const { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { nameKey } = require('./profile-choice.cjs');
const { createInterface } = require('node:readline/promises');

const companies = require('./bluetooth-companies.json');
const devicePaths = new WeakMap();
const services = require('./bluetooth-services.json');

const directory = join(__dirname, 'data', 'devices');

function listDevices(root = directory) {
  let files;
  try { files = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(file => file.isFile() && file.name.endsWith('.json')).map(file => {
    const record = JSON.parse(readFileSync(join(root, file.name), 'utf8'));
    if (!record.name || !/^([A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(record.bluetooth?.address)) {
      throw Error('Fiche appareil invalide : ' + file.name);
    }
    record.bluetooth.service ??= services[record.bluetooth.serviceUuid] ?? null;
    devicePaths.set(record, join(root, file.name));
    return record;
  });
}

function normalizeName(value) {
  const name = value.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name)) {
    throw Error('Nom d’appareil invalide. Utilise des lettres, chiffres, espaces, tirets ou underscores.');
  }
  return name;
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

const deviceFileKey = name => nameKey(name).replace(/ +/g, '-');

function parseDeviceMetadata(line) {
  const match = /^META ([0-9A-F]{12}) ([A-Za-z0-9+/=]*) ((?:[0-9A-F]{4}(?:,[0-9A-F]{4})*)?)$/.exec(line);
  if (!match) return null;
  const localName = Buffer.from(match[2], 'base64').toString('utf8').trim();
  const companyIds = match[3] ? [...new Set(match[3].split(',').map(id => '0x' + id))].sort() : [];
  return {
    address: match[1].match(/../g).join(':'),
    ...(localName && { localName }),
    ...(companyIds.length && { companyIds }),
  };
}

function updateDeviceMetadata(record, metadata) {
  const bluetooth = { ...record.bluetooth };
  if (metadata.localName) bluetooth.localName = metadata.localName;
  if (metadata.companyIds?.length) {
    bluetooth.companyIds = metadata.companyIds;
    bluetooth.manufacturers = metadata.companyIds.map(id => companies[id] ?? null);
  }
  // The advertised name identifies a model only in combination with the company ID.
  if (bluetooth.localName === 'MIBFS' && bluetooth.companyIds?.includes('0x0157')) {
    bluetooth.brand = 'Xiaomi';
    bluetooth.model = 'XMTZC05HM';
    bluetooth.modelSource = 'advertisement';
  } else if (bluetooth.modelSource === 'advertisement') {
    delete bluetooth.brand;
    delete bluetooth.model;
    delete bluetooth.modelSource;
  }
  if (JSON.stringify(bluetooth) === JSON.stringify(record.bluetooth)) return;
  const file = devicePaths.get(record);
  if (file) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify({ ...record, bluetooth }, null, 2) + '\n', { flag: 'wx' });
      renameSync(temp, file);
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  record.bluetooth = bluetooth;
}

function registerDevice(name, event, root = directory, metadata = {}) {
  const serviceUuid = event.serviceUuid ?? '0x181B';
  const record = {
    name: normalizeName(name),
    registeredAt: event.receivedAt,
    bluetooth: {
      address: event.address,
      serviceUuid,
      service: services[serviceUuid] ?? null,
      localName: event.localName ?? null,
      advertisementType: event.advertisementType ?? null,
    },
  };
  updateDeviceMetadata(record, metadata);
  mkdirSync(root, { recursive: true });
  const file = join(root, deviceFileKey(record.name) + '.json');
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  devicePaths.set(record, file);
  return record;
}

module.exports = { listDevices, selectDevice, findDevice, askDeviceName, registerDevice, parseDeviceMetadata, updateDeviceMetadata };
