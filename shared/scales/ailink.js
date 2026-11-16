'use strict';

const { echoesMac, isMacAddress } = require('./advertisement-address.js');

// Broadcast TEA dialect documented against the EL1 scale in openScale AiLinkLib.
// The tested CID/VID/PID identity is 01/03/01, carried in the announcement.
const key = [0x41493001, 0x4c327903, 0x31783101, 0x306c6531];
const delta = 0x9e3779b9;

function decryptBlock(data) {
  const view = new DataView(data.buffer, data.byteOffset + 8, 8);
  let left = view.getUint32(0, true);
  let right = view.getUint32(4, true);
  let sum = 0xc6ef3720;

  for (let round = 0; round < 32; round++) {
    right = (right - (((left << 4) + key[2]) ^ (left + sum) ^ ((left >>> 5) + key[3]))) >>> 0;
    left = (left - (((right << 4) + key[0]) ^ (right + sum) ^ ((right >>> 5) + key[1]))) >>> 0;
    sum = (sum - delta) >>> 0;
  }

  return { left, right };
}

function decodeAdvertisement({ kind, code, data, localName, address }) {
  if (kind !== 'Manufacturer' || code !== '0x0301' || data.length !== 18 || data[0] !== 1) return null;
  const matchesSource = isMacAddress(address) ? echoesMac(data, 1, address, true) : /^el1$/i.test(localName ?? '');
  if (!matchesSource) return null;
  const checksum = data.subarray(8).reduce((sum, byte) => sum + byte, 0) & 0xff;
  if (checksum !== data[7]) return null;

  const { left, right } = decryptBlock(data);
  const status = (left >>> 8) & 0xff;
  const flags = (left >>> 16) & 0xff;
  if ((status > 4 && status !== 0xff) || (flags & 0x38) || (left & 0x80000000)) return null;
  const scale = 10 ** ((flags >>> 1) & 3);
  const weight = (((left >>> 24) << 8) | (right & 0xff)) / scale;
  if (weight < 1 || weight > 300) return null;

  const stable = status === 0xff;
  const impedance = (right & 0xff00) | ((right >>> 16) & 0xff);
  return { weight, unit: 'kg', impedanceOhms: stable && impedance > 0 && impedance !== 0xffff ? impedance : null,
    stable, removed: false, scaleTime: null, brand: 'AiLink', model: 'EL1' };
}

module.exports = { decodeAdvertisement };
