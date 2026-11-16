'use strict';

const { echoesMac, isMacAddress } = require('./advertisement-address.js');

// IF_B7 / Grifema GA2001 advertisements, BLE Scale Sync #423.
function decodeAdvertisement({ kind, code, data, address, localName }) {
  if (kind !== 'Manufacturer' || code !== '0x0100' || data.length !== 17
      || data[0] !== 2 || data[1] !== 3 || data[2] !== 0x11) return null;
  const matchesSource = isMacAddress(address) ? echoesMac(data, 3, address) : /^IF_B7$/i.test(localName ?? '');
  if (!matchesSource) return null;

  const checksum = data.subarray(9, 16).reduce((sum, byte) => sum + byte, 0) & 0xff;
  if (checksum !== data[16]) return null;
  const status = data[14];
  if (status !== 0x01 && status !== 0x02 && status !== 0xa1 && status !== 0xa2) return null;
  const weight = ((data[10] << 8) | data[11]) / 100;
  if (weight === 0 || weight > 300) return null;
  return {
    weight, unit: 'kg', impedanceOhms: null, stable: (status & 0xf0) === 0xa0,
    removed: false, scaleTime: null, brand: 'Senssun', model: 'IF_B7',
  };
}

module.exports = { decodeAdvertisement };
