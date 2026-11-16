'use strict';

const { nameKey } = require('./profile-fields.cjs');
const companies = require('./bluetooth-companies.json');
const services = require('./bluetooth-services.json');
const { ADDRESS, canonicalAddress } = require('./scale.cjs');
const { fromBase64 } = require('./bytes.cjs');
const { macManufacturer } = require('./mac-manufacturer.cjs');

function normalizeName(value) {
  const name = value.trim().normalize('NFC');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name)) {
    throw Error('Nom d’appareil invalide. Utilise des lettres, chiffres, espaces, tirets ou underscores.');
  }
  return name;
}

const deviceFileKey = name => nameKey(name).replace(/ +/g, '-');

function parseDeviceMetadata(line) {
  const match = new RegExp(`^META ${ADDRESS} ([A-Za-z0-9+/=]*) ((?:[0-9A-F]{4}(?:,[0-9A-F]{4})*)?)$`, 'i').exec(line);
  if (!match) return null;
  const localName = fromBase64(match[2]).trim();
  const companyIds = match[3] ? [...new Set(match[3].split(',').map(id => '0x' + id.toUpperCase()))].sort() : [];
  return {
    address: canonicalAddress(match[1]),
    ...(localName && { localName }),
    ...(companyIds.length && { companyIds }),
  };
}

function mergeDeviceMetadata(record, metadata, { resolveMac = true } = {}) {
  const bluetooth = { ...record.bluetooth };
  if (metadata.localName) bluetooth.localName = metadata.localName;
  if (metadata.companyIds?.length) {
    bluetooth.companyIds = metadata.companyIds;
    bluetooth.manufacturers = metadata.companyIds.map(id => companies[id] ?? null);
  }
  if (bluetooth.manufacturers?.some(Boolean)) {
    delete bluetooth.macManufacturer;
  } else if (resolveMac) {
    const manufacturer = macManufacturer(bluetooth.address ?? metadata.address);
    if (manufacturer) bluetooth.macManufacturer = manufacturer;
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
  return bluetooth;
}

function buildDevice(name, event, metadata = {}) {
  const serviceUuid = event.serviceUuid ?? '0x181B';
  const record = {
    name: normalizeName(name),
    registeredAt: event.receivedAt,
    createdAt: event.receivedAt,
    bluetooth: {
      address: event.address,
      serviceUuid,
      service: services[serviceUuid] ?? null,
      localName: event.localName ?? null,
      advertisementType: event.advertisementType ?? null,
    },
  };
  record.bluetooth = mergeDeviceMetadata(record, metadata);
  return record;
}


module.exports = { normalizeName, deviceFileKey, parseDeviceMetadata, mergeDeviceMetadata, buildDevice };
