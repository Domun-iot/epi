'use strict';

const { createReceiver, parsePayload } = require('../../shared/scales/adapter.js');
const { mergeDeviceMetadata, parseDeviceMetadata } = require('../../shared/device-fields.cjs');
const { globalMac } = require('../../shared/mac-manufacturer.cjs');
const companies = require('../../shared/bluetooth-companies.json');
const services = require('../../shared/bluetooth-services.json');

function prefixStatus(source, companyPayload = false) {
  if (source.macManufacturer) return 'known';
  if ((companyPayload || source.companyIds?.length) && !source.manufacturers?.some(Boolean)
      && globalMac(source.address)) return 'unknown';
}

function createWatchDecoder() {
  const metadataByAddress = new Map();
  const receive = createReceiver({ raw: true, bluetoothFor: address => metadataByAddress.get(address) });
  return line => {
    const metadata = parseDeviceMetadata(line);
    if (metadata) {
      metadataByAddress.delete(metadata.address);
      if (metadataByAddress.size >= 256) metadataByAddress.delete(metadataByAddress.keys().next().value);
      metadataByAddress.set(metadata.address, metadata);
      return null;
    }

    const measurement = receive(line);
    const payload = parsePayload(line);
    if (!payload && measurement) {
      const { address, hex, localName, serviceUuid, rssi } = measurement;
      const source = mergeDeviceMetadata({ bluetooth: { address, localName } }, metadataByAddress.get(address) ?? {});
      const service = services[serviceUuid];
      return { ...source, ...measurement, localName: source.localName, rssi, hex,
        code: serviceUuid, codeStatus: service ? 'known' : 'unknown',
        prefixStatus: prefixStatus(source),
        label: service ? `${service} (${serviceUuid})` : serviceUuid, bytes: hex.length / 2 };
    }

    if (!payload) return null;
    const { address, rssi, kind, code, bytes, hex, localName } = payload;
    const manufacturer = kind === 'Manufacturer';
    const nameForCode = manufacturer ? companies[code] : services[code];
    const knownCompany = manufacturer && Boolean(nameForCode);
    const source = mergeDeviceMetadata({ bluetooth: { address, localName } }, metadataByAddress.get(address) ?? {},
      { resolveMac: !knownCompany });
    const inferred = manufacturer ? source.macManufacturer : undefined;
    const macStatus = knownCompany ? undefined : prefixStatus(source, manufacturer);
    const label = nameForCode ? `${nameForCode} (${code})`
      : inferred ? `${inferred} (${code})` : (manufacturer ? 'Fabricant ' : 'Service ') + code;
    if (manufacturer) delete source.macManufacturer;
    return { ...source, ...measurement, address, rssi, hex,
      code, codeStatus: nameForCode ? 'known' : inferred ? undefined : 'unknown',
      prefixStatus: macStatus,
      label: kind === 'Announcement' ? `Service annoncé · ${label}` : label, bytes };
  };
}

module.exports = { createWatchDecoder };
