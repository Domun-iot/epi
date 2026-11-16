'use strict';

const { uint16be } = require('../bytes.cjs');
const { isMacAddress, echoesMac } = require('./advertisement-address.js');

function decodeAdvertisement({ kind, code, data, localName, address }) {
  if (kind !== 'Manufacturer' || localName?.toUpperCase() !== 'PICOOC-L' || data.length !== 14) return null;

  // The system API splits the first two bytes of the embedded MAC out as the company ID.
  const company = Number(code);
  const embedded = Uint8Array.of(company & 0xff, company >> 8, ...data.subarray(0, 4));
  if (isMacAddress(address) && !echoesMac(embedded, 0, address)) return null;
  const checksum = data.reduce((sum, octet) => sum + octet, embedded[0] + embedded[1]);
  if ((checksum & 0xff) !== 0xff) return null;

  const weight = uint16be(data, 6) / 20;
  if (weight < 0.5 || weight > 300) return null;
  const impedance = uint16be(data, 8);
  return { weight, unit: 'kg', impedanceOhms: impedance > 0 && impedance < 0xffff ? impedance / 10 : null,
    stable: data[4] === 0x39, removed: false, scaleTime: null, brand: 'PICOOC', model: 'Mini Lite' };
}

module.exports = { decodeAdvertisement };
