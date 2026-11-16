'use strict';

const { echoesMac, isMacAddress } = require('./advertisement-address.js');

const models = new Map([
  ['108', { brand: 'Silvergear', model: '108' }],
  ['AAA006', { brand: 'INSMART', model: 'AAA006' }],
  ['AAA002', { brand: 'Foryond', model: 'FG263LB' }],
  ['AAA007', { model: 'AAA007' }],
  ['AAA013', { model: 'AAA013' }],
  ['AAA07A', { brand: 'Posture', model: 'FG220LB' }],
  ['AAA041', { brand: 'beatXP', model: 'BXPBMI1004' }],
]);

// Icomon/Fitdays and AAAx frames use the same weight and checksum fields.
// BLE Scale Sync #297, beatxp-smart-scale and openScale AAAxHandler.
function decodeAdvertisement({ kind, code, data, address, localName }) {
  if (kind !== 'Manufacturer' || data.length < 12 || !/^0x[\dA-F]{4}$/.test(code)) return null;
  const identity = models.get(localName?.trim().toUpperCase());
  if (!identity && (code !== '0xA0AC' || data.length !== 12)) return null;
  const matchesSource = isMacAddress(address) ? echoesMac(data, 0, address, true) : Boolean(identity);
  if (!matchesSource) return null;

  const key = Number.parseInt(code.slice(2, 4), 16);
  const [flags, high, middle, low, type, trailer] = data.subarray(6, 12).map(byte => byte ^ key);
  if (type !== 0xad || ((flags + high + middle + low + type) & 0x1f) !== (trailer & 0x1f)) return null;
  const grams = ((high & 3) << 16) | (middle << 8) | low;
  if (grams === 0 || grams > 250_000) return null;
  return {
    weight: grams / 1000, unit: 'kg', impedanceOhms: null,
    stable: Boolean(flags & 0x80), removed: false, scaleTime: null, ...identity,
  };
}

module.exports = { decodeAdvertisement };
