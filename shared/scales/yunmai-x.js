'use strict';

const { uint16be } = require('../bytes.cjs');
const { isMacAddress, echoesMac } = require('./advertisement-address.js');

function decodeAdvertisement({ kind, code, data, address }) {
  if (kind !== 'Manufacturer' || data.length !== 14) return null;

  const signature = (uint16be(data, 4) << 8) | data[6];
  const model = signature === 0x0b7417 ? 'YMBS-M268' : signature === 0x065211 ? 'M1827CH' : null;
  if (!model) return null;

  const company = Number(code);
  const embedded = Uint8Array.of(company & 0xff, company >> 8, ...data.subarray(0, 4));
  if (isMacAddress(address) && !echoesMac(embedded, 0, address, true)) return null;

  const checksum = data.subarray(7, 13).reduce((xor, octet) => xor ^ octet, 0);
  if (checksum !== data[13]) return null;

  const state = data[8];
  const weight = uint16be(data, 9) / 100;
  if (state < 1 || state > 3 || weight === 0 || weight > 300) return null;
  const impedance = uint16be(data, 11);
  const stable = state === 3;
  return { weight, unit: 'kg', impedanceOhms: stable && impedance > 0 && impedance < 0xffff ? impedance : null,
    stable, removed: false, scaleTime: null, brand: 'Yunmai', model };
}

module.exports = { decodeAdvertisement };
