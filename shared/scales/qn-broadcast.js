'use strict';

const { uint16le } = require('../bytes.cjs');

function decodeAdvertisement({ kind, code, data }) {
  if (kind !== 'Manufacturer' || code !== '0xFFFF' || data.length < 19
    || data[0] !== 0xaa || data[1] !== 0xbb) return null;

  const weight = uint16le(data, 17) / 100;
  if (weight < 0.5 || weight > 300) return null;

  const fitindex = data[19] === 0x51 && data[20] === 0x0e && data[21] === 0x03;
  const stable = Boolean(data[15] & (fitindex ? 0x21 : 0x20));
  return { weight, unit: 'kg', impedanceOhms: null, stable, removed: false, scaleTime: null,
    ...(fitindex && { brand: 'FITINDEX', model: 'FT-26R' }) };
}

module.exports = { decodeAdvertisement };
