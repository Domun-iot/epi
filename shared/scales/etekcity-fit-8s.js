'use strict';

const { uint16be, uint16le } = require('../bytes.cjs');
const { isMacAddress, echoesMac } = require('./advertisement-address.js');

function decodeAdvertisement({ kind, code, data, address }) {
  if (kind !== 'Manufacturer' || code !== '0x06D0' || data.length !== 20
    || data[0] !== 1) return null;
  // Two captured revisions carry these identifiers.
  const modelCode = uint16be(data, 7);
  if (modelCode !== 0xc0a8 && modelCode !== 0xc0a9) return null;
  if (isMacAddress(address) && !echoesMac(data, 1, address, true)) return null;

  const weight = (uint16le(data, 10) + (data[12] << 16)) / 1000;
  if (weight === 0 || weight > 300) return null;
  const impedance = uint16le(data, 13);
  return { weight, unit: 'kg', impedanceOhms: impedance > 0 && impedance < 0xffff ? impedance : null,
    stable: data[15] === 1, removed: false, scaleTime: null, brand: 'Etekcity', model: 'Fit 8S' };
}

module.exports = { decodeAdvertisement };
