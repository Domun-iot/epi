'use strict';

const { ADDRESS, canonicalAddress, createReceiver } = require('../../shared/scales/adapter.js');
const { fromBase64 } = require('../../shared/bytes.cjs');
const { mergeDeviceMetadata, parseDeviceMetadata } = require('../../shared/device-fields.cjs');
const { globalMac } = require('../../shared/mac-manufacturer.cjs');
const companies = require('../../shared/bluetooth-companies.json');
const services = require('../../shared/bluetooth-services.json');

const payloadPattern = new RegExp(
  String.raw`^PAYLOAD ${ADDRESS} (-?\d+|-) (Service|Manufacturer|Announcement) ([\da-f-]+) (\d+) ([\da-f]*) ([A-Za-z0-9+/=]*)$`, 'i');

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
    if (measurement) {
      const { address, hex, localName, serviceUuid, rssi } = measurement;
      const source = mergeDeviceMetadata({ bluetooth: { address, localName } }, metadataByAddress.get(address) ?? {});
      const service = services[serviceUuid];
      return { ...source, ...measurement, localName: source.localName, rssi, hex,
        code: serviceUuid, codeStatus: service ? 'known' : 'unknown',
        prefixStatus: prefixStatus(source),
        label: service ? `${service} (${serviceUuid})` : serviceUuid, bytes: hex.length / 2 };
    }

    const payload = payloadPattern.exec(line);
    if (!payload) return null;
    const [, identity, signal, kind, id, length, hex, name] = payload;
    const address = canonicalAddress(identity);
    const localName = fromBase64(name) || undefined;
    const code = id.length === 4 ? '0x' + id.toUpperCase() : id;
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
    return { ...source, address, rssi: signal === '-' ? null : Number(signal), hex,
      code, codeStatus: nameForCode ? 'known' : inferred ? undefined : 'unknown',
      prefixStatus: macStatus,
      label: kind === 'Announcement' ? `Service annoncé · ${label}` : label, bytes: Number(length) };
  };
}

module.exports = { createWatchDecoder };
