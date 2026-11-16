'use strict';

const { isMacAddress, echoesMac } = require('./advertisement-address.js');

function decodeAdvertisement({ kind, code, data, localName, address }) {
  if (kind !== 'Manufacturer' || localName?.trim().toLowerCase() !== 'da' || data.length !== 9) return null;

  // In this format, the first two bytes encode the status and weight, not a company.
  const header = Number(code);
  const state = header & 0xff;
  if (state !== 0xd0 && state !== 0xe0) return null;
  if (isMacAddress(address) && !echoesMac(data, 3, address) && !echoesMac(data, 3, address, true)) return null;

  const weight = ((header & 0xff00) | data[0]) / 100;
  if (weight < 0.5 || weight > 300) return null;
  // The unit for the remaining electrical reading is undocumented.
  return { weight, unit: 'kg', impedanceOhms: null, stable: state === 0xe0, removed: false,
    scaleTime: null, model: 'Scale Up' };
}

module.exports = { decodeAdvertisement };
