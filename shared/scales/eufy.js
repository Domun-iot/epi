'use strict';

const { uint16le } = require('../bytes.cjs');
const { isMacAddress } = require('./advertisement-address.js');

// The same advertisement layout may cover several models. These aliases come
// from eufylife-ble-client and the matching protocol captures.
const aliases = new Map([
  ['C20', 'T9130'], ['C1', 'T9146'], ['P1', 'T9147'],
  ['P2', 'T9148'], ['P2 PRO', 'T9149'], ['P3', 'T9150'],
]);
const compositionStates = new Set([0x01, 0x05, 0x15, 0x25, 0x45, 0x65, 0x85, 0xa5, 0xc5, 0xe5]);

function advertisedModel(name) {
  const match = /^eufy\s+(T9130|T9146|T9147|T9148|T9149|T9150|C20|C1|P1|P2 Pro|P2|P3)\b/i.exec(name ?? '');
  if (!match) return undefined;
  const model = match[1].toUpperCase();
  return aliases.get(model) ?? model;
}

function reading(weight, stable, model, details = {}) {
  if (!(weight > 0) || weight > 250) return null;
  return {
    weight, unit: 'kg', impedanceOhms: null, stable, removed: false, scaleTime: null,
    brand: 'Eufy', ...(model && { model }), ...details,
  };
}

function heartRateField(value) {
  return value >= 25 && value <= 240 ? { deviceMetrics: { heartRateBpm: value } } : {};
}

function decodeCompositionAdvertisement(data, model) {
  const status = data[10];
  if (data.length < 18 || data[5] !== 0 || !compositionStates.has(status)) return null;
  const stable = status !== 1;
  if (!model) return reading(uint16le(data, 12) / 100, stable);
  const c20 = model === 'T9130';
  const reportsImpedance = c20 ? status & 0x40 : status & 0x20;
  const rawImpedance = reportsImpedance && data.length >= 19 ? uint16le(data, 17) / 10 : 0;
  const impedanceOhms = rawImpedance >= 100 && rawImpedance <= 1500 ? rawImpedance : null;
  const reportsPulse = c20 ? status & 0x80 : data[11] & 0x80;
  const pulse = reportsPulse ? heartRateField(data[15]) : {};
  const complete = status === 0xe5 || Boolean(impedanceOhms && pulse.deviceMetrics);
  return reading(uint16le(data, 12) / 100, stable, model, {
    impedanceOhms, waitsForImpedance: !complete, ...pulse,
  });
}

function decodeAdvertisement({ kind, code, data, address, localName }) {
  if (kind !== 'Manufacturer') return null;
  const model = advertisedModel(localName);
  const c20OrP3 = model === 'T9130' || model === 'T9150';
  const addressPrefix = Number.parseInt(code.slice(2, 4), 16);
  // C20/P3 split the MAC across the high byte of the changing manufacturer
  // ID and the first five payload bytes. Test this before the P2 fallback.
  const sourceMatches = isMacAddress(address)
    && Number.parseInt(address.slice(0, 2), 16) === addressPrefix;
  const echoesSource = sourceMatches
    && address.slice(3).split(':').every((octet, index) => Number.parseInt(octet, 16) === data[index]);
  if (c20OrP3 || (!model && echoesSource && data.length >= 18 && data[5] === 0)) {
    return decodeCompositionAdvertisement(data, model);
  }

  if (model === 'T9146' || model === 'T9147') {
    if (data.length !== 18 || data[4] !== 0xcf || data[13] === 2) return null;
    const checksum = data.subarray(4, 14).reduce((value, byte) => value ^ byte, 0);
    if (checksum !== data[14]) return null;
    return reading(uint16le(data, 7) / 100, data[13] === 0, model);
  }

  if (model === 'T9148' || model === 'T9149' || (!model && code === '0xFF48')) {
    if (data.length !== 19 || data[6] !== 0xcf) return null;
    const pulse = model === 'T9149' && (data[8] & 0xc0) === 0xc0 ? data[7] : 0;
    return reading(uint16le(data, 9) / 100, data[15] === 0, model, heartRateField(pulse));
  }

  return null;
}

module.exports = { decodeAdvertisement };
